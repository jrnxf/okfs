//! okfs's index in a browser. The modules below are okfs's own files, compiled as they are. What
//! this file adds is the part of server.rs that turns a request into a call on the index, and a
//! few plain exports for JavaScript: JSON in, JSON out, through the module's memory.
//!
//! The folder the index walks is a WASI preopen that the page fills from memory, so the walk,
//! the left-out folders (`node_modules`, `.gitignore`), the search and the recent list are
//! okfs's code from top to bottom.

#![allow(dead_code)]

#[path = "../../../src/every.rs"]
mod every;
#[path = "../../../src/index.rs"]
mod index;
#[path = "../../../src/live.rs"]
mod live;
#[path = "../../../src/paths.rs"]
mod paths;
#[path = "../../../src/skip.rs"]
mod skip;

use std::cell::RefCell;
use std::fs;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use futures_util::{FutureExt, Stream, StreamExt};
use serde::{Deserialize, Serialize};

use index::{Index, Order, Page};
use live::Change;
use paths::{Resolved, Root};

struct Engine {
    root: Root,
    index: Arc<Index>,
    feed: Pin<Box<dyn Stream<Item = Change>>>,
}

thread_local! {
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
    static REPLY: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn with<T>(f: impl FnOnce(&Engine) -> T) -> T {
    ENGINE.with(|engine| f(engine.borrow().as_ref().expect("okfs_open first")))
}

/// Keeps the reply where JavaScript can read it: `okfs_reply_len` bytes at the pointer returned.
fn reply(value: &impl Serialize) -> *const u8 {
    REPLY.with(|cell| {
        let mut out = cell.borrow_mut();
        out.clear();
        serde_json::to_writer(&mut *out, value).expect("a reply is JSON");
        out.as_ptr()
    })
}

fn input<'a>(ptr: *const u8, len: usize) -> &'a str {
    // SAFETY: JavaScript wrote `len` bytes of UTF-8 at `ptr`, in memory from `okfs_alloc`.
    unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(ptr, len)) }
}

#[unsafe(no_mangle)]
pub extern "C" fn okfs_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn okfs_free(ptr: *mut u8, len: usize) {
    // SAFETY: `ptr` came from `okfs_alloc(len)`.
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) }
}

#[unsafe(no_mangle)]
pub extern "C" fn okfs_reply_len() -> usize {
    REPLY.with(|cell| cell.borrow().len())
}

/// Opens the served folder, an absolute path inside the preopen. Returns 0, or 1 when it is not a folder.
#[unsafe(no_mangle)]
pub extern "C" fn okfs_open(ptr: *const u8, len: usize) -> u32 {
    let dir = input(ptr, len);
    let Ok(root) = Root::new_canonical(Path::new(dir), false) else {
        return 1;
    };
    let index = Index::new(root.clone());
    let feed = Box::pin(index.feed().follow());
    ENGINE.with(|engine| *engine.borrow_mut() = Some(Engine { root, index, feed }));
    0
}

/// The first walk of the whole tree: `Index::build`, as okfs's index thread runs it.
#[unsafe(no_mangle)]
pub extern "C" fn okfs_build() {
    with(|e| e.index.build());
}

#[unsafe(no_mangle)]
pub extern "C" fn okfs_len() -> usize {
    with(|e| e.index.len())
}

/// What server.rs `SearchQuery` reads from the address, as JSON.
#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: String,
    limit: Option<usize>,
    offset: Option<usize>,
    #[serde(default)]
    sort: Order,
    rev: Option<u8>,
    all: Option<u8>,
}

/// `/api/search`, as server.rs `search` answers it.
#[unsafe(no_mangle)]
pub extern "C" fn okfs_search(ptr: *const u8, len: usize) -> *const u8 {
    let query: SearchQuery = serde_json::from_str(input(ptr, len)).expect("a search query");
    let limit = query.limit.unwrap_or(60).min(200);
    let page = Page {
        offset: query.offset.unwrap_or(0),
        limit,
        order: query.sort,
        reverse: query.rev.is_some(),
    };
    with(|e| reply(&e.index.search_page(&query.q, page, query.all.is_some())))
}

/// `/api/recent`.
#[unsafe(no_mangle)]
pub extern "C" fn okfs_recent(all: u32) -> *const u8 {
    with(|e| reply(&e.index.recent(all != 0)))
}

/// Reads one folder again after the page changed it, and returns what the feed told: the
/// `change` and `sync` events `/api/events` would send.
#[unsafe(no_mangle)]
pub extern "C" fn okfs_reread(ptr: *const u8, len: usize) -> *const u8 {
    let dir = input(ptr, len).to_owned();
    ENGINE.with(|engine| {
        let mut engine = engine.borrow_mut();
        let e = engine.as_mut().expect("okfs_open first");
        e.index.reread(&dir);
        let mut told = Vec::new();
        while let Some(Some(change)) = e.feed.next().now_or_never() {
            told.push(match change {
                Change::Folder { dir, files } => serde_json::json!({ "event": "change", "dir": dir, "files": files }),
                Change::Sync => serde_json::json!({ "event": "sync" }),
            });
        }
        reply(&told)
    })
}

// ---- `/api/list`: server.rs `list_folder`, with the readme and links left to the page. ----

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    path: String,
    limit: Option<usize>,
    #[serde(default)]
    depth: usize,
    #[serde(default)]
    follow: String,
    all: Option<u8>,
}

const MAX_DEPTH: usize = 3;
const MAX_COLUMN: usize = 200;

fn is_zero(count: &usize) -> bool {
    *count == 0
}

#[derive(Serialize)]
struct Item {
    n: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    d: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    l: bool,
    s: u64,
    m: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    c: Option<usize>,
    #[serde(skip_serializing_if = "is_zero")]
    h: usize,
}

#[derive(Serialize)]
struct Listing {
    path: String,
    m: i64,
    entries: Vec<Item>,
    total: usize,
    #[serde(skip_serializing_if = "is_zero")]
    hidden: usize,
    /// Filled by the page from what the real server answered for the same folder.
    readme: Option<()>,
    #[serde(skip_serializing_if = "Option::is_none")]
    under: Option<Box<Listing>>,
}

/// `Root::resolve` for a tree with no links: the same checks on the names, and no canonicalize.
fn resolve(root: &Root, request: &str) -> Option<Resolved> {
    let mut segments = Vec::new();
    for seg in request.split('/').filter(|seg| !seg.is_empty()) {
        if seg == "." || seg == ".." || seg.contains('\0') || seg.starts_with('.') {
            return None;
        }
        segments.push(seg);
    }
    let abs = root.dir().join(segments.join("/"));
    let meta = fs::metadata(&abs).ok()?;
    Some(Resolved {
        abs,
        rel: segments.join("/"),
        meta,
    })
}

fn list_folder(e: &Engine, path: &str, limit: Option<usize>, depth: usize, follow: &[&str], all: bool) -> Option<Listing> {
    let found = resolve(&e.root, path).filter(|found| found.meta.is_dir())?;
    let mut seen = e.root.scan(&found.abs).ok()?;
    let rules = e.index.rules_in(&found.rel);
    let before = seen.len();
    if !all {
        seen.retain(|entry| !e.index.hides(&rules, &found.rel, &entry.name, entry.dir));
    }
    let hidden = before - seen.len();
    let total = seen.len();
    seen.sort_by(|a, b| paths::natural_cmp(&a.name, &b.name));
    if limit.is_some() {
        seen.sort_by_key(|entry| !entry.dir);
    }
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

    let entries: Vec<Item> = seen
        .into_iter()
        .filter_map(|entry| {
            let at = found.abs.join(&entry.name);
            let meta = fs::metadata(&at).ok()?;
            let modified = meta.modified().ok().and_then(|at| at.duration_since(UNIX_EPOCH).ok());
            let counts = entry
                .dir
                .then(|| e.index.counts(&paths::join(&found.rel, &entry.name), &rules))
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

    let under = into
        .and_then(|into| list_folder(e, &into, limit, depth - 1, rest, all))
        .map(Box::new);
    let modified = found
        .meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(UNIX_EPOCH).ok());
    Some(Listing {
        m: modified.map_or(0, |since| since.as_secs() as i64),
        path: found.rel,
        entries,
        total,
        hidden,
        readme: None,
        under,
    })
}

/// `/api/list`. A folder that is not there answers `null`, where the server answers 404.
#[unsafe(no_mangle)]
pub extern "C" fn okfs_list(ptr: *const u8, len: usize) -> *const u8 {
    let query: ListQuery = serde_json::from_str(input(ptr, len)).expect("a list query");
    let depth = query.depth.min(MAX_DEPTH);
    let limit = query
        .limit
        .map(|limit| if depth > 0 { limit.min(MAX_COLUMN) } else { limit });
    let follow: Vec<&str> = query.follow.split('/').filter(|name| !name.is_empty()).collect();
    with(|e| reply(&list_folder(e, &query.path, limit, depth, &follow, query.all.is_some())))
}
