//! The first page of a PDF as a picture, for the pane while the browser's viewer starts
//! and for the grid.
//!
//! A PDF is whatever its author made it, and the engine that draws it is young. So it
//! never draws inside the server: the server starts itself again as `okfs pdf-page`,
//! hands that process the open file and waits a set time for the picture. A PDF that
//! makes the engine crash, hang or eat memory ends that one process and nothing else,
//! and its preview is what it was before there were pictures.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::Semaphore;

use crate::thumb::{Made, Refused};

/// True when this build can draw PDFs: the `pdf` feature, on unless turned off.
pub const BUILT_IN: bool = cfg!(feature = "pdf");
/// The widths a page can be asked for. Any other request is rounded up to one of these.
pub const WIDTHS: [u32; 4] = [160, 320, 640, 1280];
/// PDFs larger than this get no picture: the whole file is held in memory to draw it.
pub const MAX_FILE: u64 = 64 * 1024 * 1024;
/// How long one page may take, from starting the process to its last byte.
pub const LIMIT: Duration = Duration::from_secs(5);
/// Pages drawn at once. Each is a process using a whole core.
const AT_ONCE: usize = 2;
/// A picture never grows past this many times its width in height.
#[cfg(feature = "pdf")]
const MAX_ASPECT: u32 = 4;
/// The most memory the drawing process may map, where the system can hold it to that.
#[cfg(all(feature = "pdf", unix))]
const MAX_MEMORY: u64 = 2 * 1024 * 1024 * 1024;
/// Files remembered as not drawable, so each is tried once and not on every pass.
const REMEMBERED: usize = 4096;

/// True for a name the page shows as a PDF.
pub fn is_pdf(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
}

/// Rounds a requested width up to one of the sizes that are made.
pub fn width(asked: u32) -> u32 {
    WIDTHS
        .into_iter()
        .find(|w| *w >= asked)
        .unwrap_or(WIDTHS[WIDTHS.len() - 1])
}

/// Starts the drawing process, a few at a time, and keeps to the limits.
pub struct Drawer {
    program: PathBuf,
    limit: Duration,
    turns: Semaphore,
    failed: Mutex<HashSet<String>>,
}

impl Drawer {
    /// `program` is okfs itself. Nothing when there is none to start, or this build cannot draw.
    pub fn new(program: Option<PathBuf>, limit: Duration) -> Option<Self> {
        Some(Self {
            program: program.filter(|_| BUILT_IN)?,
            limit,
            turns: Semaphore::new(AT_ONCE),
            failed: Mutex::new(HashSet::new()),
        })
    }

    /// The first page of the PDF at `abs`, `w` pixels wide. `version` names the file as it
    /// is now: a file that could not be drawn is not tried again until it changes.
    pub async fn first_page(&self, abs: &Path, size: u64, w: u32, version: &str) -> Result<Made, Refused> {
        if size > MAX_FILE {
            return Err(Refused::TooLarge);
        }
        if self.failed.lock().is_ok_and(|failed| failed.contains(version)) {
            return Err(Refused::Unreadable("this PDF could not be drawn".to_owned()));
        }
        let drawn = self.run(abs, w).await;
        if drawn.is_err()
            && let Ok(mut failed) = self.failed.lock()
        {
            if failed.len() >= REMEMBERED {
                failed.clear();
            }
            failed.insert(version.to_owned());
        }
        drawn
    }

    async fn run(&self, abs: &Path, w: u32) -> Result<Made, Refused> {
        let unreadable = |why: &str| Refused::Unreadable(why.to_owned());
        let _turn = self.turns.acquire().await.map_err(|_| unreadable("closed"))?;
        // The file is opened here and handed over: the process is given no path to read.
        let file = std::fs::File::open(abs).map_err(|e| Refused::Unreadable(e.to_string()))?;
        let child = tokio::process::Command::new(&self.program)
            .arg("pdf-page")
            .arg(w.to_string())
            .stdin(Stdio::from(file))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // Past the time limit, or when the request is given up, the wait is dropped: the process goes with it.
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| Refused::Unreadable(e.to_string()))?;
        let output = tokio::time::timeout(self.limit, child.wait_with_output())
            .await
            .map_err(|_| unreadable("drawing this PDF took too long"))?
            .map_err(|e| Refused::Unreadable(e.to_string()))?;
        if !output.status.success() || output.stdout.is_empty() {
            return Err(unreadable("this PDF could not be drawn"));
        }
        Ok(Made {
            bytes: output.stdout,
            mime: "image/jpeg",
        })
    }
}

/// `okfs pdf-page <width>`: reads a PDF from standard input and writes its first page to
/// standard output as a JPEG. Fails, with nothing written, on anything it cannot draw.
pub fn page(w: u32) -> Result<(), String> {
    confine();
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("the PDF is too large".to_owned());
    }
    let picture = draw(bytes, width(w))?;
    std::io::stdout().lock().write_all(&picture).map_err(|e| e.to_string())
}

/// Holds this process to a share of memory and of processor time, so it ends on its own
/// even when nothing is left to stop it.
fn confine() {
    #[cfg(all(feature = "pdf", unix))]
    {
        use rustix::process::{Resource, Rlimit, setrlimit};
        let cap = |most: u64| Rlimit {
            current: Some(most),
            maximum: Some(most),
        };
        // Not every system holds a process to these: the time limit of the server is what is relied on.
        let _ = setrlimit(Resource::As, cap(MAX_MEMORY));
        let _ = setrlimit(Resource::Cpu, cap(LIMIT.as_secs() * 2));
    }
}

/// Draws page 1 of the PDF in `bytes`, `w` pixels wide, on white.
#[cfg(feature = "pdf")]
pub fn draw(bytes: Vec<u8>, w: u32) -> Result<Vec<u8>, String> {
    use hayro::hayro_interpret::InterpreterSettings;
    use hayro::hayro_syntax::Pdf;
    use hayro::vello_cpu::color::palette::css::WHITE;
    use hayro::{PixmapSettings, RenderCache, RenderSettings, render};
    use image::codecs::jpeg::JpegEncoder;

    let pdf = Pdf::new(bytes).map_err(|_| "this is not a PDF that can be read".to_owned())?;
    let pages = pdf.pages();
    let page = pages.iter().next().ok_or("the PDF has no pages")?;
    let (wide, tall) = page.render_dimensions();
    if !(wide.is_finite() && tall.is_finite() && wide >= 1.0 && tall >= 1.0) {
        return Err("the first page has no size".to_owned());
    }
    // As wide as asked, unless that makes it taller than a picture may be.
    let w = w as f32;
    let scale = (w / wide).min(w * MAX_ASPECT as f32 / tall);
    let settings = PixmapSettings {
        x_scale: scale,
        y_scale: scale,
        bg_color: WHITE,
    };
    let pixmap = render(
        page,
        &RenderCache::new(),
        &InterpreterSettings::default(),
        &RenderSettings::default(),
        &settings,
    );
    let (width, height) = (u32::from(pixmap.width()), u32::from(pixmap.height()));
    if width == 0 || height == 0 {
        return Err("the first page has no size".to_owned());
    }
    // Drawn on white, so every pixel is opaque and its color is as it stands.
    let rgb: Vec<u8> = pixmap
        .data_as_u8_slice()
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|pixel| [pixel[0], pixel[1], pixel[2]])
        .collect();
    let mut picture = Vec::new();
    JpegEncoder::new_with_quality(&mut picture, 85)
        .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(picture)
}

#[cfg(not(feature = "pdf"))]
pub fn draw(_bytes: Vec<u8>, _w: u32) -> Result<Vec<u8>, String> {
    Err("this build of okfs cannot draw PDFs".to_owned())
}
