//! Zip files, both ways: listing what is in one, and sending a folder as one.

use std::fs::File;
use std::io::{self, BufReader, Write};
use std::path::Path;

use bytes::Bytes;
use serde::Serialize;
use tokio::sync::mpsc::Sender;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::paths::{self, Root};

/// Entries sent for one archive. The count of all entries is sent beside them.
const MAX_ENTRIES: usize = 5000;
/// Bytes gathered before a piece of the zip is sent on.
const CHUNK: usize = 64 * 1024;
/// Sizes from here up need the 64-bit zip format.
const ZIP64_FROM: u64 = u32::MAX as u64;
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
/// Links to folders are left out, so the walk always ends.
pub fn stream(root: &Root, abs: &Path, out: Sender<io::Result<Bytes>>) {
    let report = out.clone();
    let pipe = Pipe {
        out,
        held: Vec::with_capacity(CHUNK),
    };
    if let Err(error) = write(root, abs, pipe)
        && error.kind() != io::ErrorKind::BrokenPipe
    {
        let _ = report.blocking_send(Err(error));
    }
}

fn write(root: &Root, top: &Path, pipe: Pipe) -> io::Result<()> {
    let mut zip = ZipWriter::new_stream(pipe);
    let mut todo = vec![String::new()];
    while let Some(dir) = todo.pop() {
        let mut seen = root.scan(&top.join(&dir))?;
        seen.sort_by(|a, b| paths::natural_cmp(&a.name, &b.name));
        if seen.is_empty() && !dir.is_empty() {
            zip.add_directory(dir.as_str(), SimpleFileOptions::default())
                .map_err(io::Error::other)?;
        }
        for entry in seen.iter().rev().filter(|e| e.dir && !e.link) {
            todo.push(paths::join(&dir, &entry.name));
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
            let options = SimpleFileOptions::default()
                .compression_method(method)
                .large_file(meta.len() >= ZIP64_FROM)
                .unix_permissions(0o644);
            zip.start_file(name.as_str(), options).map_err(io::Error::other)?;
            io::copy(&mut file, &mut zip)?;
        }
    }
    zip.finish().map_err(io::Error::other)?.flush()
}
