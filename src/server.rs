//! The HTTP side: every route okfs answers. All of them read, except the one that
//! deletes, and that one refuses unless okfs was started with `--allow-delete`.

use std::fs;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, Request, State};
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::{Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tower_http::compression::CompressionLayer;

use crate::index::Index;
use crate::paths::{self, Kept, NoEntry, Resolved, Root, Unshown};
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
/// Added to the page's policy while deleting is on: only okfs itself may show the page
/// in a frame. Another site that could would hide it and steer a visitor's clicks
/// onto the delete button and through the dialog.
const NO_FRAMING: &str = "frame-ancestors 'self'";
/// The id of a theme read from a file, as the switcher knows it.
const CUSTOM: &str = "custom";
/// The header, and its value, that the page sends with a delete. See `own_page`.
const DELETE_HEADER: (&str, &str) = ("x-okfs", "delete");
/// What a delete is refused with when nothing about it says okfs's own page sent it.
const NOT_THE_PAGE: &str = "only the okfs page itself can delete";

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
    /// From `--index`: a folder holding a file of this name opens as that page.
    pub index: Option<String>,
    /// Host names answered besides `localhost` and plain addresses.
    pub allow_hosts: Vec<String>,
    /// Refuse requests for other host names. On for a loopback address, where a
    /// hostile page could otherwise reach the server by pointing a name at it.
    pub check_host: bool,
    pub cache: Option<PathBuf>,
    /// Let visitors delete entries. Off unless asked for: okfs has no accounts, so
    /// with this on anyone who can reach the address can delete.
    pub allow_delete: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            title: "okfs".to_owned(),
            theme: ThemeChoice::BuiltIn("default".to_owned()),
            accent: None,
            css: None,
            header: None,
            index: None,
            allow_hosts: Vec::new(),
            check_host: false,
            cache: None,
            allow_delete: false,
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

/// Every route. Only `/api/entry` changes anything on disk, and only when deleting is on.
pub fn router(app: Arc<App>) -> Router {
    let packed = Router::new()
        .route("/api/list", get(list))
        .route("/api/entry", delete(delete_entry))
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
        .route("/raw/", get(raw_root))
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

/// Splits a host, as a request names it, into its name and its port.
fn split_host(host: &str) -> (&str, Option<&str>) {
    if let Some(v6) = host.strip_prefix('[') {
        let (name, rest) = v6.split_once(']').unwrap_or((v6, ""));
        return (name, rest.strip_prefix(':'));
    }
    match host.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => (name, Some(port)),
        _ => (host, None),
    }
}

/// The host a request came in on.
fn request_host<'a>(headers: &'a HeaderMap, uri: &'a Uri) -> &'a str {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .or_else(|| uri.authority().map(|authority| authority.as_str()))
        .unwrap_or("")
}

/// True when a request's Host names this machine directly or is on the allowed list.
pub fn host_allowed(host: &str, allowed: &[String]) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let (name, _) = split_host(&host);
    name.parse::<IpAddr>().is_ok()
        || name == "localhost"
        || name.ends_with(".localhost")
        || allowed.iter().any(|allowed| allowed.eq_ignore_ascii_case(name))
}

/// Runs before every route: checks the Host name and marks every answer as not to be sniffed.
async fn guard(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    if app.options.check_host {
        let host = request_host(request.headers(), request.uri());
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
    /// A link. A delete removes the link and leaves what it points at.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    l: bool,
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
    /// The path's last name is a link to this folder. A delete removes only the link.
    /// Told with a whole listing only, as the notes are.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    link: bool,
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
                l: entry.link,
                s: if entry.dir { 0 } else { meta.len() },
                m: modified.map_or(0, |since| since.as_secs() as i64),
                c: count.flatten(),
            })
        })
        .collect();
    Some(Listing {
        link: query.limit.is_none() && app.root.entry(&found.rel).is_ok_and(|entry| entry.is_link()),
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

#[derive(Deserialize)]
struct PreviewQuery {
    #[serde(default)]
    path: String,
    /// Send only the start of the file, for a grid tile.
    head: Option<u8>,
}

async fn preview_file(State(app): State<Arc<App>>, Query(query): Query<PreviewQuery>) -> Response {
    let Some(found) = app.root.resolve(&query.path).filter(|found| found.meta.is_file()) else {
        return not_found();
    };
    let size = found.meta.len();
    let work = move || match query.head {
        Some(_) => preview::head(&found.abs, &found.rel),
        None => preview::of(&found.abs, &found.rel, size),
    };
    match heavy(&app, work).await {
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

/// True when a delete was asked for by okfs's own page, and not by a page on another
/// site that a visitor happens to have open. okfs has no accounts, so there is no
/// session to steal: what such a page could borrow is the visitor's place on the
/// network, the browser that can reach an address the page's own server cannot.
/// Three things together stop that.
///
/// - The method is DELETE and the request carries a header of okfs's own. A form
///   can send neither, and a script on another site can send them only after the
///   browser has asked okfs for leave (a preflight). okfs never gives it: it answers
///   no OPTIONS request and sends no CORS header.
/// - The `Origin` header, which a browser sets on every DELETE and a page cannot
///   change, has to name okfs itself. It passes the same rule as the Host of any
///   request (a plain address, `localhost`, or a name from `--allow-host`), so a
///   hostile name pointed at this machine fails even when okfs listens beyond
///   loopback. And it has to be the host this request came in on, or a name from
///   `--allow-host`: a proxy may put its own idea of the Host in front of okfs. The
///   scheme is not compared. A proxy in front ends TLS, so the browser says `https`
///   where okfs sees plain HTTP; the scheme only tells which port a bare name means.
/// - A missing `Origin` is refused, and so is `Origin: null`. The second is what a
///   served HTML or SVG file has, because okfs sends those sandboxed, so a file in
///   the folder can never delete its neighbours.
///
/// The error is what to answer. When a page did send the request, from a host okfs
/// does not know as its own, it names the `--allow-host` that would let it in.
fn own_page(headers: &HeaderMap, host: &str, allowed: &[String]) -> Result<(), String> {
    let (name, value) = DELETE_HEADER;
    if headers.get(name).is_none_or(|sent| sent != value) {
        return Err(NOT_THE_PAGE.to_owned());
    }
    let mut origins = headers.get_all(header::ORIGIN).iter();
    let (Some(origin), None) = (origins.next(), origins.next()) else {
        return Err(NOT_THE_PAGE.to_owned());
    };
    let origin = origin.to_str().unwrap_or("").to_ascii_lowercase();
    let Some((scheme, from)) = origin.split_once("://") else {
        return Err(NOT_THE_PAGE.to_owned());
    };
    let default_port = match scheme {
        "http" => "80",
        "https" => "443",
        _ => return Err(NOT_THE_PAGE.to_owned()),
    };
    let (from_name, from_port) = split_host(from);
    if from_name.is_empty() || from.contains(['/', '@', '?', '#']) {
        return Err(NOT_THE_PAGE.to_owned());
    }
    let host = host.trim().to_ascii_lowercase();
    let (name, port) = split_host(&host);
    // A Host with no port means the usual one for the scheme the browser used.
    let same = from_name == name && from_port.unwrap_or(default_port) == port.unwrap_or(default_port);
    let named = allowed.iter().any(|allowed| allowed.eq_ignore_ascii_case(from_name));
    if host_allowed(from, allowed) && (same || named) {
        return Ok(());
    }
    Err(format!(
        "the page at {from} is not one okfs knows as its own: to delete from it, start okfs with --allow-host {from_name}"
    ))
}

/// Removes one entry and takes it out of the index. Answers with how it ended.
fn remove_entry(app: &App, path: &str) -> Response {
    let entry = match app.root.entry(path) {
        Ok(entry) => entry,
        Err(NoEntry::Root) => return fail(StatusCode::FORBIDDEN, "the served folder itself cannot be deleted"),
        Err(NoEntry::NotServed) => return fail(StatusCode::FORBIDDEN, "this path is not served"),
        Err(NoEntry::Missing) => return not_found(),
    };
    let removed = app.root.remove(&entry);
    app.index.reread(&entry.folder);
    // A folder that is partly gone is still listed where it was, changed inside at any depth.
    if matches!(removed, Err(Kept::Partly(_))) {
        app.index.rewalk(&entry.place());
    }
    match removed {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(Kept::Holds(Unshown::Hidden)) => fail(
            StatusCode::CONFLICT,
            "somewhere inside, this folder holds a dotfile, which okfs is not showing and so does not delete: \
             start okfs with --hidden, or remove the dotfile yourself",
        ),
        Err(Kept::Holds(Unshown::Unserved)) => fail(
            StatusCode::CONFLICT,
            "somewhere inside, this folder holds something okfs cannot show, such as a link that leads out of \
             the served folder, and so does not delete: remove it yourself",
        ),
        // The kind reads as plain words, such as "permission denied", and names no path.
        Err(Kept::Failed(error)) => fail(disk_status(&error), &error.kind().to_string()),
        Err(Kept::Partly(error)) => {
            let message = format!("{}, and part of the folder may already be gone", error.kind());
            let answer = serde_json::json!({ "error": message, "partial": true });
            (disk_status(&error), Json(answer)).into_response()
        }
    }
}

/// The status to answer with when the disk refused a delete.
fn disk_status(error: &std::io::Error) -> StatusCode {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
        std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// Deletes one entry of the served folder: a file, a link, or a folder with everything in it.
async fn delete_entry(
    State(app): State<Arc<App>>,
    query: Result<Query<PathQuery>, QueryRejection>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !app.options.allow_delete {
        return fail(StatusCode::FORBIDDEN, "deleting is off: start okfs with --allow-delete");
    }
    if let Err(why) = own_page(&headers, request_host(&headers, &uri), &app.options.allow_hosts) {
        return fail(StatusCode::FORBIDDEN, &why);
    }
    let Ok(Query(query)) = query else {
        return fail(StatusCode::BAD_REQUEST, "the path cannot be read");
    };
    let worker = Arc::clone(&app);
    tokio::task::spawn_blocking(move || remove_entry(&worker, &query.path))
        .await
        .unwrap_or_else(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "the delete failed"))
}

/// A folder's `--index` file. A name `resolve` refuses is not one: a dotfile without
/// `--hidden`, or a link that leaves the served folder. Neither is a folder of that name.
fn index_page(app: &App, folder: &str) -> Option<Resolved> {
    let index = app.options.index.as_deref()?;
    app.root
        .resolve(&paths::join(folder, index))
        .filter(|found| found.meta.is_file())
}

/// Whether an address under `/raw/` asks for the script that tells of the page's first paint: `?painted`.
fn painted(uri: &Uri) -> bool {
    uri.query().is_some_and(|query| query.split('&').any(|part| part == "painted"))
}

async fn raw_file(State(app): State<Arc<App>>, Path(path): Path<String>, uri: Uri, headers: HeaderMap) -> Response {
    let found = match app.root.resolve(&path) {
        Some(found) if found.meta.is_file() => found,
        Some(folder) if folder.meta.is_dir() => {
            let Some(found) = index_page(&app, &folder.rel) else {
                return not_found();
            };
            // A folder's address ends with a slash, so links inside its index page resolve.
            if !uri.path().ends_with('/') {
                let mut to = format!("/raw/{}/", encode_path(&folder.rel));
                if let Some(query) = uri.query() {
                    to = format!("{to}?{query}");
                }
                return (StatusCode::PERMANENT_REDIRECT, [(header::LOCATION, to)]).into_response();
            }
            found
        }
        _ => return not_found(),
    };
    match raw::serve(found, &headers, painted(&uri)).await {
        Ok(response) => response,
        Err(_) => not_found(),
    }
}

/// `/raw/` is the served folder itself: its `--index` file, and without one the page as ever.
async fn raw_root(state: State<Arc<App>>, uri: Uri, headers: HeaderMap) -> Response {
    let Some(found) = index_page(&state, "") else {
        return page(state, uri).await;
    };
    match raw::serve(found, &headers, painted(&uri)).await {
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
    /// The `--index` file name. Left out when the flag is.
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<String>,
    target: Target,
    /// True when deleting is on. The page shows its delete control only then.
    delete: bool,
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
        index: app.options.index.clone(),
        target,
        delete: app.options.allow_delete,
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
    let policy = if app.options.allow_delete {
        format!("{PAGE_POLICY}; {NO_FRAMING}")
    } else {
        PAGE_POLICY.to_owned()
    };
    (
        if missing { StatusCode::NOT_FOUND } else { StatusCode::OK },
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::CONTENT_SECURITY_POLICY, policy.as_str()),
        ],
        html,
    )
        .into_response()
}

/// Reading gets the page. Every other method is refused: no address of a file takes a write.
async fn page_or_refuse(state: State<Arc<App>>, method: Method, uri: Uri) -> Response {
    if method == Method::GET || method == Method::HEAD {
        page(state, uri).await
    } else {
        (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "GET, HEAD")]).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_split_into_name_and_port() {
        assert_eq!(split_host("localhost:8080"), ("localhost", Some("8080")));
        assert_eq!(split_host("files.example.test"), ("files.example.test", None));
        assert_eq!(split_host("[::1]:8080"), ("::1", Some("8080")));
        assert_eq!(split_host("[::1]"), ("::1", None));
    }
}
