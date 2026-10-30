//! Small versions of images (camera RAW files too, by the JPEG inside them), whole images in a format any browser shows, and first pages of PDFs.
//! Inputs are bounded, and the cache lives outside the served folder. The first pages of PDFs are
//! kept in it too: see `pdf`.

use std::fs;
use std::io::{BufRead, BufReader, Cursor, Seek};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use image::codecs::jpeg::JpegEncoder;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};

use crate::camera;

/// The widths a thumbnail can be asked for. Any other request is rounded up to one of these.
pub const WIDTHS: [u32; 3] = [160, 320, 640];
/// Image files larger than this get no thumbnail.
pub const MAX_FILE: u64 = 64 * 1024 * 1024;
/// Images wider or taller than this get no thumbnail.
pub const MAX_SIDE: u32 = 16_384;
/// The most memory one decode may take.
const MAX_ALLOC: u64 = 384 * 1024 * 1024;
/// A whole picture made for a browser is shrunk to this on its long side.
pub const PICTURE_SIDE: u32 = 4096;
/// The width a whole picture is kept under in the cache: no thumbnail has it.
const WHOLE: u32 = 0;
/// A thumbnail never grows past this many times its width on the long side.
const MAX_ASPECT: u32 = 4;
/// Cached thumbnails not used for this long are removed at start, and after each rescan.
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

    /// What removes the pictures not used for a while, as starting does. A server that runs for
    /// long, walking its tree again on a timer, calls it after each walk.
    pub fn pruner(&self) -> impl Fn() + Send + Sync + 'static {
        let cache = self.cache.clone();
        move || {
            if let Some(dir) = &cache {
                prune(dir);
            }
        }
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

    /// The thumbnail of the image at `abs`, from the cache when it is there.
    pub fn get(&self, abs: &Path, w: u32, meta: &fs::Metadata) -> Result<Made, Refused> {
        if let Some(made) = self.cached(abs, w, meta) {
            return Ok(made);
        }
        let made = make(abs, w, meta.len())?;
        self.keep(abs, w, meta, &made);
        Ok(made)
    }

    /// The image at `abs` whole, as a PNG or a JPEG, from the cache when it is there. For a format a
    /// browser cannot show, such as TIFF.
    pub fn picture(&self, abs: &Path, meta: &fs::Metadata) -> Result<Made, Refused> {
        if let Some(made) = self.cached(abs, WHOLE, meta) {
            return Ok(made);
        }
        let made = picture(abs, meta.len())?;
        self.keep(abs, WHOLE, meta, &made);
        Ok(made)
    }

    /// The picture kept for `abs` as it is now, at this width.
    pub fn cached(&self, abs: &Path, w: u32, meta: &fs::Metadata) -> Option<Made> {
        let bytes = fs::read(self.slot(abs, w, meta)?).ok()?;
        Some(Made {
            mime: mime_of(&bytes),
            bytes,
        })
    }

    /// Keeps a picture made of `abs` as it is now, for the next time it is asked for.
    pub fn keep(&self, abs: &Path, w: u32, meta: &fs::Metadata, made: &Made) {
        if let Some(slot) = self.slot(abs, w, meta) {
            // Written beside its final name and moved, so a reader never sees half a file.
            let part = slot.with_extension(format!("{}.part", std::process::id()));
            if fs::write(&part, &made.bytes).is_ok() && fs::rename(&part, &slot).is_err() {
                let _ = fs::remove_file(&part);
            }
        }
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

/// Decodes, turns upright and shrinks one image to a thumbnail `w` wide on its short side.
pub fn make(abs: &Path, w: u32, size: u64) -> Result<Made, Refused> {
    let mut image = decode(abs, size)?;
    // Tiles crop to fill, so the short side is what has to reach the asked width.
    let (width, height) = (image.width().max(1), image.height().max(1));
    let short = width.min(height);
    if short > w {
        let scale = f64::from(w) / f64::from(short);
        let fit = |side: u32| ((f64::from(side) * scale).round() as u32).clamp(1, w * MAX_ASPECT);
        image = image.thumbnail(fit(width), fit(height));
    }
    encode(image)
}

/// Decodes and turns upright one image, shrunk only when its long side passes `PICTURE_SIDE`.
pub fn picture(abs: &Path, size: u64) -> Result<Made, Refused> {
    let image = decode(abs, size)?;
    let image = if image.width().max(image.height()) > PICTURE_SIDE {
        image.thumbnail(PICTURE_SIDE, PICTURE_SIDE)
    } else {
        image
    };
    encode(image)
}

fn unreadable(error: image::ImageError) -> Refused {
    match error {
        image::ImageError::Limits(_) => Refused::TooLarge,
        other => Refused::Unreadable(other.to_string()),
    }
}

/// Decodes one image within the limits, and turns it upright. A camera RAW file is read through the JPEG
/// inside it: see `camera`.
fn decode(abs: &Path, size: u64) -> Result<DynamicImage, Refused> {
    if size > MAX_FILE {
        return Err(Refused::TooLarge);
    }
    let file = fs::File::open(abs).map_err(|e| Refused::Unreadable(e.to_string()))?;
    if camera::is_camera(abs) {
        return decode_camera(file, size);
    }
    decode_from(BufReader::new(file), None)
}

/// The largest preview of a RAW file that decodes. A file with none is not a picture.
fn decode_camera(mut file: fs::File, size: u64) -> Result<DynamicImage, Refused> {
    let layout = camera::layout(&mut file, size).map_err(|e| Refused::Unreadable(e.to_string()))?;
    let mut refused = Refused::Unreadable("no preview inside this file".to_owned());
    for span in layout.spans {
        if span.len > MAX_FILE {
            refused = Refused::TooLarge;
            continue;
        }
        let Ok(bytes) = camera::read_span(&mut file, span) else { continue };
        match decode_from(Cursor::new(bytes), layout.orientation) {
            Ok(image) => return Ok(image),
            Err(error) => refused = error,
        }
    }
    Err(refused)
}

/// `fallback` turns a picture that says nothing of how it was held, as a RAW file's preview often does.
fn decode_from<R: BufRead + Seek>(reader: R, fallback: Option<Orientation>) -> Result<DynamicImage, Refused> {
    let mut reader = ImageReader::new(reader)
        .with_guessed_format()
        .map_err(|e| Refused::Unreadable(e.to_string()))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_ALLOC);
    reader.limits(limits);

    let mut decoder = reader.into_decoder().map_err(unreadable)?;
    let mut orientation = decoder.orientation().map_err(unreadable)?;
    if orientation == Orientation::NoTransforms {
        orientation = fallback.unwrap_or(orientation);
    }
    let mut image = DynamicImage::from_decoder(decoder).map_err(unreadable)?;
    image.apply_orientation(orientation);
    Ok(image)
}

/// A PNG when the image has see-through parts, else a JPEG.
fn encode(image: DynamicImage) -> Result<Made, Refused> {
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
