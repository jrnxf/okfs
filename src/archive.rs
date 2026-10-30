//! Zip files, both ways: listing what is in one, and sending a folder as one.

use std::fs::File;
use std::io::{self, BufReader, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use serde::Serialize;
use tokio::sync::mpsc::Sender;
use zip::write::FullFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

use crate::index::Index;
use crate::paths::{self, Root};

/// Entries sent for one archive. The count of all entries is sent beside them.
const MAX_ENTRIES: usize = 5000;
/// Bytes gathered before a piece of the zip is sent on.
const CHUNK: usize = 64 * 1024;
/// Sizes from here up need the 64-bit zip format.
const ZIP64_FROM: u64 = u32::MAX as u64;
/// The extra field that holds a modified time in seconds since 1970, in UTC.
const UNIX_TIME_FIELD: u16 = 0x5455;
/// Formats that are already compressed: stored as they are, which is much faster.
const PACKED: [&str; 24] = [
    "jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "mp4", "mov", "mkv", "webm", "mp3", "m4a", "flac", "ogg",
    "opus", "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar",
];

#[derive(Debug, Serialize)]
pub struct Entry {
    pub name: String,
    pub size: u64,
    pub dir: bool,
}

#[derive(Debug, Serialize)]
pub struct Listing {
    pub entries: Vec<Entry>,
    pub total: usize,
}

/// Lists a zip from its central directory. No entry is unpacked.
pub fn list(abs: &Path) -> io::Result<Listing> {
    let mut archive = ZipArchive::new(BufReader::new(File::open(abs)?)).map_err(io::Error::other)?;
    let total = archive.len();
    let mut entries = Vec::with_capacity(total.min(MAX_ENTRIES));
    for at in 0..total.min(MAX_ENTRIES) {
        let entry = archive.by_index_raw(at).map_err(io::Error::other)?;
        entries.push(Entry {
            name: entry.name().map_err(io::Error::other)?.into_owned(),
            size: entry.size(),
            dir: entry.is_dir(),
        });
    }
    Ok(Listing { entries, total })
}

/// Hands the zip to the response body in pieces. Stops the walk when the reader goes away.
struct Pipe {
    out: Sender<io::Result<Bytes>>,
    held: Vec<u8>,
}

impl Write for Pipe {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.held.extend_from_slice(bytes);
        if self.held.len() >= CHUNK {
            self.flush()?;
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.held.is_empty() {
            return Ok(());
        }
        let piece = Bytes::from(std::mem::take(&mut self.held));
        self.out
            .blocking_send(Ok(piece))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "the download was cancelled"))
    }
}

/// Writes the folder at `abs` as a zip into `out`, one file at a time. Runs on a blocking thread.
/// Links to folders are left out, so the walk always ends. `rel` is where `abs` is in the served folder.
/// What a listing hides is left out, as it is there, unless `all`: see `Index::hides`.
pub fn stream(root: &Root, index: &Index, rel: &str, abs: &Path, all: bool, out: Sender<io::Result<Bytes>>) {
    let report = out.clone();
    let pipe = Pipe {
        out,
        held: Vec::with_capacity(CHUNK),
    };
    if let Err(error) = write(root, index, rel, abs, all, pipe)
        && error.kind() != io::ErrorKind::BrokenPipe
    {
        let _ = report.blocking_send(Err(error));
    }
}

/// Options that date an entry when `modified` was: in local time, which is all the zip format itself
/// holds, and to the second in UTC in an extra field that unzip tools prefer when it is there. An
/// entry with no time, or one the format cannot hold, keeps the format's first day, 1980-01-01.
fn dated(modified: Option<SystemTime>) -> FullFileOptions<'static, 'static> {
    let mut options = FullFileOptions::default();
    let Some(modified) = modified else { return options };
    if let Some(local) = jiff::Timestamp::try_from(modified)
        .ok()
        .map(|at| at.to_zoned(jiff::tz::TimeZone::system()).datetime())
        .and_then(|local| DateTime::try_from(local).ok())
    {
        options = options.last_modified_time(local);
    }
    let seconds = modified.duration_since(UNIX_EPOCH).ok().map(|since| since.as_secs());
    if let Some(seconds) = seconds.and_then(|seconds| u32::try_from(seconds).ok()) {
        // Flags (bit 0: a modified time follows), then the time.
        let mut field = vec![1];
        field.extend_from_slice(&seconds.to_le_bytes());
        // Small and well formed, so it is always taken.
        let _ = options.add_extra_field(UNIX_TIME_FIELD, field, false);
    }
    options
}

/// Each folder is an entry of its own, written before what it holds, so that it keeps its time when it
/// is unpacked too.
fn write(root: &Root, index: &Index, rel: &str, top: &Path, all: bool, pipe: Pipe) -> io::Result<()> {
    let mut zip = ZipWriter::new_stream(pipe);
    let mut todo = vec![(String::new(), index.rules_in(rel))];
    while let Some((dir, rules)) = todo.pop() {
        let at = top.join(&dir);
        let mut seen = root.scan(&at)?;
        let here = if dir.is_empty() { rel.to_owned() } else { paths::join(rel, &dir) };
        if !all {
            seen.retain(|e| !index.hides(&rules, &here, &e.name, e.dir));
        }
        seen.sort_by(|a, b| paths::natural_cmp(&a.name, &b.name));
        if !dir.is_empty() {
            let modified = std::fs::metadata(&at).and_then(|meta| meta.modified()).ok();
            zip.add_directory(dir.as_str(), dated(modified))
                .map_err(io::Error::other)?;
        }
        for entry in seen.iter().rev().filter(|e| e.dir && !e.link) {
            // Rules are read from the path a listing asks about, which a link in `rel` may make differ from `top`.
            let inside = index.enter(&root.dir().join(paths::join(&here, &entry.name)), &rules);
            todo.push((paths::join(&dir, &entry.name), inside));
        }
        for entry in seen.iter().filter(|e| !e.dir) {
            let name = paths::join(&dir, &entry.name);
            // A file that vanished or cannot be read is skipped: the rest is still wanted.
            let Ok(mut file) = File::open(top.join(&name)) else {
                continue;
            };
            let Ok(meta) = file.metadata() else { continue };
            let method = if PACKED.contains(&paths::extension(&entry.name).as_str()) {
                CompressionMethod::Stored
            } else {
                CompressionMethod::Deflated
            };
            let options = dated(meta.modified().ok())
                .compression_method(method)
                .large_file(meta.len() >= ZIP64_FROM)
                .unix_permissions(0o644);
            zip.start_file(name.as_str(), options).map_err(io::Error::other)?;
            io::copy(&mut file, &mut zip)?;
        }
    }
    zip.finish().map_err(io::Error::other)?.flush()
}
