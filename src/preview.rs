//! What the preview pane shows for a text file: rendered Markdown, colored code,
//! a table, or JSON, or its source as it is written. No more of a file than `MAX_TEXT` is ever read.

use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde::Serialize;

use crate::paths;
use crate::render::{self, MAX_TEXT};

/// Rows sent for a table. The count of all rows is sent beside them.
const MAX_ROWS: usize = 2000;
const MAX_COLUMNS: usize = 200;
/// Bytes checked to tell text from binary.
const SNIFF: usize = 8192;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Preview {
    Markdown {
        html: String,
        lines: usize,
    },
    Code {
        html: String,
        lines: usize,
        highlighted: bool,
        /// Only the start of the file is in `html`.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        more: bool,
        /// The file is larger than a preview is ever made of: only its first `MAX_TEXT` bytes were read,
        /// and `lines` counts the lines in them.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        cut: bool,
    },
    Table {
        head: Vec<String>,
        rows: Vec<Vec<String>>,
        /// One flag per column: every value in it is a number.
        numeric: Vec<bool>,
        total: usize,
    },
    Json {
        text: String,
        lines: usize,
    },
    /// Nothing to show: the file is `binary`.
    None {
        reason: &'static str,
    },
}

/// How much of a file a preview is of, and in which of its two forms.
#[derive(Debug, Clone, Copy, Default)]
pub struct Form {
    /// Source code is cut to this many lines.
    pub first: Option<usize>,
    /// The text as it is written, as source code, whatever the file is: Markdown is not
    /// rendered, and a table and JSON are not read.
    pub source: bool,
}

/// Builds the preview of the file at `abs`, known to the browser as `rel`, in the form
/// asked for. `gone` turns true when the reader has left.
pub fn of(abs: &Path, rel: &str, size: u64, form: Form, gone: &AtomicBool) -> std::io::Result<Preview> {
    let mut bytes = Vec::with_capacity(size.min(MAX_TEXT + 1) as usize);
    fs::File::open(abs)?.take(MAX_TEXT + 1).read_to_end(&mut bytes)?;
    if bytes[..bytes.len().min(SNIFF)].contains(&0) {
        return Ok(Preview::None { reason: "binary" });
    }
    // A larger file is shown as the source of its start, cut after its last whole line.
    let cut = bytes.len() as u64 > MAX_TEXT;
    if cut {
        bytes.truncate(MAX_TEXT as usize);
        match bytes.iter().rposition(|byte| *byte == b'\n') {
            Some(end) => bytes.truncate(end + 1),
            // One line with no end: a character split by the cut is dropped.
            None => {
                if let Err(error) = std::str::from_utf8(&bytes)
                    && error.error_len().is_none()
                {
                    bytes.truncate(error.valid_up_to());
                }
            }
        }
    }
    let form = Form {
        source: form.source || cut,
        ..form
    };
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let name = paths::file_name(rel);
    let lines = text.lines().count();

    let extension = if form.source {
        String::new()
    } else {
        paths::extension(name)
    };
    Ok(match extension.as_str() {
        "md" | "markdown" => Preview::Markdown {
            html: render::markdown(text, paths::parent(rel)),
            lines,
        },
        "csv" => table(text, b','),
        "tsv" => table(text, b'\t'),
        "json" if serde_json::from_str::<serde::de::IgnoredAny>(text).is_ok() => Preview::Json {
            text: text.to_owned(),
            lines,
        },
        _ => {
            let code = render::code_start(text, name, form.first, gone);
            Preview::Code {
                html: code.html,
                lines: code.lines,
                highlighted: code.highlighted,
                more: code.more,
                cut,
            }
        }
    })
}

fn table(text: &str, delimiter: u8) -> Preview {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut records = reader
        .records()
        .map_while(Result::ok)
        .map(|record| record.iter().take(MAX_COLUMNS).map(str::to_owned).collect::<Vec<_>>());
    let head = records.next().unwrap_or_default();
    let mut rows = Vec::new();
    let mut total = 0;
    for row in records {
        total += 1;
        if rows.len() < MAX_ROWS {
            rows.push(row);
        }
    }
    let numeric = (0..head.len())
        .map(|column| {
            let mut values = rows
                .iter()
                .filter_map(|row| row.get(column))
                .filter(|value| !value.is_empty())
                .peekable();
            values.peek().is_some() && values.all(|value| value.trim().parse::<f64>().is_ok_and(f64::is_finite))
        })
        .collect();
    Preview::Table {
        head,
        rows,
        numeric,
        total,
    }
}
