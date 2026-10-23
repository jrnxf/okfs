//! The HTTP side: every route okfs answers. All of them read, except the three that write: one
//! deletes, and refuses unless okfs was started with `--allow-delete`, one puts a file in place,
//! with `--allow-upload` or `--allow-edit`, and one makes a folder, with `--allow-upload`.

use std::convert::Infallible;
use std::fs;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, Request, State};
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::{Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use futures_util::{StreamExt, future, stream};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;
use tower_http::compression::CompressionLayer;

use crate::index::{Index, Order, Page};
use crate::key::{self, Key, Once};
use crate::live::Change;
use crate::paths::{self, Kept, NoEntry, Resolved, Root, Target as Place, Unshown};
use crate::pdf::{self, Drawer};
use crate::render::{self, encode_path, view_url};
use crate::theme::{self, Swatch, Theme};
use crate::thumb::{self, Thumbs};
use crate::write::{self, Locks, Part};
use crate::{archive, assets, preview, raw};

/// A folder's notes larger than this are not shown under its listing.
const MAX_README: u64 = 512 * 1024;
/// What the page itself may load: only what this server sends. Images in rendered
/// Markdown are the one thing allowed from elsewhere.
const PAGE_POLICY: &str = "default-src 'self'; img-src 'self' data: blob: https: http:; media-src 'self' blob:; \
     style-src 'self'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
/// Added to the page's policy while any write is on: only okfs itself may show the page
/// in a frame. Another site that could would hide it and steer a visitor's clicks
/// onto the delete button and through the dialog, or into the editor.
const NO_FRAMING: &str = "frame-ancestors 'self'";
/// The header that tells a page its PDF cannot be read.
const PDF_HEADER: &str = "x-okfs-pdf";
/// How often a stream of changes with nothing to tell sends a comment line, so that
/// no proxy on the way takes it for dead and cuts it.
const STREAM_BEAT: Duration = Duration::from_secs(15);
/// The id of a theme read from a file, as the switcher knows it.
const CUSTOM: &str = "custom";
/// The header the page sends with every change it asks for, with the kind of change as its
/// value: `delete`, or `write` for a file or a folder put in place. See `own_page`.
const OWN_HEADER: &str = "x-okfs";

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
    pub header: Option<PathBuf>,
    /// From `--index`: a folder holding a file of this name opens as that page.
    pub index: Option<String>,
    /// Host names answered besides `localhost` and plain addresses.
    pub allow_hosts: Vec<String>,
    /// Refuse requests for other host names, so that a hostile page cannot reach the
    /// server by pointing a name of its own at it. okfs turns it on at every address it
    /// listens on; a router built for a test may leave it off.
    pub check_host: bool,
    pub cache: Option<PathBuf>,
    /// okfs itself, started again to draw the first page of a PDF. Without it PDFs get no picture.
    pub drawer: Option<PathBuf>,
    /// How long one PDF page may take to draw.
    pub pdf_limit: Duration,
    /// Let visitors delete entries. Off unless asked for: okfs has no accounts, so
    /// with this on anyone who can reach the address can delete.
    pub allow_delete: bool,
    /// Let visitors add files and folders. A file never lands on a name that is taken.
    pub allow_upload: bool,
    /// Let visitors change the files that are there: save from the editor, or replace a file
    /// with one of the same name. Each write names the version it replaces.
    pub allow_edit: bool,
    /// The largest file a write takes, in bytes. No limit without it.
    pub max_upload: Option<u64>,
    /// The key every request has to bring, in its address or its cookie: see `key`. okfs makes
    /// one at an address beyond loopback, unless told not to.
    pub key: Option<Key>,
    /// A code that lets one browser in once in place of the key, for the browser okfs opens itself:
    /// see `key::Once`. Only with a key.
    pub once: Option<Arc<Once>>,
    /// okfs serves https itself, from `--tls-cert` and `--tls-key`.
    pub tls: bool,
}

impl Options {
    /// True when anything may change the served folder.
    pub fn writes(&self) -> bool {
        self.allow_delete || self.allow_upload || self.allow_edit
    }
}

impl Default for Options {
    fn default() -> Self {
        Self {
            title: "okfs".to_owned(),
            theme: ThemeChoice::BuiltIn("default".to_owned()),
            accent: None,
            header: None,
            index: None,
            allow_hosts: Vec::new(),
            check_host: false,
            cache: None,
            drawer: None,
            pdf_limit: pdf::LIMIT,
            allow_delete: false,
            allow_upload: false,
            allow_edit: false,
            max_upload: None,
            key: None,
            once: None,
            tls: false,
        }
    }
}

pub struct App {
    pub root: Root,
    pub index: Arc<Index>,
    thumbs: Thumbs,
    /// Draws the first pages of PDFs, when this build and this run can.
    drawer: Option<Drawer>,
    options: Options,
    /// The theme from `--theme <file>`, with the file time it was read at.
    custom: Mutex<Option<(SystemTime, Theme)>>,
    /// Decoding images and coloring code are the costly requests: this many run at once.
    heavy: Semaphore,
    /// The files being replaced, one write at a time on each.
    locks: Locks,
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
        let thumbs = Thumbs::new(options.cache.clone(), root.dir());
        index.after_rescan(thumbs.pruner());
        Ok(Arc::new(Self {
            thumbs,
            drawer: Drawer::new(options.drawer.clone(), options.pdf_limit),
            root,
            index,
            options,
            custom: Mutex::new(custom),
            heavy: Semaphore::new(workers),
            locks: Locks::default(),
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

/// Every route. Only `/api/entry`, `/api/file` and `/api/folder` change anything on disk, and
/// only when their flag is on.
pub fn router(app: Arc<App>) -> Router {
    let packed = Router::new()
        .route("/api/list", get(list))
        .route("/api/entry", delete(delete_entry))
        .route("/api/previews", get(preview_many))
        .route("/api/search", get(search))
        .route("/api/recent", get(recent))
        .route("/api/archive", get(archive_list))
        .route("/theme.css", get(active_theme))
        .route("/assets/{*name}", get(asset))
        .route("/-/{*path}", get(page))
        .route("/-/", get(page))
        .fallback(page_or_refuse)
        .layer(CompressionLayer::new());
    // Sent as they are: ranges and compression do not mix, images are packed already,
    // and a change has to leave the moment it is written.
    let plain = Router::new()
        .route("/api/events", get(events))
        // A body comes in as it is sent, straight to disk.
        .route("/api/file", put(put_file))
        .route("/api/folder", post(make_folder))
        .route("/api/picture", get(picture))
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

/// A yes or no in a query: `1` or `true` for yes, `0`, `false` or nothing for no.
fn yes(value: &str) -> Option<bool> {
    match value {
        "1" | "true" => Some(true),
        "" | "0" | "false" => Some(false),
        _ => None,
    }
}

/// Reads a yes or no in a query with `yes`. Another value is refused.
fn query_flag<'de, D: serde::Deserializer<'de>>(from: D) -> Result<bool, D::Error> {
    let value = String::deserialize(from)?;
    yes(&value).ok_or_else(|| serde::de::Error::custom(format!("{value:?} is not 1, true, 0 or false")))
}

/// Splits a host, as a request names it, into its name and its port.
pub(crate) fn split_host(host: &str) -> (&str, Option<&str>) {
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

/// Runs before every route: checks the Host name and the key, and marks every answer as not to be
/// sniffed.
async fn guard(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let mut response = match admit(&app, &request) {
        Some(refused) => refused,
        None => next.run(request).await,
    };
    let headers = response.headers_mut();
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers
        .entry(header::REFERRER_POLICY)
        .or_insert(HeaderValue::from_static("same-origin"));
    response
}

/// What a request is answered with in place of the route it asks for: a refusal for a host name
/// okfs does not answer to or a request without the key, or the step that takes the key out of a
/// browser's address. `None` lets it through.
fn admit(app: &App, request: &Request) -> Option<Response> {
    let host = request_host(request.headers(), request.uri());
    if app.options.check_host && !host_allowed(host, &app.options.allow_hosts) {
        let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
        let message =
            format!("okfs does not answer to the name {name:?}.\nTo allow it, start okfs with: --allow-host {name}\n");
        return Some((StatusCode::FORBIDDEN, message).into_response());
    }
    let key = app.options.key.as_ref()?;
    let headers = request.headers();
    let cookie = key::cookie_name(host);
    let query = request.uri().query();
    let given = values_in(query, key::PARAM);
    let codes = values_in(query, key::ONCE_PARAM);
    let by_address = given.iter().any(|given| key.matches(given));
    // A code is spent by the first request that brings it, whatever else that request brings.
    let by_code = app
        .options
        .once
        .as_ref()
        .is_some_and(|once| codes.iter().any(|code| once.take(code)));
    if !by_address && !by_code && !key::cookies(headers, &cookie).any(|value| key.matches(value)) {
        return Some(needs_key(headers));
    }
    let set = || key::set_cookie(&cookie, key, app.options.tls || key::over_https(headers));
    // A code is traded for the cookie that holds the key, and for nothing else: it lets in no
    // request beyond the one that hands the cookie over.
    if by_code {
        return Some(landing(&without_key(request.uri()), Some(set())));
    }
    // A browser comes once with the key in its address. It is taken out, so that the address bar,
    // the history and a link copied from either do not show it, and the browser keeps it in a
    // cookie instead. curl and the like come with it every time, and are answered at once.
    if (given.is_empty() && codes.is_empty()) || !navigates(request) {
        return None;
    }
    Some(landing(&without_key(request.uri()), by_address.then(set)))
}

/// The values of `name` in a query, decoded.
fn values_in(query: Option<&str>, name: &str) -> Vec<String> {
    let decode = |text: &str| {
        percent_decode_str(&text.replace('+', " "))
            .decode_utf8_lossy()
            .into_owned()
    };
    query
        .unwrap_or("")
        .split('&')
        .filter_map(|pair| {
            let (pair_name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(pair_name) == name).then(|| decode(value))
        })
        .collect()
}

/// The address a request asked for, without its key or code: the same path, and the rest of its
/// query in its order. It is always a path on this server: one that starts with two slashes, or a
/// slash and a backslash, would read as another host.
fn without_key(uri: &Uri) -> String {
    let path = uri.path().trim_start_matches(['/', '\\']).replace('\\', "%5C");
    let rest: Vec<&str> = uri
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|pair| {
            !pair.is_empty()
                && values_in(Some(pair), key::PARAM).is_empty()
                && values_in(Some(pair), key::ONCE_PARAM).is_empty()
        })
        .collect();
    let mut to = format!("/{path}");
    if !rest.is_empty() {
        to = format!("{to}?{}", rest.join("&"));
    }
    to
}

/// True for a browser going to an address, as opposed to a script or a program asking for it.
fn navigates(request: &Request) -> bool {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return false;
    }
    match request.headers().get("sec-fetch-mode") {
        Some(mode) => mode == "navigate",
        // A browser too old to say so still asks for a page.
        None => wants_html(request.headers()),
    }
}

/// The answer that takes the key out of a browser's address: a page that goes on to `to` at once,
/// with the cookie that holds the key. It is not a redirect. A browser that came from a link on
/// another site sends no SameSite=Strict cookie on the redirect that follows, and the page there
/// would be refused. A refresh is the page's own step, which the cookie goes with, and it takes the
/// address with the key out of the history too.
fn landing(to: &str, set_cookie: Option<String>) -> Response {
    let to = escape_html(to);
    let html = format!(
        "<!doctype html>\n<meta charset=\"utf-8\">\n<meta name=\"color-scheme\" content=\"light dark\">\n\
         <meta http-equiv=\"refresh\" content=\"0; url={to}\">\n<title>okfs</title>\n<a href=\"{to}\">Continue</a>\n"
    );
    let mut response = (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::CONTENT_SECURITY_POLICY, "default-src 'none'"),
            // The next request would name this address, key and all.
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        html,
    )
        .into_response();
    if let Some(cookie) = set_cookie.and_then(|cookie| HeaderValue::from_str(&cookie).ok()) {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    response
}

/// What a request without the key gets: a page for a browser, a line for anything else. Either
/// says only that a key is needed, and nothing of what is served.
fn needs_key(headers: &HeaderMap) -> Response {
    let (kind, body) = if wants_html(headers) {
        ("text/html; charset=utf-8", NEEDS_KEY_PAGE)
    } else {
        ("text/plain; charset=utf-8", NEEDS_KEY_TEXT)
    };
    (
        StatusCode::UNAUTHORIZED,
        [
            (header::WWW_AUTHENTICATE, key::SCHEME),
            (header::CONTENT_TYPE, kind),
            (header::CACHE_CONTROL, "no-store"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'",
            ),
        ],
        body,
    )
        .into_response()
}

const NEEDS_KEY_TEXT: &str = "This link needs its key. Use an address okfs printed when it started: it ends in ?key=\n";

const NEEDS_KEY_PAGE: &str = r#"<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>okfs</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box;
    font: 15px/1.5 system-ui, sans-serif; background: #fbfbfa; color: #1b1b1a; }
  main { max-width: 26rem; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0; color: #5f5f5c; }
  code { font: 13px ui-monospace, monospace; }
  @media (prefers-color-scheme: dark) {
    body { background: #161616; color: #ececea; }
    p { color: #a3a3a0; }
  }
</style>
<main>
  <h1>This link needs its key</h1>
  <p>Open an address okfs printed when it started, which ends in <code>?key=</code>, or scan its code again. A key from
  an earlier start no longer works.</p>
</main>
</html>
"#;

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
    /// Send only the first entries by name, folders first. For a folder under the cursor.
    limit: Option<usize>,
    /// With `limit`: also send the listing of the folder the first entry is, and of the
    /// one under that, this many levels down. The page draws a column for each level,
    /// and they all come in this one answer.
    #[serde(default)]
    depth: usize,
    /// With `depth`: the entry each level goes into in place of its first, by name, one
    /// level after another, joined by `/`. The pointer picks them in the columns. A
    /// name that is not there, and a level past the last, goes into the first entry.
    #[serde(default)]
    follow: String,
    /// Send hidden entries too: see `Index::hides`.
    #[serde(default, deserialize_with = "query_flag")]
    all: bool,
}

/// Levels sent under a listing, at most.
const MAX_DEPTH: usize = 3;
/// Entries sent for each level when levels under it are asked for, at most.
const MAX_COLUMN: usize = 200;

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
    /// For a folder, how many entries it holds, hidden ones only when they were asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    c: Option<usize>,
    /// For a folder, how many hidden entries it holds, when they were not asked for.
    #[serde(skip_serializing_if = "is_zero")]
    h: usize,
}

#[derive(Serialize)]
struct Readme {
    name: String,
    html: String,
}

#[derive(Serialize)]
struct Listing {
    path: String,
    /// Where the folder really is, when a link was followed to reach it. Changes on
    /// disk are told by this path. Told with a whole listing only.
    #[serde(skip_serializing_if = "Option::is_none")]
    real: Option<String>,
    /// The path's last name is a link to this folder. A delete removes only the link.
    /// Told with a whole listing only, as the notes are.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    link: bool,
    /// The folder's own modified time, in seconds, as its entry in its parent has it.
    m: i64,
    /// In name order. The page sorts and filters from here.
    entries: Vec<Item>,
    /// The entries in the folder, past those sent, and none of those hidden.
    total: usize,
    /// The entries hidden from this listing: see `Index::hides`.
    #[serde(skip_serializing_if = "is_zero")]
    hidden: usize,
    readme: Option<Readme>,
    /// The listing of the first entry, when it is a folder and levels were asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    under: Option<Box<Listing>>,
}

fn is_zero(count: &usize) -> bool {
    *count == 0
}

/// The notes of the folder at `found`, when one of the names in it is a readme small
/// enough to show.
fn read_readme<'a>(found: &Resolved, names: impl IntoIterator<Item = &'a paths::Seen>) -> Option<Readme> {
    let entry = names
        .into_iter()
        .find(|entry| !entry.dir && render::is_readme(&entry.name))?;
    let at = found.abs.join(&entry.name);
    let small = fs::metadata(&at).is_ok_and(|meta| meta.len() <= MAX_README);
    let text = small.then(|| fs::read_to_string(&at).ok())??;
    Some(Readme {
        name: entry.name.clone(),
        html: render::markdown(&text, &found.rel),
    })
}

/// Lists the folder at `path`. With `limit`, only its first entries, and then the folder
/// the first of them is, or the one `follow` names, `depth` levels down: see `ListQuery`.
/// Without `all`, what the folder hides is left out, and so is it from each count.
fn list_folder(
    app: &App,
    path: &str,
    limit: Option<usize>,
    depth: usize,
    follow: &[&str],
    all: bool,
) -> Option<Listing> {
    let found = app.root.resolve(path).filter(|found| found.meta.is_dir())?;
    let mut seen = app.root.scan(&found.abs).ok()?;
    let rules = app.index.rules_in(&found.rel);
    let before = seen.len();
    if !all {
        seen.retain(|entry| !app.index.hides(&rules, &found.rel, &entry.name, entry.dir));
    }
    let hidden = before - seen.len();
    let total = seen.len();
    seen.sort_by(|a, b| paths::natural_cmp(&a.name, &b.name));
    if limit.is_some() {
        seen.sort_by_key(|entry| !entry.dir);
    }
    // The level below goes into the entry the page follows, even past the entries sent.
    let (followed, rest) = follow
        .split_first()
        .map_or((None, &[][..]), |(name, rest)| (Some(*name), rest));
    let into = followed
        .and_then(|name| seen.iter().find(|entry| entry.name == name))
        .or(seen.first())
        .filter(|entry| limit.is_some() && depth > 0 && entry.dir)
        .map(|entry| paths::join(&found.rel, &entry.name));
    if let Some(limit) = limit {
        seen.truncate(limit);
    }

    let readme = limit.is_none().then(|| read_readme(&found, &seen)).flatten();

    let entries: Vec<Item> = seen
        .into_iter()
        .filter_map(|entry| {
            let at = found.abs.join(&entry.name);
            let meta = fs::metadata(&at).ok()?;
            let modified = meta.modified().ok().and_then(|at| at.duration_since(UNIX_EPOCH).ok());
            let counts = entry
                .dir
                .then(|| app.index.counts(&paths::join(&found.rel, &entry.name), &rules))
                .flatten();
            let (shown, hidden) = match counts {
                Some((shown, hidden)) if all => (Some(shown + hidden), 0),
                Some((shown, hidden)) => (Some(shown), hidden),
                None => (None, 0),
            };
            Some(Item {
                n: entry.name,
                d: entry.dir,
                l: entry.link,
                s: if entry.dir { 0 } else { meta.len() },
                m: modified.map_or(0, |since| since.as_secs() as i64),
                c: shown,
                h: hidden,
            })
        })
        .collect();

    // Each level is found by its own path, as a request for it would be: what a
    // request may not read, a level may not either.
    let under = into
        .and_then(|into| list_folder(app, &into, limit, depth - 1, rest, all))
        .map(Box::new);

    let real = app
        .root
        .place(&found)
        .filter(|real| limit.is_none() && *real != found.rel);
    let modified = found
        .meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(UNIX_EPOCH).ok());
    Some(Listing {
        m: modified.map_or(0, |since| since.as_secs() as i64),
        real,
        link: limit.is_none() && app.root.entry(&found.rel).is_ok_and(|entry| entry.is_link()),
        path: found.rel,
        entries,
        total,
        hidden,
        readme,
        under,
    })
}

async fn list(State(app): State<Arc<App>>, Query(query): Query<ListQuery>) -> Response {
    let worker = Arc::clone(&app);
    let depth = query.depth.min(MAX_DEPTH);
    // A listing asked for with its levels is for columns: no column is this long.
    let limit = query
        .limit
        .map(|limit| if depth > 0 { limit.min(MAX_COLUMN) } else { limit });
    let work = move || {
        let follow: Vec<&str> = query.follow.split('/').filter(|name| !name.is_empty()).collect();
        list_folder(&worker, &query.path, limit, depth, &follow, query.all)
    };
    match tokio::task::spawn_blocking(work).await {
        Ok(Some(listing)) => Json(listing).into_response(),
        _ => not_found(),
    }
}

/// The changes to the served folder as they happen, as server-sent events, for as
/// long as the page listens. A `change` names a folder and the files written in it.
/// A `sync` says to read again whatever is on screen.
async fn events(State(app): State<Arc<App>>) -> Response {
    let told = app.index.feed().follow().map(|change| {
        let event = match change {
            Change::Folder { dir, files } => Event::default()
                .event("change")
                .data(serde_json::json!({ "dir": dir, "files": files }).to_string()),
            Change::Sync => Event::default().event("sync").data("{}"),
        };
        Ok::<_, Infallible>(event)
    });
    // One line goes out at once: a proxy may hold an answer back until it has a body.
    let hello = stream::once(async { Ok(Event::default().comment("okfs")) });
    let stream = Sse::new(hello.chain(told)).keep_alive(KeepAlive::new().interval(STREAM_BEAT));
    // The second header asks a proxy that buffers answers not to buffer this one.
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        stream,
    )
        .into_response()
}

/// Files previewed in one answer, at most.
const MAX_PREVIEWS: usize = 64;

/// Says that the reader has left when it is dropped, which is when the request is:
/// the page gave it up, or the answer was sent.
struct Gone(Arc<AtomicBool>);

impl Drop for Gone {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Builds the preview of one file. `None` when there is no such file.
async fn build_preview(app: &App, path: &str, form: preview::Form) -> Option<std::io::Result<preview::Preview>> {
    let found = app.root.resolve(path).filter(|found| found.meta.is_file())?;
    let size = found.meta.len();
    let gone = Gone(Arc::new(AtomicBool::new(false)));
    let flag = Arc::clone(&gone.0);
    let work = move || preview::of(&found.abs, &found.rel, size, form, &flag);
    Some(
        heavy(app, work)
            .await
            .unwrap_or_else(|| Err(std::io::Error::other("the work was dropped"))),
    )
}

/// The previews of files, by path: `?p=a.rs&p=b.rs`. A file that is missing or cannot be read is
/// left out. `lines=80` sends only the first 80 lines of source code: the page asks for a screen of
/// them first, and for the whole file once the cursor rests on it. `raw=1` sends each as it is
/// written, as source code, whatever the file is. The page asks for one file this way, and for
/// several at once for what lies ahead of a moving cursor.
async fn preview_many(State(app): State<Arc<App>>, uri: Uri) -> Response {
    let mut lines = None;
    let mut source = false;
    let mut paths = Vec::new();
    for pair in uri.query().unwrap_or("").split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode_str(&value.replace('+', " "))
            .decode_utf8_lossy()
            .into_owned();
        match name {
            "lines" => lines = value.parse().ok(),
            "raw" => match yes(&value) {
                Some(raw) => source = raw,
                None => return fail(StatusCode::BAD_REQUEST, "raw is not 1, true, 0 or false"),
            },
            "p" if paths.len() < MAX_PREVIEWS => paths.push(value),
            _ => {}
        }
    }
    let form = preview::Form { first: lines, source };
    let built = future::join_all(paths.iter().map(|path| build_preview(&app, path, form))).await;
    let previews: std::collections::BTreeMap<String, preview::Preview> = paths
        .into_iter()
        .zip(built)
        .filter_map(|(path, built)| Some((path, built?.ok()?)))
        .collect();
    Json(previews).into_response()
}

#[derive(Deserialize)]
struct PictureQuery {
    #[serde(default)]
    path: String,
    /// How wide, for a thumbnail. Without it, an image comes whole.
    w: Option<u32>,
}

/// A picture of a file: a thumbnail `w` wide, or without `w` the whole image, as a PNG or a JPEG. That
/// is how a format a browser cannot show, such as TIFF, is shown. A PDF's picture is its first page.
async fn picture(State(app): State<Arc<App>>, Query(query): Query<PictureQuery>) -> Response {
    let Some(found) = app.root.resolve(&query.path).filter(|found| found.meta.is_file()) else {
        return not_found();
    };
    let made = if pdf::is_pdf(std::path::Path::new(&found.rel)) && app.drawer.is_some() {
        match first_page(&app, found, query.w).await {
            // A PDF that cannot be drawn has no picture, which is an answer and not a fault: the page
            // shows it as it did before there were pictures, with nothing in the browser's console.
            // One that is damaged says so in a header, so that the page shows a card and never starts the
            // browser's viewer, whose own error dialog takes the keys.
            Some(Err(thumb::Refused::Unreadable(why))) if why == pdf::UNDRAWABLE => {
                return (StatusCode::NO_CONTENT, [(PDF_HEADER, "damaged")]).into_response();
            }
            Some(Err(_)) => return StatusCode::NO_CONTENT.into_response(),
            made => made,
        }
    } else if let Some(w) = query.w {
        let w = thumb::width(w);
        let worker = Arc::clone(&app);
        heavy(&app, move || worker.thumbs.get(&found.abs, w, &found.meta)).await
    } else {
        let worker = Arc::clone(&app);
        heavy(&app, move || worker.thumbs.picture(&found.abs, &found.meta)).await
    };
    made_response(made, if query.w.is_some() { "a thumbnail" } else { "a picture" })
}

fn made_response(made: Option<Result<thumb::Made, thumb::Refused>>, what: &str) -> Response {
    match made {
        Some(Ok(made)) => (
            [
                (header::CONTENT_TYPE, made.mime),
                (header::CACHE_CONTROL, "private, max-age=3600"),
            ],
            made.bytes,
        )
            .into_response(),
        Some(Err(thumb::Refused::TooLarge)) => fail(
            StatusCode::PAYLOAD_TOO_LARGE,
            &format!("the file is too large for {what}"),
        ),
        Some(Err(thumb::Refused::Unreadable(_))) => fail(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "not an image or a PDF this build can read",
        ),
        None => fail(StatusCode::INTERNAL_SERVER_ERROR, &format!("{what} could not be made")),
    }
}

/// The first page of a PDF as a picture, from the cache when it is there. Drawn in a
/// process of its own, which is ended when it takes too long: see `pdf`.
async fn first_page(
    app: &Arc<App>,
    found: Resolved,
    asked: Option<u32>,
) -> Option<Result<thumb::Made, thumb::Refused>> {
    let Some(drawer) = &app.drawer else {
        return Some(Err(thumb::Refused::Unreadable("PDFs are not drawn".to_owned())));
    };
    let w = pdf::width(asked.unwrap_or(pdf::WIDTHS[2]));
    let (worker, abs, meta) = (Arc::clone(app), found.abs.clone(), found.meta.clone());
    let kept = tokio::task::spawn_blocking(move || worker.thumbs.cached(&abs, w, &meta));
    if let Some(made) = kept.await.ok()? {
        return Some(Ok(made));
    }
    let modified = found.meta.modified().ok();
    let version = format!("{}\0{modified:?}\0{}", found.abs.display(), found.meta.len());
    let made = match drawer.first_page(&found.abs, found.meta.len(), w, &version).await {
        Ok(made) => made,
        Err(refused) => return Some(Err(refused)),
    };
    let worker = Arc::clone(app);
    tokio::task::spawn_blocking(move || {
        worker.thumbs.keep(&found.abs, w, &found.meta, &made);
        made
    })
    .await
    .ok()
    .map(Ok)
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: String,
    limit: Option<usize>,
    /// How many matches, in this order, come before the ones sent: the next page starts where the
    /// last one ended.
    offset: Option<usize>,
    #[serde(default)]
    sort: Order,
    /// Turns the order around.
    #[serde(default, deserialize_with = "query_flag")]
    rev: bool,
    /// Search hidden entries too: see `Index::hides`.
    #[serde(default, deserialize_with = "query_flag")]
    all: bool,
}

#[derive(Deserialize)]
struct RecentQuery {
    /// Hidden files too: see `Index::hides`.
    #[serde(default, deserialize_with = "query_flag")]
    all: bool,
}

async fn search(State(app): State<Arc<App>>, Query(query): Query<SearchQuery>) -> Response {
    let limit = query.limit.unwrap_or(60).min(200);
    let index = Arc::clone(&app.index);
    // A page asking for something else drops this request, and the search stops with it: it
    // takes no time from the search for what is asked now.
    let gone = Gone(Arc::new(AtomicBool::new(false)));
    let flag = Arc::clone(&gone.0);
    let page = Page {
        offset: query.offset.unwrap_or(0),
        limit,
        order: query.sort,
        reverse: query.rev,
    };
    match tokio::task::spawn_blocking(move || index.search_unless(&query.q, page, query.all, &flag)).await {
        Ok(Some(found)) => Json(found).into_response(),
        Ok(None) | Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "the search failed"),
    }
}

/// The files written last anywhere in the tree. Answered from the index, which holds
/// only what the search route may show and decides how many there are.
async fn recent(State(app): State<Arc<App>>, Query(query): Query<RecentQuery>) -> Response {
    let index = Arc::clone(&app.index);
    match tokio::task::spawn_blocking(move || index.recent(query.all)).await {
        Ok(recent) => Json(recent).into_response(),
        Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "the list could not be made"),
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

/// True when a change was asked for by okfs's own page, and not by a page on another
/// site that a visitor happens to have open. okfs has no accounts, so there is no
/// session to steal: what such a page could borrow is the visitor's place on the
/// network, the browser that can reach an address the page's own server cannot.
/// Three things together stop that.
///
/// - The request carries a header of okfs's own, `x-okfs`, whose value names the change:
///   `change`. A form cannot send it, and a delete's method is one no form has. A script
///   on another site can send them only after the browser has asked okfs for leave (a
///   preflight). okfs never gives it: it answers no OPTIONS request and sends no CORS header.
/// - The `Origin` header, which a browser sets on every DELETE, PUT and POST and a page cannot
///   change, has to name okfs itself. It passes the same rule as the Host of any
///   request (a plain address, `localhost`, or a name from `--allow-host`), so a
///   hostile name pointed at this machine fails even when okfs listens beyond
///   loopback. And it has to be the host this request came in on, or a name from
///   `--allow-host`: a proxy may put its own idea of the Host in front of okfs. The
///   scheme is not compared. A proxy in front ends TLS, so the browser says `https`
///   where okfs sees plain HTTP; the scheme only tells which port a bare name means.
/// - A missing `Origin` is refused, and so is `Origin: null`. The second is what a
///   served HTML or SVG file has, because okfs sends those sandboxed, so a file in
///   the folder can never delete or write its neighbours.
///
/// The error is what to answer. When a page did send the request, from a host okfs
/// does not know as its own, it names the `--allow-host` that would let it in.
fn own_page(headers: &HeaderMap, host: &str, allowed: &[String], change: &str) -> Result<(), String> {
    let not_the_page = || format!("only the okfs page itself can {change}");
    if headers.get(OWN_HEADER).is_none_or(|sent| sent != change) {
        return Err(not_the_page());
    }
    let mut origins = headers.get_all(header::ORIGIN).iter();
    let (Some(origin), None) = (origins.next(), origins.next()) else {
        return Err(not_the_page());
    };
    let origin = origin.to_str().unwrap_or("").to_ascii_lowercase();
    let Some((scheme, from)) = origin.split_once("://") else {
        return Err(not_the_page());
    };
    let default_port = match scheme {
        "http" => "80",
        "https" => "443",
        _ => return Err(not_the_page()),
    };
    let (from_name, from_port) = split_host(from);
    if from_name.is_empty() || from.contains(['/', '@', '?', '#']) {
        return Err(not_the_page());
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
        "the page at {from} is not one okfs knows as its own: to {change} from it, start okfs with --allow-host {from_name}"
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
        Err(Kept::Failed(error)) => disk_failed(&error),
        Err(Kept::Partly(error)) => {
            let message = format!("{}, and part of the folder may already be gone", error.kind());
            let answer = serde_json::json!({ "error": message, "partial": true });
            (disk_status(&error), Json(answer)).into_response()
        }
    }
}

/// The status to answer with when the disk refused a delete or a write.
fn disk_status(error: &std::io::Error) -> StatusCode {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => StatusCode::FORBIDDEN,
        ErrorKind::NotFound => StatusCode::NOT_FOUND,
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => StatusCode::INSUFFICIENT_STORAGE,
        ErrorKind::FileTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        ErrorKind::InvalidFilename => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// The answer to a write the disk refused. The kind reads as plain words, such as "no storage
/// space", and names no path.
fn disk_failed(error: &std::io::Error) -> Response {
    fail(disk_status(error), &error.kind().to_string())
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
    if let Err(why) = own_page(
        &headers,
        request_host(&headers, &uri),
        &app.options.allow_hosts,
        "delete",
    ) {
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

#[derive(Deserialize)]
struct WriteQuery {
    #[serde(default)]
    path: String,
    /// When the name is taken, take the first free one of `name (1)`, `name (2)` and so on in
    /// its place: "keep both".
    #[serde(default, deserialize_with = "query_flag")]
    keep: bool,
}

/// What a write of a file is for, as its headers say it.
enum Wanted {
    /// A new file, never over an entry that is there: `If-None-Match: *`.
    New,
    /// The file that is there, still the version with this tag: `If-Match`.
    Over(String),
}

/// An answer that refuses a write, boxed: it is carried back through several steps.
type Refused = Box<Response>;

/// What a write of a file is for. A write that says neither is refused, so that no write can
/// replace a file by chance.
fn wanted(headers: &HeaderMap) -> Result<Wanted, Refused> {
    let tag = |name| headers.get(name).map(|value| value.to_str().unwrap_or("").trim());
    match (tag(header::IF_NONE_MATCH), tag(header::IF_MATCH)) {
        (Some("*"), None) => Ok(Wanted::New),
        (None, Some(tag)) if !tag.is_empty() && tag != "*" => Ok(Wanted::Over(tag.to_owned())),
        (None, None) => Err(Box::new(fail(
            StatusCode::PRECONDITION_REQUIRED,
            "say what the write is for: If-None-Match: * adds a file, and If-Match with the file's tag replaces it",
        ))),
        _ => Err(Box::new(fail(
            StatusCode::BAD_REQUEST,
            "a write takes either If-None-Match: * or If-Match with one tag",
        ))),
    }
}

/// A file as a write answers with it: where it is, its tag, its size and its time.
#[derive(Serialize)]
struct Written {
    path: String,
    etag: String,
    s: u64,
    m: i64,
}

fn seconds(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_secs() as i64)
}

/// The answer to a write whose name is taken, or whose file is no longer the version it read.
/// It tells what is there now, when okfs shows it, so that the page can set the two side by
/// side: `d` for a folder, or a file's tag, size and time. `gone` when nothing is there now.
fn clash(app: &App, rel: &str, message: &str) -> Response {
    let mut answer = serde_json::json!({ "error": message });
    match app.root.resolve(rel) {
        Some(found) if found.meta.is_dir() => answer["d"] = true.into(),
        Some(found) => {
            answer["etag"] = raw::etag(&found.meta).into();
            answer["s"] = found.meta.len().into();
            answer["m"] = seconds(&found.meta).into();
        }
        None => {
            let gone = app
                .root
                .target(rel)
                .is_ok_and(|place| fs::symlink_metadata(place.abs()).is_err());
            if gone {
                answer["gone"] = true.into();
            }
        }
    }
    (StatusCode::PRECONDITION_FAILED, Json(answer)).into_response()
}

/// The answer to a write that is larger than `--max-upload`.
fn too_large(max: u64) -> Response {
    fail(
        StatusCode::PAYLOAD_TOO_LARGE,
        &format!("the file is larger than the {max} bytes --max-upload allows"),
    )
}

/// The answer to a path a write cannot go to.
fn no_place(why: NoEntry) -> Response {
    match why {
        NoEntry::Root => fail(StatusCode::BAD_REQUEST, "a write needs a name"),
        NoEntry::NotServed => fail(
            StatusCode::FORBIDDEN,
            "okfs does not write this name: it steps up, is hidden, or holds a control character",
        ),
        NoEntry::Missing => fail(StatusCode::NOT_FOUND, "there is no such folder"),
    }
}

/// Where a write goes, found before its body is read.
enum Aim {
    /// A new file, at `Place`, or with `keep` beside it under the first free name like it.
    New { place: Place, keep: bool },
    /// Over a file that is there: `abs` is where it really is, its link followed, and `rel` the
    /// path it was asked for by.
    Over { rel: String, abs: PathBuf, tag: String },
}

impl Aim {
    /// The folder the file is put together in: the one it goes in, so that it moves into place in
    /// one step.
    fn folder(&self) -> &std::path::Path {
        match self {
            Aim::New { place, .. } => &place.dir,
            Aim::Over { abs, .. } => abs.parent().unwrap_or(abs),
        }
    }
}

/// Finds where a write goes, and refuses it while it can be refused for nothing: a name that is
/// taken, a file that is no longer the version the page read, a path that is not served.
fn aim(app: &App, path: &str, wanted: Wanted, keep: bool) -> Result<Aim, Refused> {
    let refuse = |answer| Err(Box::new(answer));
    match wanted {
        Wanted::New => {
            let place = match app.root.target(path) {
                Ok(place) => place,
                Err(why) => return refuse(no_place(why)),
            };
            if !keep && fs::symlink_metadata(place.abs()).is_ok() {
                let message = format!("there is already an entry named {}", place.name);
                return refuse(clash(app, &place.rel, &message));
            }
            Ok(Aim::New { place, keep })
        }
        Wanted::Over(tag) => {
            // By the name its folder lists, as a delete finds it: a file system may answer to other
            // spellings of a name.
            match app.root.entry(path) {
                Ok(_) => {}
                Err(NoEntry::Missing) => return refuse(clash(app, path, "the file is no longer there")),
                Err(why) => return refuse(no_place(why)),
            }
            let rel = path
                .split('/')
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
                .join("/");
            let Some(found) = app.root.resolve(&rel) else {
                return refuse(clash(app, &rel, "the file is no longer there"));
            };
            if !found.meta.is_file() {
                return refuse(fail(StatusCode::CONFLICT, "this is a folder, not a file"));
            }
            if !raw::same_etag(&tag, &raw::etag(&found.meta)) {
                return refuse(clash(app, &rel, "the file changed since it was read"));
            }
            Ok(Aim::Over {
                rel,
                abs: found.abs,
                tag,
            })
        }
    }
}

/// Puts a file put together in `part` in place, as `aim` says, and tells the index and the pages.
fn commit(app: &App, aim: Aim, mut part: Part) -> Response {
    let (rel, abs, status) = match aim {
        Aim::New { place, keep } => {
            let made = if keep {
                part.create_free(&place.dir, &place.name)
            } else {
                part.create(&place.abs()).map(|()| place.name.clone())
            };
            match made {
                Ok(name) => (
                    paths::join(paths::parent(&place.rel), &name),
                    place.dir.join(name),
                    StatusCode::CREATED,
                ),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    return clash(
                        app,
                        &place.rel,
                        &format!("there is already an entry named {}", place.name),
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::Unsupported => {
                    return fail(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "this disk cannot add a file without a risk of replacing one",
                    );
                }
                Err(error) => return disk_failed(&error),
            }
        }
        Aim::Over { rel, abs, tag } => {
            // No other write from okfs comes between the check and the step that replaces.
            let held = app.locks.hold(&abs);
            match fs::metadata(&abs) {
                Ok(meta) if meta.is_file() && raw::same_etag(&tag, &raw::etag(&meta)) => {}
                _ => return clash(app, &rel, "the file changed since it was read"),
            }
            // A file whose permissions cannot be read or set is still written.
            let _ = part.permissions_of(&abs);
            if let Err(error) = part.replace(&abs) {
                return disk_failed(&error);
            }
            drop(held);
            (rel, abs, StatusCode::OK)
        }
    };
    if let Some(folder) = abs.parent() {
        write::sync_folder(folder);
    }
    app.index.wrote(&abs);
    let Ok(meta) = fs::metadata(&abs) else {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "the file was written and is gone");
    };
    let written = Written {
        path: rel,
        etag: raw::etag(&meta),
        s: meta.len(),
        m: seconds(&meta),
    };
    (status, Json(written)).into_response()
}

/// The size a request says its body is, when it says.
fn declared_length(headers: &HeaderMap) -> Option<u64> {
    headers.get(header::CONTENT_LENGTH)?.to_str().ok()?.parse().ok()
}

/// Writes one file: a new one with `If-None-Match: *` and `--allow-upload`, or over the one that is
/// there, still the version with the tag `If-Match` names, with `--allow-edit`. The body is the
/// file as it is, streamed to disk beside where it goes and moved into place whole: see `write`.
async fn put_file(
    State(app): State<Arc<App>>,
    query: Result<Query<WriteQuery>, QueryRejection>,
    headers: HeaderMap,
    uri: Uri,
    body: Body,
) -> Response {
    let wanted = match wanted(&headers) {
        Ok(wanted) => wanted,
        Err(refused) => return *refused,
    };
    match wanted {
        Wanted::New if !app.options.allow_upload => {
            return fail(
                StatusCode::FORBIDDEN,
                "adding files is off: start okfs with --allow-upload",
            );
        }
        Wanted::Over(_) if !app.options.allow_edit => {
            return fail(
                StatusCode::FORBIDDEN,
                "changing files is off: start okfs with --allow-edit",
            );
        }
        _ => {}
    }
    if let Err(why) = own_page(
        &headers,
        request_host(&headers, &uri),
        &app.options.allow_hosts,
        "write",
    ) {
        return fail(StatusCode::FORBIDDEN, &why);
    }
    let Ok(Query(query)) = query else {
        return fail(StatusCode::BAD_REQUEST, "the path cannot be read");
    };
    let max = app.options.max_upload;
    if let Some(max) = max
        && declared_length(&headers).is_some_and(|length| length > max)
    {
        return too_large(max);
    }
    let worker = Arc::clone(&app);
    let aimed = tokio::task::spawn_blocking(move || {
        let aim = aim(&worker, &query.path, wanted, query.keep)?;
        let part = Part::new(aim.folder()).map_err(|error| Box::new(disk_failed(&error)))?;
        Ok::<_, Refused>((aim, part))
    })
    .await;
    let (aim, mut part) = match aimed {
        Ok(Ok(aimed)) => aimed,
        Ok(Err(refused)) => return *refused,
        Err(_) => return fail(StatusCode::INTERNAL_SERVER_ERROR, "the write failed"),
    };

    // A request dropped part way drops the part with it, which removes it.
    let mut file = tokio::fs::File::from_std(part.take_file().expect("a fresh part"));
    let mut body = body.into_data_stream();
    let mut length: u64 = 0;
    while let Some(piece) = body.next().await {
        let Ok(piece) = piece else {
            return fail(StatusCode::BAD_REQUEST, "the file stopped coming before its end");
        };
        length += piece.len() as u64;
        if let Some(max) = max.filter(|max| length > *max) {
            return too_large(max);
        }
        if let Err(error) = file.write_all(&piece).await {
            return disk_failed(&error);
        }
    }
    if let Err(error) = file.sync_all().await {
        return disk_failed(&error);
    }
    drop(file);

    let worker = Arc::clone(&app);
    tokio::task::spawn_blocking(move || commit(&worker, aim, part))
        .await
        .unwrap_or_else(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "the write failed"))
}

/// Makes one folder, with `--allow-upload`, never over an entry that is there. A folder that is
/// uploaded is made this way, one level at a time, before the files in it.
async fn make_folder(
    State(app): State<Arc<App>>,
    query: Result<Query<WriteQuery>, QueryRejection>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !app.options.allow_upload {
        return fail(
            StatusCode::FORBIDDEN,
            "adding folders is off: start okfs with --allow-upload",
        );
    }
    if let Err(why) = own_page(
        &headers,
        request_host(&headers, &uri),
        &app.options.allow_hosts,
        "write",
    ) {
        return fail(StatusCode::FORBIDDEN, &why);
    }
    let Ok(Query(query)) = query else {
        return fail(StatusCode::BAD_REQUEST, "the path cannot be read");
    };
    let worker = Arc::clone(&app);
    let work = move || {
        let place = match worker.root.target(&query.path) {
            Ok(place) => place,
            Err(why) => return no_place(why),
        };
        match fs::create_dir(place.abs()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let message = format!("there is already an entry named {}", place.name);
                return clash(&worker, &place.rel, &message);
            }
            Err(error) => return disk_failed(&error),
        }
        write::sync_folder(&place.dir);
        worker.index.reread(&place.folder);
        (StatusCode::CREATED, Json(serde_json::json!({ "path": place.rel }))).into_response()
    };
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "the folder could not be made"))
}

/// A folder's `--index` file. A name `resolve` refuses is not one: a dotfile without
/// `--hidden`, or a link that leaves the served folder. Neither is a folder of that name.
fn index_page(app: &App, folder: &str) -> Option<Resolved> {
    let index = app.options.index.as_deref()?;
    app.root
        .resolve(&paths::join(folder, index))
        .filter(|found| found.meta.is_file())
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
    match raw::serve(found, &headers).await {
        Ok(response) => response,
        Err(_) => not_found(),
    }
}

/// `/raw/` is the served folder itself: its `--index` file, and without one the page as ever.
async fn raw_root(state: State<Arc<App>>, uri: Uri, headers: HeaderMap) -> Response {
    let Some(found) = index_page(&state, "") else {
        return page(state, uri, headers).await;
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
    if name == "brand.css" {
        return app.options.accent.as_deref().map(brand_css).map_or_else(not_found, css);
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
    /// True when adding files and folders is on: `--allow-upload`.
    upload: bool,
    /// True when changing the files that are there is on: `--allow-edit`.
    edit: bool,
    /// The largest file a write takes, in bytes, when `--max-upload` sets one.
    #[serde(skip_serializing_if = "Option::is_none")]
    max_upload: Option<u64>,
    /// The nonce this page's policy lets a style element in with, for the editor, which adds its
    /// own. Only while changing files is on.
    #[serde(skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    /// True when the first page of a PDF can be had as a picture from `/api/picture`.
    pdf: bool,
    /// True with `--hidden`: dotfiles are served, and a new visitor starts with hidden entries shown.
    hidden: bool,
    /// The key, when okfs asks for one, for the links the page hands out. Left out when it does not.
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<String>,
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

/// True when a request takes an HTML page: a browser's navigation always says so. curl and wget
/// send `*/*`, which is taken to mean the file itself.
fn wants_html(headers: &HeaderMap) -> bool {
    headers.get_all(header::ACCEPT).iter().any(|value| {
        value.to_str().unwrap_or("").split(',').any(|range| {
            let mut parts = range.split(';');
            let kind = parts.next().unwrap_or("").trim();
            let refused = parts.any(|param| {
                param
                    .split_once('=')
                    .is_some_and(|(name, q)| name.trim() == "q" && q.trim().parse::<f32>().is_ok_and(|q| q == 0.0))
            });
            kind.eq_ignore_ascii_case("text/html") && !refused
        })
    })
}

/// The page. Any path that is not one of the server's own gets it, and the page
/// then shows that path. A file's address asked for by anything but a browser, such as
/// curl or wget, answers with the file itself, as `/raw/` does.
async fn page(State(app): State<Arc<App>>, uri: Uri, headers: HeaderMap) -> Response {
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
    let found = match found {
        Some(file) if file.meta.is_file() && !wants_html(&headers) => {
            let mut response = raw::serve(file, &headers).await.unwrap_or_else(|_| not_found());
            response
                .headers_mut()
                .insert(header::VARY, HeaderValue::from_static("accept"));
            return response;
        }
        found => found,
    };

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
    // A page that can open the editor lets in style elements that carry this page's own nonce.
    let nonce = app.options.allow_edit.then(|| key::nonce().ok()).flatten();
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
        upload: app.options.allow_upload,
        edit: app.options.allow_edit,
        max_upload: app.options.max_upload,
        nonce: nonce.clone(),
        pdf: app.drawer.is_some(),
        hidden: app.root.hidden(),
        key: app.options.key.as_ref().map(|key| key.as_str().to_owned()),
    };
    // Inside a script element, only "<" could end the block early.
    let config = serde_json::to_string(&config)
        .expect("plain data")
        .replace('<', "\\u003c");

    let Some(shell) = assets::get("index.html") else {
        return fail(StatusCode::INTERNAL_SERVER_ERROR, "the page is missing from this build");
    };
    let extra = if app.options.accent.is_some() {
        "<link rel=\"stylesheet\" href=\"/assets/brand.css\">\n"
    } else {
        ""
    };
    let html = String::from_utf8_lossy(&shell.bytes)
        .replace(
            "<title>okfs</title>",
            &format!("<title>{}</title>", escape_html(&app.options.title)),
        )
        .replace("<!--okfs:css-->", extra)
        .replace("<!--okfs:config-->", &config);
    let mut policy = PAGE_POLICY.to_owned();
    if let Some(nonce) = &nonce {
        policy = policy.replace("style-src 'self'", &format!("style-src 'self' 'nonce-{nonce}'"));
    }
    if app.options.writes() {
        policy = format!("{policy}; {NO_FRAMING}");
    }
    (
        if missing { StatusCode::NOT_FOUND } else { StatusCode::OK },
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::CONTENT_SECURITY_POLICY, policy.as_str()),
            (header::VARY, "accept"),
        ],
        html,
    )
        .into_response()
}

/// Reading gets the page. Every other method is refused: no address of a file takes a write.
async fn page_or_refuse(state: State<Arc<App>>, method: Method, uri: Uri, headers: HeaderMap) -> Response {
    if method == Method::GET || method == Method::HEAD {
        page(state, uri, headers).await
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
