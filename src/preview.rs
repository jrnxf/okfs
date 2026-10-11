//! What the preview pane shows for a text file: rendered Markdown, colored code,
//! a table, or JSON. Inputs are bounded before anything is read.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::paths;
use crate::render::{self, MAX_TEXT};

/// Rows sent for a table. The count of all rows is sent beside them.
const MAX_ROWS: usize = 2000;
const MAX_COLUMNS: usize = 200;
/// What a grid tile reads of a text file: this many bytes, and this many lines of them.
const HEAD_BYTES: u64 = 8192;
const HEAD_LINES: usize = 16;
/// Characters of a Markdown file shown under its title on a tile.
const HEAD_EXCERPT: usize = 260;
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
    /// The cover of a Markdown file on a grid tile.
    Doc {
        title: String,
        text: String,
    },
    /// Nothing to show: the file is `binary`, or too `large`.
    None {
        reason: &'static str,
    },
}

/// Builds the preview of the file at `abs`, known to the browser as `rel`.
pub fn of(abs: &Path, rel: &str, size: u64) -> std::io::Result<Preview> {
    if size > MAX_TEXT {
        return Ok(Preview::None { reason: "large" });
    }
    let bytes = fs::read(abs)?;
    if bytes.len() as u64 > MAX_TEXT {
        return Ok(Preview::None { reason: "large" });
    }
    if bytes[..bytes.len().min(SNIFF)].contains(&0) {
        return Ok(Preview::None { reason: "binary" });
    }
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let name = paths::file_name(rel);
    let lines = text.lines().count();

    Ok(match paths::extension(name).as_str() {
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
            let code = render::code(text, name);
            Preview::Code {
                html: code.html,
                lines: code.lines,
                highlighted: code.highlighted,
            }
        }
    })
}

/// The start of a text file, for a grid tile. Reads a few kilobytes whatever the file's size.
pub fn head(abs: &Path, rel: &str) -> std::io::Result<Preview> {
    let mut bytes = Vec::new();
    fs::File::open(abs)?.take(HEAD_BYTES).read_to_end(&mut bytes)?;
    if bytes.contains(&0) {
        return Ok(Preview::None { reason: "binary" });
    }
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let name = paths::file_name(rel);
    if matches!(paths::extension(name).as_str(), "md" | "markdown") {
        let title = text.lines().find_map(|line| line.strip_prefix("# ")).unwrap_or(name);
        let body: String = text
            .lines()
            .filter(|line| !line.starts_with('#'))
            .flat_map(|line| line.chars().chain([' ']))
            .filter(|c| !"`*_>|#-".contains(*c))
            .take(HEAD_EXCERPT)
            .collect();
        return Ok(Preview::Doc {
            title: title.trim().to_owned(),
            text: body.split_whitespace().collect::<Vec<_>>().join(" "),
        });
    }
    let start: Vec<&str> = text.lines().take(HEAD_LINES).collect();
    let code = render::code(&start.join("\n"), name);
    Ok(Preview::Code {
        html: code.html,
        lines: code.lines,
        highlighted: code.highlighted,
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
