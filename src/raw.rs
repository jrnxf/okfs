//! The file itself, with ranges and revalidation.

use std::io::SeekFrom;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::{Response, StatusCode};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::paths::{self, Resolved};

/// Sent with every type a browser may run script from. With it, a served page gets
/// an origin of its own and can never act as the app, in a frame or opened directly.
pub const SANDBOX: &str = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms";

const READ_BUFFER: usize = 64 * 1024;

/// The type sent for a file name, and whether a browser could run script from it.
pub fn content_type(name: &str) -> (String, bool) {
    let guess = mime_guess::from_path(name).first_or_octet_stream();
    let (top, sub) = (guess.type_().as_str(), guess.subtype().as_str());
    let active = matches!(sub, "html" | "xhtml+xml" | "svg+xml" | "xml") || guess.suffix().is_some_and(|s| s == "xml");
    // Source and notes open as text in the browser instead of downloading.
    let readable = matches!(
        paths::extension(name).as_str(),
        "toml" | "yaml" | "yml" | "sh" | "log" | "lock"
    );
    let plain = (top == "text" && !matches!(sub, "html" | "css" | "javascript" | "xml" | "csv" | "plain" | "vtt"))
        || (readable && !active);
    let mime = if plain {
        "text/plain".to_owned()
    } else {
        guess.essence_str().to_owned()
    };
    let text = mime.starts_with("text/") || matches!(mime.as_str(), "application/json" | "application/javascript");
    (if text { format!("{mime}; charset=utf-8") } else { mime }, active)
}

/// One byte range, both ends included.
#[derive(Debug, PartialEq)]
enum Range {
    /// No usable range was asked for: send everything.
    Whole,
    Part(u64, u64),
    /// The range starts past the end.
    Unsatisfiable,
}

fn parse_range(value: &str, len: u64) -> Range {
    let Some(spec) = value.trim().strip_prefix("bytes=") else {
        return Range::Whole;
    };
    // Several ranges in one request are answered with the whole file, which is allowed.
    let Some((first, last)) = spec.split_once('-').filter(|_| !spec.contains(',')) else {
        return Range::Whole;
    };
    let (first, last) = (first.trim(), last.trim());
    if first.is_empty() {
        return match last.parse::<u64>() {
            Ok(0) => Range::Unsatisfiable,
            Ok(_) if len == 0 => Range::Unsatisfiable,
            Ok(suffix) => Range::Part(len.saturating_sub(suffix), len - 1),
            Err(_) => Range::Whole,
        };
    }
    let Ok(first) = first.parse::<u64>() else {
        return Range::Whole;
    };
    if first >= len {
        return Range::Unsatisfiable;
    }
    match last.parse::<u64>() {
        Ok(last) if last < first => Range::Whole,
        Ok(last) => Range::Part(first, last.min(len - 1)),
        Err(_) if last.is_empty() => Range::Part(first, len - 1),
        Err(_) => Range::Whole,
    }
}

fn header_str(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name)?.to_str().ok()
}

fn etag_matches(list: &str, etag: &str) -> bool {
    list.split(',')
        .map(|tag| tag.trim().trim_start_matches("W/"))
        .any(|tag| tag == "*" || tag == etag)
}

/// Answers a request for a file that has already been resolved inside the served folder.
pub async fn serve(found: Resolved, request: &HeaderMap) -> std::io::Result<Response<Body>> {
    let len = found.meta.len();
    let modified = found.meta.modified().unwrap_or(UNIX_EPOCH);
    let stamp = modified.duration_since(UNIX_EPOCH).unwrap_or_default();
    let etag = format!("\"{:x}-{len:x}\"", stamp.as_nanos());
    // HTTP dates carry whole seconds.
    let modified = UNIX_EPOCH + std::time::Duration::from_secs(stamp.as_secs());
    let last_modified = httpdate::fmt_http_date(modified);
    let (mime, active) = content_type(paths::file_name(&found.rel));

    let mut response = Response::builder()
        .header(header::ETAG, &etag)
        .header(header::LAST_MODIFIED, &last_modified)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-cache");
    let since = |name| header_str(request, name).and_then(|date| httpdate::parse_http_date(date).ok());
    let unchanged = match header_str(request, header::IF_NONE_MATCH) {
        Some(tags) => etag_matches(tags, &etag),
        None => since(header::IF_MODIFIED_SINCE).is_some_and(|date: SystemTime| modified <= date),
    };
    if unchanged {
        return Ok(response
            .status(StatusCode::NOT_MODIFIED)
            .body(Body::empty())
            .expect("a valid response"));
    }

    response = response.header(header::CONTENT_TYPE, mime);
    if active {
        response = response.header(header::CONTENT_SECURITY_POLICY, SANDBOX);
    }

    // A range only counts while the file is still the one the reader has part of.
    let current = match header_str(request, header::IF_RANGE) {
        Some(validator) if validator.starts_with('"') || validator.starts_with("W/") => validator == etag,
        Some(date) => httpdate::parse_http_date(date).is_ok_and(|date| date == modified),
        None => true,
    };
    let range = match header_str(request, header::RANGE).filter(|_| current) {
        Some(value) => parse_range(value, len),
        None => Range::Whole,
    };
    let (status, first, count) = match range {
        Range::Whole => (StatusCode::OK, 0, len),
        Range::Part(first, last) => {
            response = response.header(header::CONTENT_RANGE, format!("bytes {first}-{last}/{len}"));
            (StatusCode::PARTIAL_CONTENT, first, last - first + 1)
        }
        Range::Unsatisfiable => {
            return Ok(response
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Body::empty())
                .expect("a valid response"));
        }
    };

    let mut file = tokio::fs::File::open(&found.abs).await?;
    if first > 0 {
        file.seek(SeekFrom::Start(first)).await?;
    }
    let body = Body::from_stream(ReaderStream::with_capacity(file.take(count), READ_BUFFER));
    Ok(response
        .status(status)
        .header(header::CONTENT_LENGTH, HeaderValue::from(count))
        .body(body)
        .expect("a valid response"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_follow_the_rules() {
        assert_eq!(parse_range("bytes=0-9", 100), Range::Part(0, 9));
        assert_eq!(parse_range("bytes=90-", 100), Range::Part(90, 99));
        assert_eq!(parse_range("bytes=-10", 100), Range::Part(90, 99));
        assert_eq!(parse_range("bytes=-500", 100), Range::Part(0, 99));
        assert_eq!(parse_range("bytes=50-5000", 100), Range::Part(50, 99));
        assert_eq!(parse_range("bytes=100-", 100), Range::Unsatisfiable);
        assert_eq!(parse_range("bytes=-0", 100), Range::Unsatisfiable);
        assert_eq!(parse_range("bytes=0-", 0), Range::Unsatisfiable);
        assert_eq!(parse_range("bytes=9-0", 100), Range::Whole);
        assert_eq!(parse_range("bytes=0-1,5-6", 100), Range::Whole);
        assert_eq!(parse_range("lines=0-1", 100), Range::Whole);
    }

    #[test]
    fn script_bearing_types_are_marked_active() {
        for name in ["a.html", "a.htm", "a.svg", "a.xhtml", "a.xml"] {
            assert!(content_type(name).1, "{name}");
        }
        for name in ["a.txt", "a.png", "a.pdf", "a.js", "a.rs", "a.json"] {
            assert!(!content_type(name).1, "{name}");
        }
        assert_eq!(content_type("main.rs").0, "text/plain; charset=utf-8");
        assert_eq!(content_type("a.toml").0, "text/plain; charset=utf-8");
        assert_eq!(content_type("a.bin").0, "application/octet-stream");
    }
}
