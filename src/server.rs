//! The HTTP side: every route okfs answers. All of them read; none of them write.

use std::fs;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::{Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tower_http::compression::CompressionLayer;

use crate::index::Index;
use crate::paths::{self, Root};
use crate::render::{self, encode_path, view_url};
use crate::theme::{self, Swatch, Theme};
use crate::thumb::{self, Thumbs};
use crate::{archive, assets, preview, raw};

/// A folder's notes larger than this are not shown under its listing.
const MAX_README: u64 = 512 * 1024;
/// What the page itself may load: only what this server sends. Images in rendered
/// Markdown are the one thing allowed from elsewhere.
const PAGE_POLICY: &str = "default-src 'self'; img-src 'self' data: blob: https: http:; media-src 'self' blob:; \
     style-src 'self'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
/// The id of a theme read from a file, as the switcher knows it.
const CUSTOM: &str = "custom";

/// Which theme a fresh browser gets.
#[derive(Debug, Clone)]
pub enum ThemeChoice {
    BuiltIn(String),
    File(PathBuf),
}

#[derive(Debug, Clone)]
pub struct Options {
    pub title: String,
    pub theme: ThemeChoice,
    /// An opaque color, already checked.
    pub accent: Option<String>,
    pub css: Option<PathBuf>,
    pub header: Option<PathBuf>,
    /// Host names answered besides `localhost` and plain addresses.
    pub allow_hosts: Vec<String>,
    /// Refuse requests for other host names. On for a loopback address, where a
    /// hostile page could otherwise reach the server by pointing a name at it.
    pub check_host: bool,
    pub cache: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            title: "okfs".to_owned(),
            theme: ThemeChoice::BuiltIn("default".to_owned()),
            accent: None,
            css: None,
            header: None,
            allow_hosts: Vec::new(),
            check_host: false,
            cache: None,
        }
    }
}

pub struct App {
    pub root: Root,
    pub index: Arc<Index>,
    thumbs: Thumbs,
    options: Options,
    /// The theme from `--theme <file>`, with the file time it was read at.
    custom: Mutex<Option<(SystemTime, Theme)>>,
    /// Decoding images and coloring code are the costly requests: this many run at once.
    heavy: Semaphore,
}

impl App {
    /// Reads the theme and gets ready to serve. Fails when a theme file is refused.
    pub fn new(root: Root, index: Arc<Index>, options: Options) -> Result<Arc<Self>, String> {
        let custom = match &options.theme {
            ThemeChoice::BuiltIn(name) => {
                theme::built_in(name).ok_or_else(|| format!("there is no theme named {name}"))?;
                None
            }
            ThemeChoice::File(path) => Some(read_theme(path)?),
        };
        let workers = std::thread::available_parallelism().map_or(2, usize::from);
        Ok(Arc::new(Self {
            thumbs: Thumbs::new(options.cache.clone(), root.dir()),
            root,
            index,
            options,
            custom: Mutex::new(custom),
            heavy: Semaphore::new(workers),
        }))
    }

    /// The theme file, read again when it has changed. A change that fails the
    /// checker is reported and the last good theme stays.
    fn custom_theme(&self) -> Option<Theme> {
        let ThemeChoice::File(path) = &self.options.theme else {
            return None;
        };
        let mut held = self.custom.lock().expect("the theme lock");
        let changed = fs::metadata(path).and_then(|meta| meta.modified()).ok();
        if let Some((read_at, _)) = held.as_ref()
            && changed.is_some_and(|changed| changed != *read_at)
        {
            match read_theme(path) {
                Ok(fresh) => *held = Some(fresh),
                Err(reason) => {
                    eprintln!("okfs: keeping the last good theme. {reason}");
                    if let (Some(held), Some(changed)) = (held.as_mut(), changed) {
                        held.0 = changed;
                    }
                }
            }
        }
        held.as_ref().map(|(_, theme)| theme.clone())
    }

    fn default_theme_id(&self) -> &str {
        match &self.options.theme {
            ThemeChoice::BuiltIn(name) => name,
            ThemeChoice::File(_) => CUSTOM,
        }
    }

    fn theme_css(&self, id: &str) -> Option<String> {
        if id == CUSTOM {
            self.custom_theme().map(|theme| theme.to_css())
        } else {
            theme::built_in(id).map(|theme| theme.to_css())
        }
    }
}

/// Reads and checks a theme file. The error carries every reason it was refused.
pub fn read_theme(path: &std::path::Path) -> Result<(SystemTime, Theme), String> {
    let show = path.display();
    let css = fs::read_to_string(path).map_err(|error| format!("cannot read the theme {show}: {error}"))?;
    let read_at = fs::metadata(path)
        .and_then(|meta| meta.modified())
        .unwrap_or(UNIX_EPOCH);
    match theme::check(&css) {
        Ok(theme) => Ok((read_at, theme)),
        Err(problems) => {
            let reasons: Vec<String> = problems.iter().map(|problem| format!("  {problem}")).collect();
            Err(format!("the theme {show} is refused:\n{}", reasons.join("\n")))
        }
    }
}

/// Every route. There is no route that changes anything on disk.
pub fn router(app: Arc<App>) -> Router {
    let packed = Router::new()
        .route("/api/list", get(list))
        .route("/api/preview", get(preview_file))
        .route("/api/search", get(search))
        .route("/api/archive", get(archive_list))
        .route("/theme.css", get(active_theme))
        .route("/assets/{*name}", get(asset))
        .route("/-/{*path}", get(page))
        .route("/-/", get(page))
        .fallback(page_or_refuse)
        .layer(CompressionLayer::new());
    // Sent as they are: ranges and compression do not mix, and images are packed already.
    let plain = Router::new()
        .route("/api/thumb", get(thumbnail))
        .route("/raw/{*path}", get(raw_file))
        .route("/zip", get(zip_folder))
        .route("/zip/", get(zip_folder))
        .route("/zip/{*path}", get(zip_folder));
    packed
        .merge(plain)
        .layer(middleware::from_fn_with_state(Arc::clone(&app), guard))
        .with_state(app)
}

fn fail(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

fn not_found() -> Response {
    fail(StatusCode::NOT_FOUND, "not found")
}

/// True when a request's Host names this machine directly or is on the allowed list.
pub fn host_allowed(host: &str, allowed: &[String]) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let name = match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => host.rsplit_once(':').map_or(host.as_str(), |(name, port)| {
            if port.chars().all(|c| c.is_ascii_digit()) {
                name
            } else {
                host.as_str()
            }
        }),
    };
    name.parse::<IpAddr>().is_ok()
        || name == "localhost"
        || name.ends_with(".localhost")
        || allowed.iter().any(|allowed| allowed.eq_ignore_ascii_case(name))
}

/// Runs before every route: checks the Host name and marks every answer as not to be sniffed.
async fn guard(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    if app.options.check_host {
        let host = request
            .headers()
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .or_else(|| request.uri().host())
            .unwrap_or("");
        if !host_allowed(host, &app.options.allow_hosts) {
            let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
            let message = format!(
                "okfs does not answer to the name {name:?}.\nTo allow it, start okfs with: --allow-host {name}\n"
            );
            return (StatusCode::FORBIDDEN, message).into_response();
        }
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("same-origin"));
    response
}

/// Runs work that blocks, at most a few at a time.
async fn heavy<T: Send + 'static>(app: &App, work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let _permit = app.heavy.acquire().await.ok()?;
    tokio::task::spawn_blocking(work).await.ok()
}

#[derive(Deserialize)]
struct PathQuery {
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    path: String,
    /// Send only the first entries by name, folders first. For the preview of a folder.
    limit: Option<usize>,
}

#[derive(Serialize)]
struct Item {
    n: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    d: bool,
    /// Size in bytes. Zero for a folder.
    s: u64,
    /// Modified time, in seconds.
    m: i64,
    /// For a folder, how many entries it holds.
    #[serde(skip_serializing_if = "Option::is_none")]
    c: Option<usize>,
}

#[derive(Serialize)]
struct Readme {
    name: String,
    html: String,
}

#[derive(Serialize)]
struct Listing {
    path: String,
    /// In name order. The page sorts and filters from here.
    entries: Vec<Item>,
    total: usize,
    readme: Option<Readme>,
}

fn list_folder(app: &App, query: &ListQuery) -> Option<Listing> {
    let found = app.root.resolve(&query.path).filter(|found| found.meta.is_dir())?;
    let mut seen = app.root.scan(&found.abs).ok()?;
    let total = seen.len();
    seen.sort_by(|a, b| paths::natural_cmp(&a.name, &b.name));
    if let Some(limit) = query.limit {
        seen.sort_by_key(|entry| !entry.dir);
        seen.truncate(limit);
    }

    let readme = seen
        .iter()
        .filter(|_| query.limit.is_none())
        .find(|entry| !entry.dir && render::is_readme(&entry.name))
        .and_then(|entry| {
            let at = found.abs.join(&entry.name);
            let small = fs::metadata(&at).is_ok_and(|meta| meta.len() <= MAX_README);
            let text = small.then(|| fs::read_to_string(&at).ok())??;
            Some(Readme {
                name: entry.name.clone(),
                html: render::markdown(&text, &found.rel),
            })
        });

    let entries = seen
        .into_iter()
        .filter_map(|entry| {
            let at = found.abs.join(&entry.name);
            let meta = fs::metadata(&at).ok()?;
            let modified = meta.modified().ok().and_then(|at| at.duration_since(UNIX_EPOCH).ok());
            let count = entry.dir.then(|| {
                app.index
                    .child_count(&paths::join(&found.rel, &entry.name))
                    .or_else(|| app.root.scan(&at).ok().map(|inside| inside.len()))
            });
            Some(Item {
                n: entry.name,
                d: entry.dir,
                s: if entry.dir { 0 } else { meta.len() },
                m: modified.map_or(0, |since| since.as_secs() as i64),
                c: count.flatten(),
            })
        })
        .collect();
    Some(Listing {
        path: found.rel,
        entries,
        total,
        readme,
    })
}

async fn list(State(app): State<Arc<App>>, Query(query): Query<ListQuery>) -> Response {
    let worker = Arc::clone(&app);
    match tokio::task::spawn_blocking(move || list_folder(&worker, &query)).await {
        Ok(Some(listing)) => Json(listing).into_response(),
        _ => not_found(),
    }
}

async fn preview_file(State(app): State<Arc<App>>, Query(query): Query<PathQuery>) -> Response {
    let Some(found) = app.root.resolve(&query.path).filter(|found| found.meta.is_file()) else {
        return not_found();
    };
    let size = found.meta.len();
    match heavy(&app, move || preview::of(&found.abs, &found.rel, size)).await {
        Some(Ok(preview)) => Json(preview).into_response(),
        _ => fail(StatusCode::INTERNAL_SERVER_ERROR, "the file could not be read"),
    }
}

#[derive(Deserialize)]
struct ThumbQuery {
    #[serde(default)]
    path: String,
    w: Option<u32>,
}

async fn thumbnail(State(app): State<Arc<App>>, Query(query): Query<ThumbQuery>) -> Response {
    let Some(found) = app.root.resolve(&query.path).filter(|found| found.meta.is_file()) else {
        return not_found();
    };
    let w = thumb::width(query.w.unwrap_or(thumb::WIDTHS[1]));
    let worker = Arc::clone(&app);
    match heavy(&app, move || worker.thumbs.get(&found.abs, w, &found.meta)).await {
        Some(Ok(made)) => (
            [
                (header::CONTENT_TYPE, made.mime),
                (header::CACHE_CONTROL, "private, max-age=3600"),
            ],
            made.bytes,
        )
            .into_response(),
        Some(Err(thumb::Refused::TooLarge)) => {
            fail(StatusCode::PAYLOAD_TOO_LARGE, "the image is too large for a thumbnail")
        }
        Some(Err(thumb::Refused::Unreadable(_))) => {
            fail(StatusCode::UNSUPPORTED_MEDIA_TYPE, "not an image this build can read")
        }
        None => fail(StatusCode::INTERNAL_SERVER_ERROR, "the thumbnail could not be made"),
    }
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: String,
    limit: Option<usize>,
}

async fn search(State(app): State<Arc<App>>, Query(query): Query<SearchQuery>) -> Response {
    let limit = query.limit.unwrap_or(60).min(200);
    let index = Arc::clone(&app.index);
    match tokio::task::spawn_blocking(move || index.search(&query.q, limit)).await {
        Ok(found) => Json(found).into_response(),
        Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "the search failed"),
    }
}

async fn archive_list(State(app): State<Arc<App>>, Query(query): Query<PathQuery>) -> Response {
    let Some(found) = app.root.resolve(&query.path).filter(|found| found.meta.is_file()) else {
        return not_found();
    };
    match tokio::task::spawn_blocking(move || archive::list(&found.abs)).await {
        Ok(Ok(listing)) => Json(listing).into_response(),
        _ => fail(StatusCode::UNSUPPORTED_MEDIA_TYPE, "not a zip file this build can read"),
    }
}

async fn raw_file(State(app): State<Arc<App>>, Path(path): Path<String>, headers: HeaderMap) -> Response {
    let Some(found) = app.root.resolve(&path).filter(|found| found.meta.is_file()) else {
        return not_found();
    };
    match raw::serve(found, &headers).await {
        Ok(response) => response,
        Err(_) => not_found(),
    }
}

async fn zip_folder(State(app): State<Arc<App>>, path: Option<Path<String>>) -> Response {
    let path = path.map(|Path(path)| path).unwrap_or_default();
    let Some(found) = app.root.resolve(&path).filter(|found| found.meta.is_dir()) else {
        return not_found();
    };
    let name = match paths::file_name(&found.rel) {
        "" => app.root.name(),
        name => name.to_owned(),
    };
    let (send, receive) = tokio::sync::mpsc::channel(4);
    let root = app.root.clone();
    tokio::task::spawn_blocking(move || archive::stream(&root, &found.abs, send));
    let pieces = futures_util::stream::unfold(receive, |mut receive| async {
        receive.recv().await.map(|piece| (piece, receive))
    });
    let plain: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "-_. ".contains(*c))
        .collect();
    let disposition = format!(
        "attachment; filename=\"{}.zip\"; filename*=UTF-8''{}.zip",
        if plain.trim().is_empty() {
            "folder"
        } else {
            plain.trim()
        },
        encode_path(&name)
    );
    (
        [
            (header::CONTENT_TYPE, "application/zip".to_owned()),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CACHE_CONTROL, "no-store".to_owned()),
        ],
        Body::from_stream(pieces),
    )
        .into_response()
}

fn css(text: String) -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        text,
    )
        .into_response()
}

async fn active_theme(State(app): State<Arc<App>>) -> Response {
    match app.theme_css(app.default_theme_id()) {
        Some(text) => css(text),
        None => not_found(),
    }
}

/// The override behind `--accent`: the accent, a readable color on top of it, and a soft tint.
fn brand_css(accent: &str) -> String {
    let on_accent = theme::opaque_color(accent).map_or("#ffffff", |color| {
        let (dark, light) = ([22.0, 22.0, 22.0], [255.0; 3]);
        if theme::contrast(color, light) >= theme::contrast(color, dark) {
            "#ffffff"
        } else {
            "#161616"
        }
    });
    format!(
        ":root, :root[data-scheme=\"dark\"] {{\n  --accent: {accent};\n  --accent-fg: {on_accent};\n  \
         --accent-soft: color-mix(in srgb, {accent} 14%, var(--bg));\n}}\n"
    )
}

async fn asset(State(app): State<Arc<App>>, Path(name): Path<String>, headers: HeaderMap) -> Response {
    if let Some(id) = name.strip_prefix("themes/").and_then(|file| file.strip_suffix(".css")) {
        return app.theme_css(id).map_or_else(not_found, css);
    }
    match name.as_str() {
        "brand.css" => return app.options.accent.as_deref().map(brand_css).map_or_else(not_found, css),
        "custom.css" => {
            let text = app.options.css.as_ref().and_then(|path| fs::read_to_string(path).ok());
            return text.map_or_else(not_found, css);
        }
        _ => {}
    }
    let Some(found) = assets::get(&name) else {
        return not_found();
    };
    let fresh = !found.etag.is_empty()
        && headers
            .get(header::IF_NONE_MATCH)
            .is_some_and(|tag| tag.as_bytes() == found.etag.as_bytes());
    if fresh {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    let (mime, _) = raw::content_type(&name);
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::ETAG, found.etag.to_owned()),
            (header::CACHE_CONTROL, "no-cache".to_owned()),
        ],
        found.bytes,
    )
        .into_response()
}

#[derive(Serialize)]
struct ThemeInfo {
    id: String,
    name: String,
    light: Swatch,
    dark: Swatch,
}

#[derive(Serialize)]
struct Target {
    path: String,
    /// `dir`, `file`, or `missing`.
    kind: &'static str,
}

/// What the page is told when it loads, written into the HTML.
#[derive(Serialize)]
struct Config {
    /// The served folder's name: the first breadcrumb.
    root: String,
    title: String,
    version: &'static str,
    /// The theme a browser with no saved choice gets.
    theme: String,
    themes: Vec<ThemeInfo>,
    /// The `--header` note, rendered.
    header: Option<String>,
    target: Target,
}

fn theme_infos(app: &App) -> Vec<ThemeInfo> {
    let info = |id: &str, theme: Theme| ThemeInfo {
        id: id.to_owned(),
        light: theme.swatch(false),
        dark: theme.swatch(true),
        name: theme.name,
    };
    let mut themes: Vec<ThemeInfo> = theme::BUILT_IN
        .iter()
        .filter_map(|(id, _)| Some(info(id, theme::built_in(id)?)))
        .collect();
    themes.extend(app.custom_theme().map(|theme| info(CUSTOM, theme)));
    themes
}

fn escape_html(text: &str) -> String {
    let mut out = String::new();
    render::escape(text, &mut out);
    out
}

/// The page. Any path that is not one of the server's own gets it, and the page
/// then shows that path.
async fn page(State(app): State<Arc<App>>, uri: Uri) -> Response {
    let raw_path = uri.path();
    let behind = raw_path
        .strip_prefix("/-/")
        .or_else(|| (raw_path == "/-").then_some(""));
    let asked = percent_decode_str(behind.unwrap_or(raw_path)).decode_utf8().ok();
    let found = asked.as_deref().and_then(|path| app.root.resolve(path));

    // A folder's address ends with a slash and a file's does not, so links inside both resolve.
    if let Some(found) = &found {
        let is_dir = found.meta.is_dir();
        if !found.rel.is_empty() && is_dir != raw_path.ends_with('/') {
            let mut to = view_url(&encode_path(&found.rel));
            if is_dir {
                to.push('/');
            }
            if let Some(query) = uri.query() {
                to = format!("{to}?{query}");
            }
            return (StatusCode::PERMANENT_REDIRECT, [(header::LOCATION, to)]).into_response();
        }
    }

    let target = match &found {
        Some(found) => Target {
            path: found.rel.clone(),
            kind: if found.meta.is_dir() { "dir" } else { "file" },
        },
        None => Target {
            path: asked.as_deref().unwrap_or("").trim_matches('/').to_owned(),
            kind: "missing",
        },
    };
    let missing = found.is_none();
    let header_note = app.options.header.as_ref().and_then(|path| {
        let small = fs::metadata(path).is_ok_and(|meta| meta.len() <= MAX_README);
        small
            .then(|| fs::read_to_string(path).ok())
            .flatten()
            .map(|text| render::markdown(&text, ""))
    });
    let config = Config {
        root: app.root.name(),
        title: app.options.title.clone(),
        version: env!("CARGO_PKG_VERSION"),
        theme: app.default_theme_id().to_owned(),
        themes: theme_infos(&app),
        header: header_note,
        target,
    };
    // Inside a script element, only "<" could end the block early.
    let config = serde_json::to_string(&config)
        .expect("plain data")
        .replace('<', "\\u003c");

    let Some(shell) = assets::get("index.html") else {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "the page is missing from this build");
    };
    let mut extra = String::new();
    if app.options.accent.is_some() {
        extra.push_str("<link rel=\"stylesheet\" href=\"/assets/brand.css\">\n");
    }
    if app.options.css.is_some() {
        extra.push_str("<link rel=\"stylesheet\" href=\"/assets/custom.css\">\n");
    }
    let html = String::from_utf8_lossy(&shell.bytes)
        .replace(
            "<title>okfs</title>",
            &format!("<title>{}</title>", escape_html(&app.options.title)),
        )
        .replace("<!--okfs:css-->", &extra)
        .replace("<!--okfs:config-->", &config);
    (
        if missing { StatusCode::NOT_FOUND } else { StatusCode::OK },
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::CONTENT_SECURITY_POLICY, PAGE_POLICY),
        ],
        html,
    )
        .into_response()
}

/// Reading gets the page. Every other method is refused: nothing here writes.
async fn page_or_refuse(state: State<Arc<App>>, method: Method, uri: Uri) -> Response {
    if method == Method::GET || method == Method::HEAD {
        page(state, uri).await
    } else {
        (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "GET, HEAD")]).into_response()
    }
}
