//! Small versions of images for the grid view. Inputs are bounded, and the cache
//! lives outside the served folder.

use std::fs;
use std::io::{BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};

/// The widths a thumbnail can be asked for. Any other request is rounded up to one of these.
pub const WIDTHS: [u32; 3] = [160, 320, 640];
/// Image files larger than this get no thumbnail.
pub const MAX_FILE: u64 = 64 * 1024 * 1024;
/// Images wider or taller than this get no thumbnail.
pub const MAX_SIDE: u32 = 16_384;
/// The most memory one decode may take.
const MAX_ALLOC: u64 = 384 * 1024 * 1024;
/// A thumbnail never grows past this many times its width on the long side.
const MAX_ASPECT: u32 = 4;
/// Cached thumbnails not used for this long are removed at start.
const KEEP: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Debug)]
pub enum Refused {
    /// The file is too big, or its picture is.
    TooLarge,
    /// The file is not a picture this build can read.
    Unreadable(String),
}

pub struct Made {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

pub struct Thumbs {
    cache: Option<PathBuf>,
}

/// Rounds a requested width up to one of the sizes that are made.
pub fn width(asked: u32) -> u32 {
    WIDTHS
        .into_iter()
        .find(|w| *w >= asked)
        .unwrap_or(WIDTHS[WIDTHS.len() - 1])
}

fn mime_of(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else {
        "image/jpeg"
    }
}

impl Thumbs {
    /// `cache` is where thumbnails are kept between runs. It is not used when it is
    /// missing or sits inside the served folder: nothing is ever written there.
    pub fn new(cache: Option<PathBuf>, served: &Path) -> Self {
        let cache = cache
            .filter(|dir| !inside(dir, served))
            .filter(|dir| fs::create_dir_all(dir).is_ok());
        if let Some(dir) = cache.clone() {
            std::thread::spawn(move || prune(&dir));
        }
        Self { cache }
    }

    fn slot(&self, abs: &Path, w: u32, meta: &fs::Metadata) -> Option<PathBuf> {
        let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
        let key = format!("{}\0{w}\0{modified}\0{}", abs.display(), meta.len());
        // FNV-1a: stable across builds, which a cache key has to be.
        let hash = key.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        });
        Some(self.cache.as_ref()?.join(format!("{hash:016x}-{w}")))
    }

    /// The cached thumbnails of a file, or of every file in a folder, so they can be
    /// dropped once it is deleted. `meta` is the entry's own. Links are not followed.
    pub fn slots(&self, abs: &Path, meta: &fs::Metadata) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if self.cache.is_none() {
            return out;
        }
        let mut todo = vec![(abs.to_owned(), meta.clone())];
        while let Some((at, meta)) = todo.pop() {
            if meta.is_dir() {
                let Ok(entries) = fs::read_dir(&at) else { continue };
                todo.extend(
                    entries
                        .flatten()
                        .filter_map(|entry| Some((entry.path(), entry.metadata().ok()?))),
                );
            } else if meta.is_file() {
                let slots = WIDTHS.iter().filter_map(|w| self.slot(&at, *w, &meta));
                out.extend(slots.filter(|slot| slot.exists()));
            }
        }
        out
    }

    /// The thumbnail of the image at `abs`, from the cache when it is there.
    pub fn get(&self, abs: &Path, w: u32, meta: &fs::Metadata) -> Result<Made, Refused> {
        let slot = self.slot(abs, w, meta);
        if let Some(bytes) = slot.as_ref().and_then(|slot| fs::read(slot).ok()) {
            return Ok(Made {
                mime: mime_of(&bytes),
                bytes,
            });
        }
        let made = make(abs, w, meta.len())?;
        if let Some(slot) = slot {
            // Written beside its final name and moved, so a reader never sees half a file.
            let part = slot.with_extension(format!("{}.part", std::process::id()));
            if fs::write(&part, &made.bytes).is_ok() && fs::rename(&part, &slot).is_err() {
                let _ = fs::remove_file(&part);
            }
        }
        Ok(made)
    }
}

/// True when `dir`, which may not exist yet, is or would be inside `served`.
fn inside(dir: &Path, served: &Path) -> bool {
    let mut missing = Vec::new();
    let mut known = dir;
    loop {
        if let Ok(real) = known.canonicalize() {
            return missing
                .iter()
                .rev()
                .fold(real, |path, part| path.join(part))
                .starts_with(served);
        }
        match (known.parent(), known.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name);
                known = parent;
            }
            // Nothing of it can be placed: treat it as inside, so it is not used.
            _ => return true,
        }
    }
}

/// Decodes, turns upright and shrinks one image.
pub fn make(abs: &Path, w: u32, size: u64) -> Result<Made, Refused> {
    if size > MAX_FILE {
        return Err(Refused::TooLarge);
    }
    let unreadable = |error: image::ImageError| match error {
        image::ImageError::Limits(_) => Refused::TooLarge,
        other => Refused::Unreadable(other.to_string()),
    };
    let file = fs::File::open(abs).map_err(|e| Refused::Unreadable(e.to_string()))?;
    let mut reader = ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .map_err(|e| Refused::Unreadable(e.to_string()))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_ALLOC);
    reader.limits(limits);

    let mut decoder = reader.into_decoder().map_err(unreadable)?;
    let orientation = decoder.orientation().map_err(unreadable)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(unreadable)?;
    image.apply_orientation(orientation);

    // Tiles crop to fill, so the short side is what has to reach the asked width.
    let (width, height) = (image.width().max(1), image.height().max(1));
    let short = width.min(height);
    if short > w {
        let scale = f64::from(w) / f64::from(short);
        let fit = |side: u32| ((f64::from(side) * scale).round() as u32).clamp(1, w * MAX_ASPECT);
        image = image.thumbnail(fit(width), fit(height));
    }

    let mut bytes = Vec::new();
    let mime = if image.color().has_alpha() {
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .map_err(unreadable)?;
        "image/png"
    } else {
        let rgb = image.into_rgb8();
        JpegEncoder::new_with_quality(&mut bytes, 82)
            .encode_image(&rgb)
            .map_err(unreadable)?;
        "image/jpeg"
    };
    Ok(Made { bytes, mime })
}

fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.accessed().or_else(|_| meta.modified()))
            .ok()
            .and_then(|used| now.duration_since(used).ok())
            .is_some_and(|age| age > KEEP);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}
