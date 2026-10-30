//! Every name in the served tree, held in memory for the palette's search, with the
//! time each file was last written. One walk at start builds it; a file watcher keeps
//! it fresh after that. The same watcher is what open pages follow: every change it
//! reads is told to the feed. With `Follow::Rescan` there is no watcher, and the whole
//! tree is walked again on a timer instead.
//!
//! Some folders are left out (see `skip`): they are listed in their folder, but what is
//! inside is not walked, not searched, and not kept up by the watcher.

use std::cmp::Reverse;
use std::collections::{BTreeSet, BinaryHeap, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, RwLock, RwLockWriteGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::event::{EventKind, ModifyKind};
use notify::{RecursiveMode, Watcher};
use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::{Deserialize, Serialize};

use crate::every;
use crate::live::{Change, Feed};
use crate::paths::{self, Resolved, Root};
use crate::skip::{self, Rules, Skip};

/// How long the tree must be quiet before changes are read.
const SETTLE: Duration = Duration::from_millis(150);
/// The longest a busy tree can delay a read.
const MAX_WAIT: Duration = Duration::from_secs(2);
/// The least time between walks of the whole tree when no watcher could be set up.
const POLL: Duration = Duration::from_secs(30);
/// Without a watcher, a walk of the whole tree takes at most one part in this many of the time,
/// so a tree that takes minutes to read is not read over and over.
const POLL_SHARE: u32 = 20;
/// A match on the name itself outranks a match somewhere in the path.
const NAME_BONUS: u32 = 64;
/// How many files are listed as the ones written last.
const RECENT: usize = 8;
/// How much the first walk gathers before the search can see it, and the longest it keeps it back.
const FLUSH: Flush = Flush {
    entries: 2000,
    every: Duration::from_millis(200),
};
/// How many left-out folders a batch can name before the pages are told to read everything again.
const QUIET: usize = 8;

#[derive(Clone, Copy)]
struct Flush {
    entries: usize,
    every: Duration,
}

/// What an entry is, in one byte, so a node stays as small as it was.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    /// A link to a file in the served folder. It has its file's time and size.
    FileLink,
    /// A real folder that the walk goes into.
    Folder,
    /// A folder the walk does not go into: a link to one, or one that is left out.
    Unwalked,
}

struct Node {
    /// Where its name ends in `Folder::names`. It starts where the name before it ends.
    end: u32,
    /// The name is plain ASCII, which the search can look through a byte at a time.
    ascii: bool,
    kind: Kind,
    /// A listing hides it until hidden entries are asked for: see `Index::hides`.
    hidden: bool,
    /// When a file was last written, in seconds. Zero for a folder, and for a time that
    /// could not be read. Kept as 32 bits so a node stays as small as it was.
    modified: u32,
}

impl Node {
    fn dir(&self) -> bool {
        matches!(self.kind, Kind::Folder | Kind::Unwalked)
    }

    /// A real folder, not a link to one: the walk goes in.
    fn walk(&self) -> bool {
        self.kind == Kind::Folder
    }
}

/// One folder's entries, laid out for the search: the names side by side in one string, read in
/// one sweep, in place of a string apiece scattered over memory.
struct Folder {
    nodes: Vec<Node>,
    names: String,
    /// Each file's size in bytes, beside the nodes rather than in them: the search reads every
    /// node and no size, and only sorts and pages by them. Zero for a folder.
    sizes: Vec<u64>,
    /// It is inside a hidden folder: see `in_hidden`.
    hidden: bool,
    /// Its path is plain ASCII: see `Node::ascii`.
    ascii: bool,
}

impl Folder {
    fn new(dir: &str, entries: impl IntoIterator<Item = (String, Node, u64)>) -> Self {
        let mut folder = Self {
            nodes: Vec::new(),
            names: String::new(),
            sizes: Vec::new(),
            hidden: in_hidden(dir),
            ascii: dir.is_ascii(),
        };
        for (name, node, size) in entries {
            folder.sizes.push(size);
            folder.names.push_str(&name);
            let end = u32::try_from(folder.names.len()).expect("a folder's names fit in 4 GB");
            folder.nodes.push(Node {
                end,
                ascii: name.is_ascii(),
                ..node
            });
        }
        folder.names.shrink_to_fit();
        folder.sizes.shrink_to_fit();
        folder
    }

    fn len(&self) -> usize {
        self.nodes.len()
    }

    /// The name of the entry at `at`.
    fn name(&self, at: usize) -> &str {
        let start = at.checked_sub(1).map_or(0, |before| self.nodes[before].end as usize);
        &self.names[start..self.nodes[at].end as usize]
    }

    /// Each entry with its name.
    fn entries(&self) -> impl Iterator<Item = (&str, &Node)> {
        (0..self.len()).map(|at| (self.name(at), &self.nodes[at]))
    }

    /// All that a listing tells of each entry.
    fn shapes(&self) -> impl Iterator<Item = (&str, bool, bool, bool)> {
        self.entries().map(|(name, n)| (name, n.dir(), n.walk(), n.hidden))
    }
}

#[derive(Default)]
struct Tree {
    /// Folder path to its children. The served folder itself is the empty path.
    dirs: HashMap<Arc<str>, Folder>,
    count: usize,
    /// Goes up with every change to what is searched: see `Index::change`.
    version: u64,
}

/// What a search matched, kept so the next one can look only there when its query adds to this
/// one's: every entry that matches the longer query matches this one too.
struct Last {
    query: String,
    all: bool,
    /// The `Tree::version` it searched.
    version: u64,
    /// Each folder with a match, and how many it has. Where each one is in its folder is in
    /// `ats`, folder after folder.
    dirs: Vec<(Arc<str>, u32)>,
    ats: Vec<u32>,
}

/// How the index keeps up with the tree after the first walk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Follow {
    /// A file watcher tells of each change as it happens.
    Watch,
    /// No watcher: the whole tree is walked again this often. For a tree too big to
    /// watch, or one a watcher cannot see change, such as a network share that other
    /// machines write to.
    Rescan(Duration),
}

pub struct Index {
    root: Root,
    skip: Skip,
    tree: RwLock<Tree>,
    ready: AtomicBool,
    feed: Feed,
    /// Called after each walk of the whole tree that is not the first.
    rescanned: OnceLock<Box<dyn Fn() + Send + Sync>>,
    last: Mutex<Option<Last>>,
    /// The links to files, by the file each leads to, so that a file written is stamped again
    /// under its links too. A link that is gone or leads elsewhere is let go when its file is
    /// next written.
    links: Mutex<HashMap<PathBuf, HashSet<PathBuf>>>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Hit {
    pub path: String,
    pub dir: bool,
    /// Which characters matched, counted in characters.
    pub idx: Vec<u32>,
    /// True when `idx` counts into the name, false when into the whole path.
    pub name: bool,
    /// When a file was last written, in seconds. Zero for a folder, and for a time
    /// that could not be read.
    pub m: u32,
    /// A file's size in bytes. Zero for a folder.
    pub s: u64,
    /// For a folder, how many entries a listing of it shows: hidden ones only when they are searched.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub c: Option<usize>,
}

/// The order a search hands its matches back in. Each but the first puts its natural end first:
/// names from A, the largest and the newest first.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Order {
    /// The best match first.
    #[default]
    Rank,
    Name,
    /// By the folder a match is in, then by its name.
    Folder,
    Size,
    Time,
}

/// Which of the matches a search hands back: `limit` of them, after the first `offset`, in `order`,
/// turned around when `reverse` is set. The best match always comes first in `Order::Rank`.
#[derive(Debug, Clone, Copy)]
pub struct Page {
    pub offset: usize,
    pub limit: usize,
    pub order: Order,
    pub reverse: bool,
}

impl Page {
    /// The best `limit` matches.
    pub fn first(limit: usize) -> Self {
        Self {
            offset: 0,
            limit,
            order: Order::Rank,
            reverse: false,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Found {
    pub hits: Vec<Hit>,
    /// How many entries matched, of which `hits` holds the best.
    pub total: usize,
    pub indexed: usize,
    pub ready: bool,
    /// How long the search took here, in milliseconds. The page shows it.
    pub took: f64,
}

/// One file among the most recently written.
#[derive(Debug, Serialize, PartialEq)]
pub struct Changed {
    pub path: String,
    /// When it was last written, in seconds.
    pub m: u32,
}

#[derive(Debug, Serialize)]
pub struct Recent {
    /// Newest first. Files with the same time are ordered by folder, then by name.
    pub files: Vec<Changed>,
}

impl Index {
    /// An empty index. Call `build` to fill it.
    pub fn new(root: Root) -> Arc<Self> {
        let skip = Skip::new(root.dir());
        Self::with_skip(root, skip)
    }

    fn with_skip(root: Root, skip: Skip) -> Arc<Self> {
        Arc::new(Self {
            root,
            skip,
            tree: RwLock::default(),
            ready: AtomicBool::new(false),
            feed: Feed::default(),
            rescanned: OnceLock::new(),
            last: Mutex::new(None),
            links: Mutex::default(),
        })
    }

    /// Starts the first walk, and what follows the tree after it, on their own thread and
    /// returns at once.
    pub fn spawn(root: Root, follow: Follow) -> Arc<Self> {
        let index = Self::new(root);
        let worker = Arc::clone(&index);
        std::thread::Builder::new()
            .name("okfs-index".to_owned())
            .spawn(move || match follow {
                Follow::Watch => worker.watch(),
                Follow::Rescan(every) => {
                    worker.build();
                    worker.rescan(every, |_| every);
                }
            })
            .expect("the index thread starts");
        index
    }

    /// Sets what to do after each walk of the whole tree that is not the first. Only the
    /// first call counts.
    pub fn after_rescan(&self, then: impl Fn() + Send + Sync + 'static) {
        let _ = self.rescanned.set(Box::new(then));
    }

    /// Walks the whole tree again and again, for good. `wait` is the time before the first
    /// walk, and `next` gives the time before each one after it from how long the last took.
    fn rescan(&self, mut wait: Duration, next: impl Fn(Duration) -> Duration) -> ! {
        loop {
            std::thread::sleep(wait);
            let started = Instant::now();
            self.rebuild();
            if let Some(then) = self.rescanned.get() {
                then();
            }
            wait = next(started.elapsed());
        }
    }

    fn watch(&self) {
        let (send, events) = mpsc::channel();
        // The watcher reads the whole tree to set itself up, left-out folders too, which on Linux
        // takes about as long as the first walk. They go at once, so the count climbs from the start.
        let began = SystemTime::now();
        let started = Instant::now();
        let top = self.root.dir().to_path_buf();
        let setup = std::thread::Builder::new()
            .name("okfs-watch".to_owned())
            .spawn(move || {
                // The watcher goes where the walk goes: into real folders, and through no link.
                let config = notify::Config::default().with_follow_symlinks(false);
                notify::RecommendedWatcher::new(send, config).and_then(|mut watcher| {
                    watcher.watch(&top, RecursiveMode::Recursive)?;
                    Ok(watcher)
                })
            })
            .expect("the watcher thread starts");
        self.build();
        let took = started.elapsed();
        let watcher = setup.join().expect("the watcher thread ends");
        let _watcher = match watcher {
            Ok(watcher) => watcher,
            Err(error) => {
                let wait = poll_wait(took);
                eprintln!(
                    "okfs: cannot watch the folder for changes ({error}). Reading all of it again every {} \
                     instead: every {}, or {POLL_SHARE} times as long as one read takes when that is longer. \
                     To choose how often, start okfs with --rescan, such as --rescan 6h",
                    every::spoken(wait),
                    every::spoken(POLL)
                );
                self.rescan(wait, poll_wait);
            }
        };

        self.catch_up(began);

        while let Ok(first) = events.recv() {
            let started = Instant::now();
            let mut batch = vec![first];
            while started.elapsed() < MAX_WAIT {
                match events.recv_timeout(SETTLE) {
                    Ok(event) => batch.push(event),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            self.absorb(batch);
        }
    }

    /// Reads again each folder that changed since `since`. The first walk and the watcher
    /// start together, so a folder can change after it was read and before it was watched:
    /// no event tells of that, and its time does. A write to a file that was already read is
    /// not caught, and the file's time here stays as it was until the next write.
    fn catch_up(&self, since: SystemTime) {
        // A file system may keep times to the second or two.
        let since = since.checked_sub(Duration::from_secs(2)).unwrap_or(since);
        let held: Vec<Arc<str>> = self.tree.read().expect("the index lock").dirs.keys().cloned().collect();
        for dir in held {
            let written = fs::metadata(self.root.dir().join(&*dir)).and_then(|meta| meta.modified());
            if written.is_ok_and(|written| written < since) {
                continue;
            }
            self.reread(&dir);
        }
    }

    /// The changes to the served folder, for the pages that are open.
    pub fn feed(&self) -> &Feed {
        &self.feed
    }

    /// Walks the whole served folder. The first time, what is found is put in the index
    /// as it is found, so the search works on a part of the tree while the rest is read.
    /// Later it replaces the index with what it finds.
    pub fn build(&self) {
        self.fill(FLUSH, || {});
    }

    /// `build`, with `flushed` called each time the first walk has handed the search more.
    fn fill(&self, flush: Flush, mut flushed: impl FnMut()) {
        if self.ready() {
            let fresh = self.walk("");
            let mut tree = self.change();
            tree.dirs = fresh.dirs;
            tree.count = fresh.count;
            return;
        }
        let mut gathered = Tree::default();
        let mut last = Instant::now();
        let mut hand_over = |gathered: &mut Tree| {
            let more = std::mem::take(gathered);
            let mut tree = self.change();
            tree.count += more.count;
            tree.dirs.extend(more.dirs);
            drop(tree);
            flushed();
        };
        self.walk_with("", |dir, folder| {
            gathered.count += folder.len();
            gathered.dirs.insert(dir.into(), folder);
            if gathered.count >= flush.entries || last.elapsed() >= flush.every {
                hand_over(&mut gathered);
                last = Instant::now();
            }
        });
        hand_over(&mut gathered);
        self.ready.store(true, Ordering::Release);
    }

    fn walk(&self, from: &str) -> Tree {
        let mut tree = Tree::default();
        self.walk_with(from, |dir, folder| {
            tree.count += folder.len();
            tree.dirs.insert(dir.into(), folder);
        });
        tree
    }

    /// Reads `from` and every folder under it that is not left out, the nearest first, and
    /// hands each folder's names to `take`. Nothing is read of a folder that is left out.
    fn walk_with(&self, from: &str, mut take: impl FnMut(String, Folder)) {
        let Some(rules) = self.skip.rules_for(self.root.dir(), from) else {
            return;
        };
        let mut todo = VecDeque::from([(from.to_owned(), rules)]);
        while let Some((dir, rules)) = todo.pop_front() {
            let Some(folder) = self.read(&dir, &rules) else {
                continue;
            };
            for (name, _) in folder.entries().filter(|(_, n)| n.walk()) {
                let inside = paths::join(&dir, name);
                let rules = self.skip.enter(&self.root.dir().join(&inside), false, &rules);
                todo.push_back((inside, rules));
            }
            take(dir, folder);
        }
    }

    /// The names in the folder `dir`, when it is not left out.
    fn open(&self, dir: &str) -> Option<Folder> {
        self.read(dir, &self.skip.rules_for(self.root.dir(), dir)?)
    }

    /// Whether the folder `dir`, or one above it, is left out of the index.
    fn left_out(&self, dir: &str) -> bool {
        self.skip.rules_for(self.root.dir(), dir).is_none()
    }

    /// The names in one folder, each file with the time and size the disk has for it now.
    /// `rules` are those inside the folder: a folder they leave out is listed, and is not walked.
    fn read(&self, dir: &str, rules: &Rules) -> Option<Folder> {
        let at = self.root.dir().join(dir);
        let seen = self.root.scan(&at).ok()?;
        let entries = seen.into_iter().map(|s| {
            let stamp = if s.dir { None } else { self.root.stamp(&at, &s.name) };
            let modified = seconds(stamp.and_then(|stamp| stamp.modified));
            if s.link && !s.dir {
                let link = at.join(&s.name);
                if let Ok(file) = link.canonicalize() {
                    self.links
                        .lock()
                        .expect("the links lock")
                        .entry(file)
                        .or_default()
                        .insert(link);
                }
            }
            let left_out = s.dir && self.skip.skips(rules, &at, dir.is_empty(), &s.name);
            let node = Node {
                end: 0,
                ascii: false,
                kind: match (s.dir, s.link || left_out) {
                    (true, false) => Kind::Folder,
                    (true, true) => Kind::Unwalked,
                    (false, false) => Kind::File,
                    (false, true) => Kind::FileLink,
                },
                hidden: left_out || s.name.starts_with('.'),
                modified,
            };
            (s.name, node, stamp.map_or(0, |stamp| stamp.size))
        });
        Some(Folder::new(dir, entries))
    }

    /// Walks everything again and tells the pages to do the same.
    fn rebuild(&self) {
        self.build();
        self.feed.tell(Change::Sync);
    }

    /// Folds what the watcher saw into the index and tells the pages.
    fn absorb(&self, batch: Vec<notify::Result<notify::Event>>) {
        let mut dirty = HashSet::new();
        let mut touched = HashSet::new();
        // Paths whose content may have changed, with no name changing.
        let mut written = HashSet::new();
        // A folder that came into place brought what it holds with it, and no event names that.
        let mut arrived = BTreeSet::new();
        // Folders that are left out, and so not in the index, that something changed in.
        let mut quiet = BTreeSet::new();
        for event in batch {
            let Ok(event) = event else {
                return self.rebuild();
            };
            if event.need_rescan() {
                return self.rebuild();
            }
            if matches!(event.kind, EventKind::Access(_)) {
                continue;
            }
            // A write changes no name: the index reads the file's time again and no folder.
            let wrote = matches!(
                event.kind,
                EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_))
            );
            // A folder comes into place by being made or by being given its name.
            let placed = matches!(
                event.kind,
                EventKind::Any | EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_))
            );
            for path in event.paths {
                let dir = self.dir_of(&path);
                // Nothing in a folder that is left out is kept: the pages are told, the index is not.
                if let Some(dir) = dir.as_ref().filter(|dir| self.left_out(dir)) {
                    quiet.insert(dir.clone());
                    touched.insert(path);
                    continue;
                }
                // A rule changed: what the folder holds is read again under the new rules.
                if let Some(dir) = dir.as_ref()
                    && is_rule_file(dir, &path)
                {
                    arrived.insert(dir.clone());
                }
                if wrote {
                    written.insert(path.clone());
                } else if let Some(dir) = dir {
                    dirty.insert(dir);
                }
                if placed {
                    arrived.extend(self.shown_folder(&path));
                }
                touched.insert(path);
            }
        }

        // The files that were written, by folder. Only what a listing shows is named.
        let mut told: HashMap<String, Vec<String>> = HashMap::new();
        for path in &touched {
            if let Some(dir) = self.dir_of(path)
                && let Some(name) = self.shown_file(path)
            {
                told.entry(dir).or_default().push(name);
            }
        }
        // Under a name the index already holds, it still holds the folder that was there before.
        // They come in order, a folder before what is under it, which its walk reads too.
        let mut walked: Vec<&str> = Vec::new();
        for dir in &arrived {
            let under =
                |above: &&str| above.is_empty() || dir.strip_prefix(*above).is_some_and(|rest| rest.starts_with('/'));
            if !walked.iter().any(under) && self.walk_again(dir) {
                walked.push(dir);
            }
        }
        for dir in dirty {
            if self.refresh(&dir) {
                told.entry(dir).or_default();
            }
        }
        // The index is whole before a page is told: what it asks next is answered from it.
        self.restamp(written);
        // A page open on a folder that is left out hears of it like any other, unless a great
        // many changed at once: then it is told to read again, as it is for a folder that came.
        let mut sync = !arrived.is_empty();
        if quiet.len() > QUIET {
            told.retain(|dir, _| !quiet.contains(dir));
            sync = true;
        } else {
            for dir in quiet {
                told.entry(dir).or_default();
            }
        }
        for (dir, files) in told {
            self.feed.tell(Change::Folder { dir, files });
        }
        if sync {
            self.feed.tell(Change::Sync);
        }
    }

    /// Reads the time and size of each written file again, the way `read` does, and writes
    /// them into the index: one look at the disk per file, however often it was written to
    /// since the last batch.
    fn restamp(&self, mut written: HashSet<PathBuf>) {
        let through = self.links_to(&written);
        written.extend(through);
        let mut stamps: HashMap<String, HashMap<String, (u32, u64)>> = HashMap::new();
        for path in written {
            let (Some(dir), Some(name)) = (self.dir_of(&path), path.file_name().and_then(|name| name.to_str())) else {
                continue;
            };
            let stamp = self.root.stamp(&self.root.dir().join(&dir), name);
            let time = seconds(stamp.and_then(|stamp| stamp.modified));
            let size = stamp.map_or(0, |stamp| stamp.size);
            stamps.entry(dir).or_default().insert(name.to_owned(), (time, size));
        }
        if stamps.is_empty() {
            return;
        }
        // A time and a size are not searched: what the last search found still stands.
        let mut tree = self.tree.write().expect("the index lock");
        for (dir, stamps) in stamps {
            let Some(folder) = tree.dirs.get_mut(dir.as_str()) else {
                continue;
            };
            for at in 0..folder.len() {
                if let Some(&(time, size)) = stamps.get(folder.name(at)).filter(|_| !folder.nodes[at].dir()) {
                    folder.nodes[at].modified = time;
                    folder.sizes[at] = size;
                }
            }
        }
    }

    /// The links that led to the files `written`, when they were read. Those that no longer do are let go.
    fn links_to(&self, written: &HashSet<PathBuf>) -> Vec<PathBuf> {
        let mut links = self.links.lock().expect("the links lock");
        let mut through = Vec::new();
        for file in written {
            let Some(found) = links.get_mut(file) else { continue };
            // Each is stamped again even so: one whose file was removed has no time now.
            through.extend(found.iter().cloned());
            found.retain(|link| link.canonicalize().is_ok_and(|target| target == *file));
            if found.is_empty() {
                links.remove(file);
            }
        }
        through
    }

    /// What a changed path is now, when a listing shows it.
    fn shown(&self, path: &Path) -> Option<Resolved> {
        let inner = path.strip_prefix(self.root.dir()).ok()?;
        let rel = inner.to_str()?.replace(std::path::MAIN_SEPARATOR, "/");
        self.root.resolve(&rel)
    }

    /// The indexed folder a changed path sits in, by its real place, or `None` when
    /// it is not shown.
    fn dir_of(&self, path: &Path) -> Option<String> {
        self.root.place(&self.shown(path.parent()?)?)
    }

    /// The name of a changed path, when it is a file that a listing shows.
    fn shown_file(&self, path: &Path) -> Option<String> {
        let found = self.shown(path).filter(|found| found.meta.is_file())?;
        Some(paths::file_name(&found.rel).to_owned())
    }

    /// The real place of a changed path, when it is now a folder that a listing shows.
    /// A link to a folder is not one.
    fn shown_folder(&self, path: &Path) -> Option<String> {
        if !fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir()) {
            return None;
        }
        self.root.place(&self.shown(path)?)
    }

    /// Reads one folder again, folds what changed into the index and tells the pages.
    /// The watcher does this by itself a moment later; a delete calls it so the entry
    /// is gone at once.
    pub fn reread(&self, dir: &str) {
        // A folder that is left out is not in the index, and its pages still want to know.
        if self.refresh(dir) || self.left_out(dir) {
            self.feed.tell(Change::Folder {
                dir: dir.to_owned(),
                files: Vec::new(),
            });
        }
    }

    /// Folds a file that okfs itself just wrote into the index, its name, time and size, and tells
    /// the pages, with the file named as written. The watcher does this by itself a moment later,
    /// and not at all under `--rescan`; a write calls it so every page sees the file at once.
    pub fn wrote(&self, file: &Path) {
        let Some(dir) = self.dir_of(file) else {
            return;
        };
        self.refresh(&dir);
        self.restamp(HashSet::from([file.to_owned()]));
        let files = self.shown_file(file).into_iter().collect();
        self.feed.tell(Change::Folder { dir, files });
    }

    /// Reads one folder again and folds what changed into the index. True when the
    /// folder does not list what it listed before.
    fn refresh(&self, dir: &str) -> bool {
        let Some(folder) = self.open(dir) else {
            return self.forget(dir);
        };
        let known: HashSet<String> = {
            let tree = self.tree.read().expect("the index lock");
            match tree.dirs.get(dir) {
                Some(old) => old
                    .entries()
                    .filter(|(_, n)| n.walk())
                    .map(|(name, _)| name.to_owned())
                    .collect(),
                // Not indexed yet: its parent's reread will walk it.
                None if !dir.is_empty() => return false,
                None => HashSet::new(),
            }
        };
        let now: HashSet<&str> = folder
            .entries()
            .filter(|(_, n)| n.walk())
            .map(|(name, _)| name)
            .collect();
        let added: Vec<Tree> = now
            .iter()
            .filter(|name| !known.contains(**name))
            .map(|name| self.walk(&paths::join(dir, name)))
            .collect();
        let gone: Vec<String> = known
            .iter()
            .filter(|name| !now.contains(name.as_str()))
            .map(|name| paths::join(dir, name))
            .collect();

        let mut tree = self.change();
        for path in gone {
            tree.remove(&path);
        }
        for sub in added {
            tree.count += sub.count;
            tree.dirs.extend(sub.dirs);
        }
        tree.count += folder.len();
        let Some(old) = tree.dirs.insert(dir.into(), folder) else {
            return true;
        };
        tree.count -= old.len();
        let now = &tree.dirs[dir];
        let before: HashSet<(&str, bool, bool, bool)> = old.shapes().collect();
        old.len() != now.len() || now.shapes().any(|shape| !before.contains(&shape))
    }

    /// Walks one folder again with everything under it, in place of what the index
    /// held of it, and tells the pages. For a folder that changed at more than one
    /// depth: `reread` looks at one folder only.
    pub fn rewalk(&self, dir: &str) {
        // It changed at depths no single folder names.
        if self.walk_again(dir) || self.left_out(dir) {
            self.feed.tell(Change::Sync);
        }
    }

    /// Walks one folder again with everything under it, in place of what the index
    /// held of it. False when the index does not hold it.
    fn walk_again(&self, dir: &str) -> bool {
        // Not indexed yet: its parent's reread will walk it.
        if self.child_count(dir).is_none() {
            return false;
        }
        // Walking a folder that is now left out finds nothing, and so drops what was held of it.
        let fresh = self.walk(dir);
        let mut tree = self.change();
        if !tree.dirs.contains_key(dir) {
            return false;
        }
        tree.remove(dir);
        tree.count += fresh.count;
        tree.dirs.extend(fresh.dirs);
        true
    }

    /// Drops a folder that is gone. True when the index held it.
    fn forget(&self, dir: &str) -> bool {
        let mut tree = self.change();
        let held = tree.dirs.contains_key(dir);
        tree.remove(dir);
        held
    }

    /// The tree, to change. Each change gives it a new version, so a search knows whether what
    /// the last one found is still there.
    fn change(&self) -> RwLockWriteGuard<'_, Tree> {
        let mut tree = self.tree.write().expect("the index lock");
        tree.version += 1;
        tree
    }

    pub fn ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    pub fn len(&self) -> usize {
        self.tree.read().expect("the index lock").count
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// How many entries a folder holds, when the index has seen it.
    pub fn child_count(&self, dir: &str) -> Option<usize> {
        let tree = self.tree.read().expect("the index lock");
        tree.dirs.get(dir).map(Folder::len)
    }

    /// The rules inside the folder `dir`, as `hides` takes them.
    pub fn rules_in(&self, dir: &str) -> Rules {
        self.skip.rules_in(self.root.dir(), dir)
    }

    /// The rules inside the folder `abs`, which is in a folder with the rules `up`.
    pub fn enter(&self, abs: &Path, up: &Rules) -> Rules {
        self.skip.enter(abs, false, up)
    }

    /// Whether a listing of the folder `dir` hides its entry `name` until hidden entries
    /// are asked for: a dotfile, which is there at all only with `--hidden`, or a folder
    /// that is left out, such as `node_modules`. `rules` are those inside `dir`.
    pub fn hides(&self, rules: &Rules, dir: &str, name: &str, is_dir: bool) -> bool {
        name.starts_with('.') || is_dir && self.skip.skips(rules, &self.root.dir().join(dir), dir.is_empty(), name)
    }

    /// How many entries the folder `dir` holds that a listing shows without hidden
    /// entries, and how many it hides: see `hides`. `up` are the rules inside the folder
    /// that holds it. Counted in memory when the index holds the folder, and on the disk
    /// when not.
    pub fn counts(&self, dir: &str, up: &Rules) -> Option<(usize, usize)> {
        let split = |hidden: usize, all: usize| Some((all - hidden, hidden));
        if let Some(folder) = self.tree.read().expect("the index lock").dirs.get(dir) {
            return split(folder.nodes.iter().filter(|n| n.hidden).count(), folder.len());
        }
        let abs = self.root.dir().join(dir);
        let seen = self.root.scan(&abs).ok()?;
        let rules = self.skip.enter(&abs, false, up);
        split(
            seen.iter().filter(|s| self.hides(&rules, dir, &s.name, s.dir)).count(),
            seen.len(),
        )
    }

    /// The files written last, newest first. Read from memory: the disk is not looked
    /// at. Folders never appear, and neither does a file whose time is unknown. Nor does a link:
    /// the file it leads to is listed under its own name.
    /// Without `all`, neither does a hidden one: see `hides`.
    pub fn recent(&self, all: bool) -> Recent {
        let tree = self.tree.read().expect("the index lock");
        // Newer is greater, and of two with the same time the earlier folder, then the
        // earlier name, is greater.
        // The heap keeps the `RECENT` greatest, its least on top.
        let mut best = BinaryHeap::with_capacity(RECENT + 1);
        for (dir, folder) in tree.dirs.iter().filter(|(_, folder)| all || !folder.hidden) {
            for (name, node) in folder
                .entries()
                .filter(|(_, n)| n.kind == Kind::File && n.modified != 0 && (all || !n.hidden))
            {
                best.push(Reverse((node.modified, Reverse(&**dir), Reverse(name))));
                if best.len() > RECENT {
                    best.pop();
                }
            }
        }
        let mut files: Vec<_> = best.into_iter().map(|Reverse(key)| key).collect();
        files.sort_unstable_by(|a, b| b.cmp(a));
        Recent {
            files: files
                .into_iter()
                .map(|(m, Reverse(dir), Reverse(name))| Changed {
                    path: paths::join(dir, name),
                    m,
                })
                .collect(),
        }
    }

    /// Fuzzy search over every path. Returns the best `limit` matches. Without `all`,
    /// what a listing hides is not searched: see `hides`.
    pub fn search(&self, query: &str, limit: usize, all: bool) -> Found {
        self.search_page(query, Page::first(limit), all)
    }

    /// `search`, for one page of the matches in any order.
    pub fn search_page(&self, query: &str, page: Page, all: bool) -> Found {
        self.search_unless(query, page, all, &AtomicBool::new(false))
            .expect("a search no one stops")
    }

    /// `search_page`, given up as soon as `gone` is set: by a page that asked for something else
    /// before the answer came, and so no longer waits for it. `None` when it was given up.
    pub fn search_unless(&self, query: &str, page: Page, all: bool, gone: &AtomicBool) -> Option<Found> {
        let began = Instant::now();
        let tree = self.tree.read().expect("the index lock");
        let mut found = Found {
            hits: Vec::new(),
            total: 0,
            indexed: tree.count,
            ready: self.ready(),
            took: 0.0,
        };
        let query = query.trim();
        if query.is_empty() || page.limit == 0 {
            return Some(found);
        }
        // In rank order the best matches up to the end of the page are all that is needed. Any
        // other order needs every match, to sort.
        let limit = match page.order {
            Order::Rank => page.offset.saturating_add(page.limit),
            _ => usize::MAX,
        };
        let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
        let last = self.last.lock().expect("the search lock").take();
        let last = last.filter(|last| last.all == all && last.version == tree.version && narrows(&last.query, query));
        let parts: Vec<Part> = match &last {
            Some(last) => {
                let mut ats = last.ats.as_slice();
                last.dirs
                    .iter()
                    .map(|(dir, count)| {
                        let (dir, folder) = tree.dirs.get_key_value(&**dir).expect("a folder of the same version");
                        let here;
                        (here, ats) = ats.split_at(*count as usize);
                        (dir, folder, Some(here))
                    })
                    .collect()
            }
            None => tree
                .dirs
                .iter()
                .filter(|(_, folder)| all || !folder.hidden)
                .map(|(dir, folder)| (dir, folder, None))
                .collect(),
        };
        let close = Close::new(&pattern);
        let mut look = Look {
            pattern: &pattern,
            all,
            limit,
            keep: can_narrow(query),
            close: close.as_ref(),
        };
        let mut finds = scan_all(&look, &parts, gone)?;
        // Nothing sits close: what was passed over is all there is, and is looked at after all.
        if finds.closes == 0 && finds.passed > 0 {
            look.close = None;
            finds = scan_all(&look, &parts, gone)?;
        }
        // When most folders hold a match, looking only there would save little next time, and
        // cost more to keep than it saves.
        if look.keep && finds.dirs.len() * 2 < tree.dirs.len() {
            *self.last.lock().expect("the search lock") = Some(Last {
                query: query.to_owned(),
                all,
                version: tree.version,
                dirs: finds
                    .dirs
                    .iter()
                    .map(|&(part, count)| (Arc::clone(parts[part].0), count))
                    .collect(),
                ats: finds.ats,
            });
        }
        // Letters spread over a whole path are a match of last resort: they only show when nothing is closer.
        let (mut scored, total) = if finds.closes > 0 {
            (finds.close, finds.closes)
        } else {
            (finds.loose, finds.looses)
        };
        found.total = total;
        if page.order == Order::Rank {
            best(&mut scored, limit);
            scored.sort_by(rank);
        } else {
            // Ties keep the order of rank, so a page never shuffles against the next.
            scored.sort_by(|a, b| {
                let by = ordered(page.order, a, b);
                if page.reverse { by.reverse() } else { by }.then_with(|| rank(a, b))
            });
        }

        let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
        let mut chars = Vec::new();
        for hit in scored.into_iter().skip(page.offset).take(page.limit) {
            let path = paths::join(hit.dir, hit.name);
            let mut idx = Vec::new();
            let hay = if hit.by_name { hit.name } else { path.as_str() };
            pattern.indices(Utf32Str::new(hay, &mut chars), &mut matcher, &mut idx);
            idx.sort_unstable();
            idx.dedup();
            found.hits.push(Hit {
                c: hit.folder.then(|| tree.shown_in(&path, all)).flatten(),
                path,
                dir: hit.folder,
                idx,
                name: hit.by_name,
                m: hit.modified,
                s: hit.size,
            });
        }
        found.took = (began.elapsed().as_secs_f64() * 1e4).round() / 10.0;
        Some(found)
    }
}

/// The time between walks of the whole tree, without a watcher, when one takes `took`.
fn poll_wait(took: Duration) -> Duration {
    took.saturating_mul(POLL_SHARE).max(POLL)
}

/// Whether `path`, in the folder `dir`, is a file of rules for what the index leaves out.
fn is_rule_file(dir: &str, path: &Path) -> bool {
    match path.file_name().and_then(|name| name.to_str()) {
        Some(".gitignore") => true,
        Some(skip::OWN) => dir.is_empty(),
        _ => false,
    }
}

/// Whether the folder `dir` is inside a hidden one. The index walks into a dotfile's
/// folder with `--hidden`, and never into one that is left out.
fn in_hidden(dir: &str) -> bool {
    dir.split('/').any(|name| name.starts_with('.'))
}

/// A time as the index keeps it: whole seconds, with zero for one that is not known.
fn seconds(time: Option<SystemTime>) -> u32 {
    time.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| u32::try_from(since.as_secs()).unwrap_or(u32::MAX))
}

/// Whether a query's matches can be kept for the next query to narrow: see `narrows`.
fn can_narrow(query: &str) -> bool {
    !query.contains(['!', '\\', '^', '$', '\''])
}

/// Whether every entry that `next` matches is one that `last` matched. True when `next` only adds
/// to `last`: each word of `last` is then a word of `next` or the start of one, and a word that
/// holds another word's letters in order matches wherever that word does. A word of `next` may
/// even be marked to match only as a run, at the start or at the end: it still holds the letters.
/// Not when `last` itself marks a word, such as `!pdf`: adding to that can match more.
fn narrows(last: &str, next: &str) -> bool {
    can_narrow(last) && next.starts_with(last)
}

/// One folder to search: its path, its entries, and which of them, or all of them for `None`.
type Part<'t> = (&'t Arc<str>, &'t Folder, Option<&'t [u32]>);

/// One match.
struct Scored<'t> {
    score: u32,
    dir: &'t str,
    name: &'t str,
    /// It is a folder.
    folder: bool,
    /// Where the entry is in its folder.
    at: u32,
    /// Whether the name itself matched, and not only the whole path.
    by_name: bool,
    /// Whether its letters sit close together: see `score`.
    close: bool,
    /// See `Node::modified`.
    modified: u32,
    /// See `Folder::sizes`.
    size: u64,
}

/// Best score first; ties go to the shorter path, then by name, so results never shuffle.
fn rank(a: &Scored, b: &Scored) -> std::cmp::Ordering {
    (b.score.cmp(&a.score))
        .then_with(|| (a.dir.len() + a.name.len()).cmp(&(b.dir.len() + b.name.len())))
        .then_with(|| (a.dir, a.name).cmp(&(b.dir, b.name)))
}

/// Two matches in `order`, its natural end first. Names are compared without regard to case.
fn ordered(order: Order, a: &Scored, b: &Scored) -> std::cmp::Ordering {
    fn fold(text: &str) -> impl Iterator<Item = u8> + '_ {
        text.bytes().map(|byte| byte.to_ascii_lowercase())
    }
    let folded = |a: &str, b: &str| fold(a).cmp(fold(b));
    let names = || folded(a.name, b.name);
    match order {
        Order::Rank => std::cmp::Ordering::Equal,
        Order::Name => names(),
        Order::Folder => folded(a.dir, b.dir).then_with(names),
        Order::Size => b.size.cmp(&a.size),
        Order::Time => b.modified.cmp(&a.modified),
    }
}

/// Keeps the `limit` best of `hits`, in no order.
fn best(hits: &mut Vec<Scored>, limit: usize) {
    if hits.len() > limit {
        hits.select_nth_unstable_by(limit - 1, rank);
        hits.truncate(limit);
    }
}

/// What a search found in some of the folders. Only the best few matches are held, so what a
/// search holds does not grow with how many entries match.
#[derive(Default)]
struct Finds<'t> {
    /// The best matches whose letters sit close together, and the best of the rest. At least the
    /// `limit` best of each are here.
    close: Vec<Scored<'t>>,
    loose: Vec<Scored<'t>>,
    /// How many of each there are in all.
    closes: usize,
    looses: usize,
    /// How many matches were passed over unscored: see `Close`.
    passed: usize,
    /// When asked for: each folder with a match, by its place in the parts, and how many it
    /// has. Where each one is in its folder is in `ats`, folder after folder.
    dirs: Vec<(usize, u32)>,
    ats: Vec<u32>,
}

impl<'t> Finds<'t> {
    /// Notes where a match is, when asked to.
    fn found(&mut self, part: usize, at: u32, keep: bool) {
        if keep {
            match self.dirs.last_mut() {
                Some((last, count)) if *last == part => *count += 1,
                _ => self.dirs.push((part, 1)),
            }
            self.ats.push(at);
        }
    }

    /// A match passed over unscored.
    fn pass(&mut self, part: usize, at: usize, keep: bool) {
        self.found(part, at as u32, keep);
        self.passed += 1;
    }

    fn add(&mut self, part: usize, hit: Scored<'t>, limit: usize, keep: bool) {
        self.found(part, hit.at, keep);
        let (held, count) = if hit.close {
            (&mut self.close, &mut self.closes)
        } else {
            (&mut self.loose, &mut self.looses)
        };
        *count += 1;
        held.push(hit);
        // Cut back now and then, not on every match.
        if held.len() >= limit.saturating_mul(2).max(256) {
            best(held, limit);
        }
    }

    /// Adds what `more` found, which comes after what is here.
    fn extend(&mut self, more: Finds<'t>) {
        self.close.extend(more.close);
        self.loose.extend(more.loose);
        self.closes += more.closes;
        self.looses += more.looses;
        self.passed += more.passed;
        self.dirs.extend(more.dirs);
        self.ats.extend(more.ats);
    }
}

/// About how many entries a thread is handed at a time.
const SHARE: usize = 4096;

/// How a search looks through the folders.
struct Look<'p> {
    pattern: &'p Pattern,
    /// Look at what a listing hides too.
    all: bool,
    /// How many of the best matches are wanted.
    limit: usize,
    /// Keep where each match is, for the next search to narrow: see `Last`.
    keep: bool,
    /// Pass over each match whose letters cannot sit close together: see `Close`.
    close: Option<&'p Close>,
}

/// What `parts` hold that matches, searched on as many threads as the machine has cores.
/// `None` when `gone` is set first.
fn scan_all<'t>(look: &Look, parts: &[Part<'t>], gone: &AtomicBool) -> Option<Finds<'t>> {
    // Cut into runs of whole folders of about `SHARE` entries each.
    let mut runs = Vec::new();
    let (mut start, mut held) = (0, 0);
    for (at, (_, folder, ats)) in parts.iter().enumerate() {
        held += ats.map_or(folder.len(), <[u32]>::len);
        if held >= SHARE {
            runs.push(start..at + 1);
            (start, held) = (at + 1, 0);
        }
    }
    if start < parts.len() {
        runs.push(start..parts.len());
    }
    // Asking can mean reading files of the system's, so it is asked once.
    static CORES: LazyLock<usize> = LazyLock::new(|| std::thread::available_parallelism().map_or(1, usize::from));
    let threads = CORES.min(runs.len());
    let next = std::sync::atomic::AtomicUsize::new(0);
    let work = || {
        let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
        let mut done = Vec::new();
        loop {
            let at = next.fetch_add(1, Ordering::Relaxed);
            let Some(run) = runs.get(at).filter(|_| !gone.load(Ordering::Relaxed)) else {
                break done;
            };
            let mut finds = Finds::default();
            scan(look, parts, run.clone(), &mut matcher, &mut finds);
            done.push((at, finds));
        }
    };
    let mut done = std::thread::scope(|scope| {
        let helpers: Vec<_> = (1..threads).map(|_| scope.spawn(work)).collect();
        let mut done = work();
        for helper in helpers {
            done.extend(helper.join().expect("a search thread ends"));
        }
        done
    });
    if gone.load(Ordering::Relaxed) {
        return None;
    }
    done.sort_unstable_by_key(|(at, _)| *at);
    let mut finds = Finds::default();
    for (_, more) in done {
        finds.extend(more);
    }
    Some(finds)
}

/// What the parts in `run` hold that matches, on this thread.
fn scan<'t>(
    look: &Look,
    parts: &[Part<'t>],
    run: std::ops::Range<usize>,
    matcher: &mut Matcher,
    finds: &mut Finds<'t>,
) {
    let Look {
        pattern,
        all,
        limit,
        keep,
        close,
    } = *look;
    let (mut chars, mut path, mut idx) = (Vec::new(), String::new(), Vec::new());
    let needles = needles(pattern);
    // How much of each needle a folder's path holds, when it is plain ASCII: see `prefix_held`.
    let mut held = Vec::new();
    let mut look = |part: usize, held: Option<&[usize]>, reach: Option<Reach>, at: usize| {
        let (dir, folder, _) = parts[part];
        let (name, node) = (folder.name(at), &folder.nodes[at]);
        // Before the matcher, a quick look for the letters in order, which every match needs.
        let (mut by_name, mut by_path) = (true, true);
        if node.ascii {
            let bytes = name.as_bytes();
            by_name = needles.iter().all(|needle| holds(bytes, needle));
            if let Some(held) = held.filter(|_| !by_name) {
                by_path = needles
                    .iter()
                    .zip(held)
                    .all(|(needle, &held)| holds(bytes, &needle[held..]));
            }
            // Those letters in order are a match here. One whose letters cannot sit close is passed over.
            let reach = if by_name {
                Some(Reach::START)
            } else {
                reach.filter(|_| by_path)
            };
            if let (Some(close), Some(reach)) = (close, reach)
                && !close.can(close.read(reach, bytes))
            {
                finds.pass(part, at, keep);
                return;
            }
        }
        let hit = |score, by_name, close| Scored {
            score,
            dir,
            name,
            folder: node.dir(),
            at: at as u32,
            by_name,
            close,
            modified: node.modified,
            size: folder.sizes[at],
        };
        if by_name && let Some((score, close)) = score(pattern, name, &mut idx, &mut chars, matcher) {
            finds.add(part, hit(score + NAME_BONUS, true, close), limit, keep);
            return;
        }
        if dir.is_empty() || !by_path {
            return;
        }
        path.clear();
        path.push_str(dir);
        path.push('/');
        path.push_str(name);
        if let Some((score, close)) = score(pattern, &path, &mut idx, &mut chars, matcher) {
            finds.add(part, hit(score, false, close), limit, keep);
        }
    };
    for part in run {
        let (dir, folder, ats) = parts[part];
        held.clear();
        let path = [dir.as_bytes(), b"/"];
        held.extend(needles.iter().map(|needle| prefix_held(&path, needle)));
        let plain = !dir.is_empty() && folder.ascii;
        let held = plain.then_some(held.as_slice());
        let reach = close
            .filter(|_| plain)
            .map(|close| close.read(close.read(Reach::START, dir.as_bytes()), b"/"));
        match ats {
            Some(ats) => {
                for &at in ats {
                    look(part, held, reach, at as usize);
                }
            }
            None => {
                for at in (0..folder.len()).filter(|&at| all || !folder.nodes[at].hidden) {
                    look(part, held, reach, at);
                }
            }
        }
    }
}

/// For a query of one plain word, which matches whenever its letters are in a name or path in
/// order: a quick way to tell where those letters cannot sit close together (see `score`). Such a
/// match is one of last resort, so it can be passed over unscored while anything closer is found.
struct Close {
    /// For each ASCII byte, the letters of the word it is, in lower case, as bits.
    letters: [u64; 128],
    /// The bit of the word's last letter.
    last: u64,
}

/// How far `Close` got through a name or path read so far.
#[derive(Clone, Copy)]
struct Reach {
    /// The letters of the word that can be the last byte read, each with all before it close.
    ends: u64,
    /// The letters that can be any byte read so far, each with all before it close.
    any: u64,
    /// The next byte starts a word.
    word: bool,
}

impl Reach {
    const START: Reach = Reach {
        ends: 0,
        any: 0,
        word: true,
    };
}

impl Close {
    fn new(pattern: &Pattern) -> Option<Self> {
        let [atom] = pattern.atoms.as_slice() else {
            return None;
        };
        let Utf32Str::Ascii(word) = atom.needle_text() else {
            return None;
        };
        if atom.negative || atom.kind != AtomKind::Fuzzy || word.is_empty() || word.len() > 64 {
            return None;
        }
        let mut letters = [0; 128];
        for (at, &byte) in word.iter().enumerate() {
            letters[usize::from(byte)] |= 1 << at;
        }
        Some(Self {
            letters,
            last: 1 << (word.len() - 1),
        })
    }

    /// Reads on through `hay`, which is plain ASCII. A letter is close when it follows the one
    /// before it, or starts a word with the one before it anywhere earlier.
    fn read(&self, mut reach: Reach, hay: &[u8]) -> Reach {
        for &byte in hay {
            let from = (reach.ends << 1) | if reach.word { (reach.any << 1) | 1 } else { 0 };
            reach.ends = self.letters[usize::from(byte.to_ascii_lowercase())] & from;
            reach.any |= reach.ends;
            reach.word = !byte.is_ascii_alphanumeric();
        }
        reach
    }

    /// Whether every letter of the word can sit close in what was read.
    fn can(&self, reach: Reach) -> bool {
        reach.any & self.last != 0
    }
}

/// The letters every match of `pattern` holds in order, word by word: a word that has to be
/// there, in plain ASCII. The matcher compares such a word to plain ASCII with case ignored.
fn needles(pattern: &Pattern) -> Vec<&[u8]> {
    pattern
        .atoms
        .iter()
        .filter(|atom| !atom.negative)
        .filter_map(|atom| match atom.needle_text() {
            Utf32Str::Ascii(needle) => Some(needle),
            Utf32Str::Unicode(_) => None,
        })
        .collect()
}

/// Whether `hay` holds the letters of `needle` in order, case ignored. `needle` is in lower case.
fn holds(hay: &[u8], needle: &[u8]) -> bool {
    prefix_held(&[hay], needle) == needle.len()
}

/// How many of the first letters of `needle` the pieces of `hay`, one after the other, hold in
/// order, case ignored. Taking each letter as early as it comes holds the most, so `hay` followed
/// by more holds `needle` exactly when the more holds the letters left.
fn prefix_held(hay: &[&[u8]], needle: &[u8]) -> usize {
    let mut held = 0;
    for piece in hay {
        for &byte in *piece {
            match needle.get(held) {
                Some(&want) if byte.to_ascii_lowercase() == want => held += 1,
                Some(_) => {}
                None => return held,
            }
        }
    }
    held
}

/// The score of `hay` when it matches, and whether its matched letters sit close together: each
/// one either follows the one before it or starts a word. A query found as a run, or as the starts
/// of words, is close; letters picked out of the middle of several words are not.
fn score(
    pattern: &Pattern,
    hay: &str,
    idx: &mut Vec<u32>,
    chars: &mut Vec<char>,
    matcher: &mut Matcher,
) -> Option<(u32, bool)> {
    idx.clear();
    let score = pattern.indices(Utf32Str::new(hay, chars), matcher, idx)?;
    idx.sort_unstable();
    idx.dedup();
    let close = |starts_word: &dyn Fn(usize) -> bool| {
        let mut last = None;
        idx.iter().all(|&i| {
            let i = i as usize;
            let ok = last.is_some_and(|l| i == l + 1) || i == 0 || starts_word(i - 1);
            last = Some(i);
            ok
        })
    };
    let close = if hay.is_ascii() {
        close(&|before| hay.as_bytes().get(before).is_some_and(|b| !b.is_ascii_alphanumeric()))
    } else {
        let letters: Vec<char> = hay.chars().collect();
        close(&|before| letters.get(before).is_some_and(|c| !c.is_alphanumeric()))
    };
    Some((score, close))
}

impl Tree {
    /// How many entries a listing of the folder at `path` shows, when the index holds it: hidden
    /// ones only with `all`.
    fn shown_in(&self, path: &str, all: bool) -> Option<usize> {
        let folder = self.dirs.get(path)?;
        Some(folder.nodes.iter().filter(|node| all || !node.hidden).count())
    }

    /// Drops a folder and everything under it.
    fn remove(&mut self, dir: &str) {
        let mut todo = vec![dir.to_owned()];
        while let Some(dir) = todo.pop() {
            let Some(folder) = self.dirs.remove(dir.as_str()) else {
                continue;
            };
            self.count -= folder.len();
            todo.extend(
                folder
                    .entries()
                    .filter(|(_, n)| n.walk())
                    .map(|(name, _)| paths::join(&dir, name)),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::pin::Pin;

    use futures_util::{FutureExt, Stream, StreamExt};
    use notify::Event;
    use notify::event::{CreateKind, DataChange, RemoveKind, RenameMode};

    use super::*;

    /// A served folder beside one it must not tell of, an index of it, and a page listening.
    struct Watched {
        _tmp: tempfile::TempDir,
        served: PathBuf,
        outside: PathBuf,
        index: Arc<Index>,
        page: Pin<Box<dyn Stream<Item = Change>>>,
    }

    const CREATE: EventKind = EventKind::Create(CreateKind::File);
    const WRITE: EventKind = EventKind::Modify(ModifyKind::Data(DataChange::Any));
    const REMOVE: EventKind = EventKind::Remove(RemoveKind::File);

    impl Watched {
        fn new(hidden: bool) -> Self {
            Self::with(hidden, |_| {})
        }

        /// A served folder as `new` makes it, with what `setup` adds to it before the first walk.
        fn with(hidden: bool, setup: impl FnOnce(&Path)) -> Self {
            let tmp = tempfile::TempDir::new().unwrap();
            let top = tmp.path().canonicalize().unwrap();
            let (served, outside) = (top.join("served"), top.join("outside"));
            fs::create_dir_all(served.join("sub")).unwrap();
            fs::create_dir_all(&outside).unwrap();
            fs::write(served.join("a.txt"), "a").unwrap();
            fs::write(served.join("sub/b.txt"), "b").unwrap();
            fs::write(outside.join("secret.txt"), "secret").unwrap();
            setup(&served);
            let index = Index::new(Root::new(&served, hidden).unwrap());
            index.build();
            let page = Box::pin(index.feed().follow());
            Self {
                _tmp: tmp,
                served,
                outside,
                index,
                page,
            }
        }

        /// Hands the index what a watcher would have seen in one batch.
        fn see(&mut self, events: &[(EventKind, &str)]) -> Vec<Change> {
            let batch = events
                .iter()
                .map(|(kind, path)| Ok(Event::new(*kind).add_path(self.served.join(path))))
                .collect();
            self.index.absorb(batch);
            self.told()
        }

        /// What the page was told since the last look.
        fn told(&mut self) -> Vec<Change> {
            let mut told = Vec::new();
            while let Some(Some(change)) = self.page.next().now_or_never() {
                told.push(change);
            }
            told
        }
    }

    fn folder(dir: &str, files: &[&str]) -> Change {
        Change::Folder {
            dir: dir.to_owned(),
            files: files.iter().map(|name| (*name).to_owned()).collect(),
        }
    }

    /// A served folder that leaves some folders out: a project with a `.gitignore`, one with
    /// `node_modules` and no rules at all, and a folder named in the `.okfsignore`.
    fn with_folders_left_out() -> Watched {
        Watched::with(false, |served| {
            for dir in ["dist/deep", "app/node_modules/left-pad", "photos/raw", "photos/edited"] {
                fs::create_dir_all(served.join(dir)).unwrap();
            }
            for file in [
                "dist/bundle.js",
                "dist/deep/chunk.js",
                "app/main.rs",
                "app/node_modules/left-pad/index.js",
                "photos/raw/frame.cr3",
                "photos/edited/frame.jpg",
            ] {
                fs::write(served.join(file), "x").unwrap();
            }
            fs::write(served.join(".gitignore"), "dist\n").unwrap();
            fs::write(served.join(".okfsignore"), "photos/raw\n").unwrap();
        })
    }

    fn sorted(mut told: Vec<Change>) -> Vec<String> {
        told.sort_by_key(|change| format!("{change:?}"));
        told.iter().map(|change| format!("{change:?}")).collect()
    }

    fn found(index: &Index, query: &str) -> Vec<String> {
        index
            .search(query, 20, true)
            .hits
            .into_iter()
            .map(|hit| hit.path)
            .collect()
    }

    #[test]
    fn what_a_gitignore_names_is_not_searched_and_its_folder_is_still_listed() {
        let site = with_folders_left_out();
        assert!(found(&site.index, "bundle").is_empty());
        assert!(found(&site.index, "chunk").is_empty());
        assert_eq!(found(&site.index, "main"), ["app/main.rs"]);
        // The folder keeps its name in the search and in its folder's listing; what is in it is not held.
        assert_eq!(found(&site.index, "dist"), ["dist"]);
        // Unless hidden entries are asked for, the search hides the folder as a listing does.
        assert!(site.index.search("dist", 20, false).hits.is_empty());
        assert_eq!(site.index.search("main", 20, false).hits.len(), 1);
        assert_eq!(site.index.child_count(""), Some(5));
        assert_eq!(site.index.child_count("dist"), None);
        assert_eq!(site.index.child_count("dist/deep"), None);
        // What is outside it is held in full.
        assert_eq!(site.index.child_count("photos/edited"), Some(1));
    }

    #[test]
    fn the_built_in_names_and_the_okfs_ignore_file_leave_folders_out() {
        let site = with_folders_left_out();
        assert!(found(&site.index, "left-pad").is_empty());
        assert!(found(&site.index, "frame.cr3").is_empty());
        assert_eq!(found(&site.index, "frame.jpg"), ["photos/edited/frame.jpg"]);
        assert_eq!(site.index.child_count("app/node_modules"), None);
        assert_eq!(site.index.child_count("photos/raw"), None);
        // 5 at the top, 1 in sub, 2 in app, 2 in photos and 1 in photos/edited.
        assert_eq!(site.index.len(), 5 + 1 + 2 + 2 + 1);
    }

    #[test]
    fn the_first_walk_hands_the_search_what_it_has_found_while_it_goes_on() {
        let site = Watched::with(false, |served| {
            for at in 0..6 {
                fs::create_dir_all(served.join(format!("dir-{at}"))).unwrap();
                for file in 0..4 {
                    fs::write(served.join(format!("dir-{at}/file-{file}.txt")), "x").unwrap();
                }
            }
        });
        let fresh = Index::new(Root::new(&site.served, false).unwrap());
        let (mut counts, mut heard) = (Vec::new(), Vec::new());
        let flush = Flush {
            entries: 5,
            every: Duration::MAX,
        };
        fresh.fill(flush, || {
            counts.push(fresh.len());
            heard.push((fresh.ready(), fresh.search("file-0", 100, true).total));
        });
        assert!(counts.len() > 2, "the walk was handed over in parts: {counts:?}");
        assert!(counts.windows(2).all(|pair| pair[0] <= pair[1]));
        assert!(
            counts[0] > 0 && counts[0] < fresh.len(),
            "a part is held while the walk goes on: {counts:?}"
        );
        assert_eq!(counts.last(), Some(&fresh.len()));
        // Every part but the last is handed over before the index says it is whole, and is searched as it is.
        let (last, parts) = heard.split_last().unwrap();
        assert!(parts.iter().all(|(ready, _)| !ready));
        assert!(parts.iter().any(|(_, total)| *total > 0), "{heard:?}");
        // The walk is breadth first, so the first part is the served folder alone, with none of the files in it.
        // Which folders follow depends on the order the disk lists them, so only that the matches never fall is held.
        assert_eq!(parts[0].1, 0);
        assert!(heard.windows(2).all(|pair| pair[0].1 <= pair[1].1), "{heard:?}");
        assert!(fresh.ready());
        assert_eq!(last.1, 6);
        assert_eq!(fresh.search("file-0", 100, true).total, 6);
    }

    #[test]
    fn a_change_in_a_folder_left_out_is_told_to_the_pages_and_never_held() {
        let mut site = with_folders_left_out();
        fs::write(site.served.join("dist/new.js"), "new").unwrap();
        fs::create_dir_all(site.served.join("dist/fresh")).unwrap();
        fs::write(site.served.join("dist/fresh/more.js"), "more").unwrap();
        let made = EventKind::Create(CreateKind::Folder);
        let told = site.see(&[
            (CREATE, "dist/new.js"),
            (WRITE, "dist/new.js"),
            (made, "dist/fresh"),
            (CREATE, "dist/fresh/more.js"),
        ]);
        assert_eq!(
            sorted(told),
            sorted(vec![folder("dist", &["new.js"]), folder("dist/fresh", &["more.js"])])
        );
        assert_eq!(site.index.child_count("dist"), None);
        assert!(found(&site.index, "more").is_empty());
        assert!(found(&site.index, "new").is_empty());

        // A folder that comes into place already left out is listed in its folder and not walked.
        fs::create_dir_all(site.served.join("app/node_modules/other")).unwrap();
        fs::write(site.served.join("app/node_modules/other/index.js"), "x").unwrap();
        let told = site.see(&[
            (made, "app/node_modules/other"),
            (CREATE, "app/node_modules/other/index.js"),
        ]);
        let expected = vec![
            folder("app/node_modules", &[]),
            folder("app/node_modules/other", &["index.js"]),
        ];
        assert_eq!(sorted(told), sorted(expected));
        // It was listed already: the folder reads as it did, and the pages are told to catch up.
        let told = site.see(&[(made, "app/node_modules")]);
        assert_eq!(told, [Change::Sync]);
        assert_eq!(site.index.child_count("app/node_modules"), None);
        assert!(found(&site.index, "other").is_empty());
        assert_eq!(site.index.child_count("app"), Some(2));
    }

    #[test]
    fn a_change_to_a_rule_file_reads_the_folder_again_under_the_new_rules() {
        let mut site = with_folders_left_out();
        assert!(found(&site.index, "frame.jpg").len() == 1);

        // `photos` is now left out whole, and `dist` is let back in.
        fs::write(site.served.join(".gitignore"), "photos\n").unwrap();
        fs::write(site.served.join(".okfsignore"), "").unwrap();
        let told = site.see(&[(WRITE, ".gitignore"), (WRITE, ".okfsignore")]);
        assert_eq!(told, [Change::Sync]);
        assert!(found(&site.index, "frame.jpg").is_empty());
        assert_eq!(site.index.child_count("photos/edited"), None);
        assert_eq!(found(&site.index, "bundle"), ["dist/bundle.js"]);
        assert_eq!(found(&site.index, "chunk"), ["dist/deep/chunk.js"]);
    }

    #[test]
    fn a_folder_that_becomes_left_out_is_dropped_by_the_change_that_says_so() {
        let mut site = with_folders_left_out();
        fs::write(site.served.join("app/.gitignore"), "node_modules\nsrc\n").unwrap();
        fs::create_dir_all(site.served.join("app/src")).unwrap();
        fs::write(site.served.join("app/src/lib.rs"), "x").unwrap();
        site.index.build();
        assert!(found(&site.index, "lib.rs").is_empty());
        fs::write(site.served.join("app/.gitignore"), "node_modules\n").unwrap();
        site.see(&[(WRITE, "app/.gitignore")]);
        assert_eq!(found(&site.index, "lib.rs"), ["app/src/lib.rs"]);
    }

    #[test]
    fn a_folder_that_changed_while_the_watcher_was_being_set_up_is_read_again_by_its_time() {
        let mut site = Watched::new(false);
        fs::write(site.served.join("sub/missed.txt"), "x").unwrap();
        fs::create_dir_all(site.served.join("sub/new/deep")).unwrap();
        fs::write(site.served.join("sub/new/deep/also.txt"), "x").unwrap();
        let hour = Duration::from_secs(3600);

        // A folder not written since the walk began is left as it was.
        site.index.catch_up(SystemTime::now() + hour);
        assert!(found(&site.index, "missed").is_empty());
        assert_eq!(site.told(), []);

        site.index.catch_up(SystemTime::now() - hour);
        assert_eq!(found(&site.index, "missed"), ["sub/missed.txt"]);
        assert_eq!(found(&site.index, "also"), ["sub/new/deep/also.txt"]);
        assert_eq!(site.told(), [folder("sub", &[])]);
    }

    #[test]
    fn a_new_file_is_told_with_its_folder_and_its_name() {
        let mut site = Watched::new(false);
        fs::write(site.served.join("sub/new.txt"), "new").unwrap();
        let told = site.see(&[(CREATE, "sub/new.txt"), (WRITE, "sub/new.txt")]);
        assert_eq!(told, [folder("sub", &["new.txt"])]);
    }

    #[test]
    fn a_removed_file_is_told_with_its_folder() {
        let mut site = Watched::new(false);
        fs::remove_file(site.served.join("sub/b.txt")).unwrap();
        assert_eq!(site.see(&[(REMOVE, "sub/b.txt")]), [folder("sub", &[])]);
        // The same events again find nothing new, as after a delete made through okfs.
        assert_eq!(site.see(&[(REMOVE, "sub/b.txt")]), []);
    }

    #[test]
    fn a_renamed_file_is_told_by_its_new_name() {
        let mut site = Watched::new(false);
        fs::rename(site.served.join("a.txt"), site.served.join("z.txt")).unwrap();
        let from = EventKind::Modify(ModifyKind::Name(RenameMode::From));
        let to = EventKind::Modify(ModifyKind::Name(RenameMode::To));
        assert_eq!(site.see(&[(from, "a.txt"), (to, "z.txt")]), [folder("", &["z.txt"])]);
    }

    #[test]
    fn a_rewritten_file_is_told_by_name_in_place_or_swapped_in() {
        let mut site = Watched::new(false);
        fs::write(site.served.join("sub/b.txt"), "again").unwrap();
        assert_eq!(site.see(&[(WRITE, "sub/b.txt")]), [folder("sub", &["b.txt"])]);

        // Written beside it and moved over it, as editors save: the names stay as they were.
        fs::write(site.served.join("sub/b.tmp"), "swapped").unwrap();
        fs::rename(site.served.join("sub/b.tmp"), site.served.join("sub/b.txt")).unwrap();
        let from = EventKind::Modify(ModifyKind::Name(RenameMode::From));
        let to = EventKind::Modify(ModifyKind::Name(RenameMode::To));
        let told = site.see(&[
            (CREATE, "sub/b.tmp"),
            (WRITE, "sub/b.tmp"),
            (from, "sub/b.tmp"),
            (to, "sub/b.txt"),
        ]);
        assert_eq!(told, [folder("sub", &["b.txt"])]);
    }

    #[test]
    fn a_dotfile_is_told_only_when_dotfiles_are_shown() {
        let events = [
            (CREATE, ".env"),
            (WRITE, ".env"),
            (CREATE, ".git/config"),
            (WRITE, ".git/config"),
        ];
        let write = |site: &Watched| {
            fs::create_dir_all(site.served.join(".git")).unwrap();
            fs::write(site.served.join(".env"), "KEY=1").unwrap();
            fs::write(site.served.join(".git/config"), "[core]").unwrap();
        };
        let mut site = Watched::new(false);
        write(&site);
        assert_eq!(site.see(&events), []);
        fs::remove_file(site.served.join(".env")).unwrap();
        assert_eq!(site.see(&[(REMOVE, ".env")]), []);

        let mut site = Watched::new(true);
        write(&site);
        let mut told = site.see(&events);
        told.sort_by_key(|change| format!("{change:?}"));
        assert_eq!(told, [folder("", &[".env"]), folder(".git", &["config"])]);
    }

    #[cfg(unix)]
    #[test]
    fn nothing_behind_a_link_out_of_the_served_folder_is_told() {
        use std::os::unix::fs::symlink;
        let mut site = Watched::new(false);
        symlink(&site.outside, site.served.join("out")).unwrap();
        symlink(site.outside.join("secret.txt"), site.served.join("out.txt")).unwrap();
        fs::write(site.outside.join("secret.txt"), "written").unwrap();
        fs::write(site.outside.join("more.txt"), "new").unwrap();
        let told = site.see(&[
            (CREATE, "out"),
            (CREATE, "out.txt"),
            (WRITE, "out.txt"),
            (WRITE, "out/secret.txt"),
            (CREATE, "out/more.txt"),
        ]);
        assert_eq!(told, []);
    }

    #[cfg(unix)]
    #[test]
    fn a_change_seen_through_a_link_inside_is_told_by_its_real_folder() {
        use std::os::unix::fs::symlink;
        let mut site = Watched::new(false);
        symlink(site.served.join("sub"), site.served.join("latest")).unwrap();
        assert_eq!(site.see(&[(CREATE, "latest")]), [folder("", &[])]);
        fs::write(site.served.join("sub/b.txt"), "again").unwrap();
        assert_eq!(site.see(&[(WRITE, "latest/b.txt")]), [folder("sub", &["b.txt"])]);
    }

    #[test]
    fn a_burst_of_files_in_one_folder_is_one_change_that_names_them_all() {
        let mut site = Watched::new(false);
        let mut names: Vec<String> = (0..500).map(|at| format!("burst-{at}.txt")).collect();
        let paths: Vec<String> = names.iter().map(|name| format!("sub/{name}")).collect();
        let mut events = Vec::new();
        for path in &paths {
            fs::write(site.served.join(path), "x").unwrap();
            events.extend([(CREATE, path.as_str()), (WRITE, path.as_str())]);
        }
        let told = site.see(&events);
        let [Change::Folder { dir, files }] = told.as_slice() else {
            panic!("one change for the folder: {told:?}");
        };
        assert_eq!(dir, "sub");
        let mut files = files.clone();
        files.sort();
        names.sort();
        assert_eq!(files, names);
        assert_eq!(site.index.child_count("sub"), Some(501));
    }

    #[test]
    fn a_folder_renamed_into_place_is_walked_again_and_tells_the_pages_to_catch_up() {
        let mut site = Watched::new(false);
        fs::create_dir_all(site.served.join("build/deep")).unwrap();
        fs::write(site.served.join("build/fresh.txt"), "built").unwrap();
        fs::write(site.served.join("build/deep/inner.txt"), "built").unwrap();
        site.index.build();
        // What it holds comes with it: no event names that.
        fs::rename(site.served.join("sub"), site.served.join("sub.old")).unwrap();
        fs::rename(site.served.join("build"), site.served.join("sub")).unwrap();
        let from = EventKind::Modify(ModifyKind::Name(RenameMode::From));
        let to = EventKind::Modify(ModifyKind::Name(RenameMode::To));
        let told = site.see(&[(from, "sub"), (to, "sub.old"), (from, "build"), (to, "sub")]);
        assert_eq!(told, [folder("", &[]), Change::Sync]);

        // The index holds the folder that is there now, under the name of the one before.
        assert_eq!(site.index.child_count("sub"), Some(2));
        assert_eq!(site.index.child_count("sub/deep"), Some(1));
        assert_eq!(site.index.child_count("sub.old"), Some(1));
        assert_eq!(site.index.child_count("build"), None);
        let found = |query: &str| -> Vec<String> {
            let hits = site.index.search(query, 10, true).hits;
            hits.into_iter().map(|hit| hit.path).collect()
        };
        assert_eq!(found("fresh"), ["sub/fresh.txt"]);
        assert_eq!(found("inner"), ["sub/deep/inner.txt"]);
    }

    #[test]
    fn with_hidden_served_what_is_in_a_dotfile_folder_is_searched_only_when_asked_for() {
        let site = Watched::with(true, |served| {
            fs::create_dir_all(served.join(".config/app")).unwrap();
            fs::write(served.join(".config/app/settings.toml"), "x").unwrap();
            fs::write(served.join(".profile"), "x").unwrap();
        });
        let paths = |query: &str, all: bool| -> Vec<String> {
            site.index
                .search(query, 10, all)
                .hits
                .into_iter()
                .map(|hit| hit.path)
                .collect()
        };
        assert!(paths("settings", false).is_empty());
        assert!(paths("profile", false).is_empty());
        assert_eq!(paths("settings", true), [".config/app/settings.toml"]);
        assert_eq!(paths("profile", true), [".profile"]);
        assert!(
            site.index
                .recent(false)
                .files
                .iter()
                .all(|file| !file.path.starts_with('.'))
        );
        assert!(site.index.recent(true).files.iter().any(|file| file.path == ".profile"));
        // A folder's count tells what a listing hides apart from the rest.
        let rules = site.index.rules_in("");
        let all = site.index.child_count("").unwrap();
        assert_eq!(site.index.counts("", &rules), Some((all - 2, 2)));
    }

    #[test]
    fn letters_spread_over_words_only_match_when_nothing_is_closer() {
        let site = Watched::new(false);
        fs::create_dir_all(site.served.join("Northwind Industries")).unwrap();
        fs::write(site.served.join("Northwind Industries/the-report.txt"), "x").unwrap();
        fs::write(site.served.join("Northwind Industries/tidewater.txt"), "x").unwrap();
        site.index.build();
        let found = |query: &str| -> Vec<String> {
            site.index
                .search(query, 10, true)
                .hits
                .into_iter()
                .map(|hit| hit.path)
                .collect()
        };
        // `t`, `i`, `d`, `e` can be picked out of the other file's path, but a file holds the run.
        assert_eq!(found("tide"), ["Northwind Industries/tidewater.txt"]);
        // Nothing holds it as a run or as word starts: the loose match stays.
        assert!(!found("nwdtr").is_empty());
    }

    #[test]
    fn a_folder_told_as_changed_is_not_one_that_came_into_place() {
        let mut site = Watched::new(false);
        fs::write(site.served.join("sub/new.txt"), "new").unwrap();
        // Some watchers tell of the folder too when an entry in it comes or goes.
        let changed = EventKind::Modify(ModifyKind::Any);
        let told = site.see(&[(CREATE, "sub/new.txt"), (changed, "sub/new.txt"), (changed, "sub")]);
        assert_eq!(told, [folder("sub", &["new.txt"])]);
    }

    #[test]
    fn folders_told_late_are_walked_again_with_what_is_under_them() {
        let mut site = Watched::new(false);
        let made = EventKind::Create(CreateKind::Folder);
        fs::create_dir_all(site.served.join("tree/a/b")).unwrap();
        fs::write(site.served.join("tree/a/b/leaf.txt"), "leaf").unwrap();
        // The first walk finds the folders under it before their own events are read.
        assert_eq!(site.see(&[(made, "tree")]), [folder("", &[]), Change::Sync]);
        fs::write(site.served.join("tree/a/b/more.txt"), "more").unwrap();
        assert_eq!(site.see(&[(made, "tree/a"), (made, "tree/a/b")]), [Change::Sync]);
        assert_eq!(site.index.child_count("tree/a"), Some(1));
        assert_eq!(site.index.child_count("tree/a/b"), Some(2));
        let hits = site.index.search("more", 10, true).hits;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "tree/a/b/more.txt");
    }

    #[test]
    fn a_reread_tells_the_pages_once() {
        let mut site = Watched::new(false);
        fs::remove_file(site.served.join("a.txt")).unwrap();
        site.index.reread("");
        site.index.reread("");
        assert_eq!(site.told(), [folder("", &[])]);
    }

    #[test]
    fn a_watcher_that_lost_track_tells_the_pages_to_catch_up() {
        let mut site = Watched::new(false);
        let lost = Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);
        site.index.absorb(vec![Ok(lost)]);
        assert_eq!(site.told(), [Change::Sync]);
    }

    /// A served folder with one file, and an index of it that follows it as `follow` says.
    fn spawned(follow: Follow) -> (tempfile::TempDir, PathBuf, Arc<Index>) {
        let tmp = tempfile::TempDir::new().unwrap();
        let served = tmp.path().canonicalize().unwrap();
        fs::write(served.join("a.txt"), "a").unwrap();
        let index = Index::spawn(Root::new(&served, false).unwrap(), follow);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !index.ready() {
            assert!(Instant::now() < deadline, "the first walk never ended");
            std::thread::sleep(Duration::from_millis(10));
        }
        (tmp, served, index)
    }

    #[test]
    fn a_rescan_walks_the_tree_again_and_then_does_what_it_was_given() {
        let (_tmp, served, index) = spawned(Follow::Rescan(Duration::from_millis(200)));
        let (done, rescans) = mpsc::channel();
        index.after_rescan(move || {
            let _ = done.send(());
        });
        let mut page = Box::pin(index.feed().follow());
        fs::write(served.join("new.txt"), "new").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while found(&index, "new.txt").is_empty() {
            assert!(Instant::now() < deadline, "the rescan never found the new file");
            std::thread::sleep(Duration::from_millis(20));
        }
        rescans.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(page.next().now_or_never(), Some(Some(Change::Sync)));
    }

    #[test]
    fn with_a_rescan_there_is_no_watcher() {
        let (_tmp, served, index) = spawned(Follow::Rescan(Duration::from_secs(3600)));
        fs::write(served.join("new.txt"), "new").unwrap();
        // A watcher would have read it well within this.
        std::thread::sleep(SETTLE * 6);
        assert!(found(&index, "new.txt").is_empty());
        assert_eq!(found(&index, "a.txt"), ["a.txt"]);
    }

    /// Whether every matched letter of `hay` either follows the one before it or starts a word. A query
    /// found as a run, or as the starts of words, is close; letters picked out of the middle of
    /// several words are not.
    fn is_close(
        pattern: &Pattern,
        hay: &str,
        idx: &mut Vec<u32>,
        chars: &mut Vec<char>,
        matcher: &mut Matcher,
    ) -> bool {
        idx.clear();
        pattern.indices(Utf32Str::new(hay, chars), matcher, idx);
        idx.sort_unstable();
        idx.dedup();
        let letters: Vec<char> = hay.chars().collect();
        let mut last = None;
        idx.iter().all(|&i| {
            let i = i as usize;
            let ok =
                last.is_some_and(|l| i == l + 1) || i == 0 || letters.get(i - 1).is_some_and(|c| !c.is_alphanumeric());
            last = Some(i);
            ok
        })
    }

    /// The search as it was before it was made fast: every entry scored by its name, then by its
    /// whole path, one after the other. What the search finds must be what this finds.
    fn plain_search(index: &Index, query: &str, limit: usize, all: bool) -> Vec<Hit> {
        let tree = index.tree.read().expect("the index lock");
        let query = query.trim();
        if query.is_empty() || limit == 0 {
            return Vec::new();
        }
        let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
        let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
        let (mut chars, mut path) = (Vec::new(), String::new());
        // Score, folder, place in the folder, whether the name matched, and whether it is close.
        type Scored<'a> = (u32, &'a str, usize, bool, bool);
        let mut scored: Vec<Scored> = Vec::new();
        let mut idx = Vec::new();
        for (dir, folder) in tree.dirs.iter().filter(|(dir, _)| all || !in_hidden(dir)) {
            for (at, (name, _)) in folder.entries().enumerate().filter(|(_, (_, n))| all || !n.hidden) {
                if let Some(score) = pattern.score(Utf32Str::new(name, &mut chars), &mut matcher) {
                    let close = is_close(&pattern, name, &mut idx, &mut chars, &mut matcher);
                    scored.push((score + NAME_BONUS, dir, at, true, close));
                    continue;
                }
                if dir.is_empty() {
                    continue;
                }
                path.clear();
                path.push_str(dir);
                path.push('/');
                path.push_str(name);
                if let Some(score) = pattern.score(Utf32Str::new(&path, &mut chars), &mut matcher) {
                    let close = is_close(&pattern, &path, &mut idx, &mut chars, &mut matcher);
                    scored.push((score, dir, at, false, close));
                }
            }
        }
        if scored.iter().any(|s| s.4) {
            scored.retain(|s| s.4);
        }
        let total = scored.len();
        let rank = |a: &Scored, b: &Scored| {
            let (left, right) = (tree.dirs[a.1].name(a.2), tree.dirs[b.1].name(b.2));
            (b.0.cmp(&a.0))
                .then_with(|| (a.1.len() + left.len()).cmp(&(b.1.len() + right.len())))
                .then_with(|| (a.1, left).cmp(&(b.1, right)))
        };
        scored.sort_by(rank);
        scored.truncate(limit);
        let mut hits: Vec<Hit> = scored
            .into_iter()
            .map(|(_, dir, at, by_name, _)| {
                let (name, node) = (tree.dirs[dir].name(at), &tree.dirs[dir].nodes[at]);
                let path = paths::join(dir, name);
                let mut idx = Vec::new();
                let hay = if by_name { name } else { path.as_str() };
                pattern.indices(Utf32Str::new(hay, &mut chars), &mut matcher, &mut idx);
                idx.sort_unstable();
                idx.dedup();
                Hit {
                    c: node.dir().then(|| tree.shown_in(&path, all)).flatten(),
                    path,
                    dir: node.dir(),
                    idx,
                    name: by_name,
                    m: node.modified,
                    s: tree.dirs[dir].sizes[at],
                }
            })
            .collect();
        // The total rides along as one more hit, so a comparison checks it too.
        hits.push(total_hit(total));
        hits
    }

    /// A total, as one more hit, so a comparison of hits checks it too.
    fn total_hit(total: usize) -> Hit {
        Hit {
            path: format!("total {total}"),
            dir: false,
            idx: Vec::new(),
            name: false,
            m: 0,
            s: 0,
            c: None,
        }
    }

    /// What `search` answers, in the shape `plain_search` gives it.
    fn searched(index: &Index, query: &str, limit: usize, all: bool) -> Vec<Hit> {
        let found = index.search(query, limit, all);
        let mut hits = found.hits;
        if !query.trim().is_empty() && limit > 0 {
            hits.push(total_hit(found.total));
        }
        hits
    }

    /// Words a home folder's names are made of.
    const WORDS: &[&str] = &[
        "report",
        "invoice",
        "photo",
        "draft",
        "notes",
        "budget",
        "project",
        "client",
        "meeting",
        "summary",
        "design",
        "final",
        "review",
        "backup",
        "archive",
        "music",
        "video",
        "school",
        "taxes",
        "travel",
        "recipe",
        "garden",
        "letter",
        "resume",
        "contract",
        "slides",
        "export",
        "import",
        "config",
        "readme",
        "index",
        "main",
        "server",
        "client",
        "render",
        "theme",
        "assets",
        "build",
        "release",
        "screenshot",
        "holiday",
        "wedding",
        "family",
        "work",
        "personal",
        "scan",
        "receipt",
        "manual",
        "guide",
        "schedule",
        "northwind",
        "tidewater",
        "summit",
        "harbor",
        "maple",
        "cedar",
        "orbit",
        "pixel",
        "vector",
        "kernel",
        "data",
        "model",
        "sample",
        "test",
        "spec",
        "lib",
        "util",
        "helper",
        "store",
        "palette",
        "preview",
    ];
    const EXTENSIONS: &[&str] = &[
        "txt", "md", "pdf", "jpg", "JPG", "png", "rs", "ts", "tsx", "json", "toml", "docx", "xlsx", "mp3", "mov",
        "zip", "csv", "html", "css", "py", "heic", "svg",
    ];

    /// The same numbers every time, from one seed.
    struct Dice(u64);

    impl Dice {
        fn below(&mut self, n: usize) -> usize {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % n as u64) as usize
        }

        fn word(&mut self) -> &'static str {
            WORDS[self.below(WORDS.len())]
        }

        fn title(&mut self) -> String {
            let word = self.word();
            word[..1].to_uppercase() + &word[1..]
        }

        fn file(&mut self) -> String {
            let ext = EXTENSIONS[self.below(EXTENSIONS.len())];
            match self.below(10) {
                0 => format!("IMG_{:04}.{ext}", self.below(10_000)),
                1 => format!("{} {} {}.{ext}", self.title(), self.title(), 2015 + self.below(11)),
                2 => format!("{}{}.{ext}", self.title(), self.title()),
                3 => format!("{}_{}.{ext}", self.word(), self.below(100)),
                4 if self.below(8) == 0 => format!("café {}.{ext}", self.word()),
                4 if self.below(8) == 0 => format!("Über-{}.{ext}", self.word()),
                5 => format!("{}.{ext}", self.word()),
                _ => format!("{}-{}.{ext}", self.word(), self.word()),
            }
        }

        fn folder(&mut self) -> String {
            match self.below(12) {
                0 => format!("{}", 2015 + self.below(11)),
                1 | 2 => format!("{} {}", self.title(), self.title()),
                3 => format!("{}-{}", self.word(), self.word()),
                4 if self.below(4) == 0 => "node_modules".to_owned(),
                4 if self.below(4) == 0 => "src".to_owned(),
                _ => self.word().to_owned(),
            }
        }
    }

    /// Writes a tree of at least `entries` entries under `top`, the same every time: folders up to
    /// ten deep, named the way a home folder's are.
    fn synthetic(top: &Path, entries: usize) {
        let mut dice = Dice(0x9e37_79b9_7f4a_7c15);
        let mut made = 0;
        let mut todo = VecDeque::from([(top.to_path_buf(), 0)]);
        fs::create_dir_all(top).unwrap();
        while let Some((dir, depth)) = todo.pop_front() {
            for _ in 0..dice.below(24) {
                if made < entries {
                    fs::write(dir.join(dice.file()), "").unwrap();
                    made += 1;
                }
            }
            let folders = if depth < 10 { dice.below(6) } else { 0 };
            for _ in 0..folders {
                if made < entries {
                    let inside = dir.join(dice.folder());
                    if !inside.exists() {
                        fs::create_dir(&inside).unwrap();
                        made += 1;
                        // What is in a folder that is left out is not indexed: it stays empty.
                        if !inside.ends_with("node_modules") {
                            todo.push_back((inside, depth + 1));
                        }
                    }
                }
            }
            // Keep folders coming while entries are still owed.
            if todo.is_empty() && made < entries {
                let more = top.join(format!("more {made}"));
                fs::create_dir(&more).unwrap();
                made += 1;
                todo.push_back((more, 1));
            }
        }
    }

    /// Queries as they are typed: one letter, two, a word, a path, and one that finds nothing.
    const QUERIES: &[&str] = &[
        "r",
        "re",
        "rep",
        "repo",
        "report",
        "inv",
        "img",
        "img_12",
        "md",
        "readme",
        "budget 2021",
        "nw ind",
        "src/main",
        "photo/2019",
        "notes/draft",
        "summit harbor final",
        "zqxj",
        "cafe",
        "über",
        "^report",
        "pdf$",
        "'draft",
        "!jpg rep",
        "report !pdf",
        "!",
        "x y",
        "eaoiu",
        "nwdtr",
    ];

    #[test]
    fn the_search_finds_what_a_plain_scan_finds() {
        let tmp = tempfile::TempDir::new().unwrap();
        synthetic(tmp.path(), 6000);
        let index = Index::new(Root::new(tmp.path(), false).unwrap());
        index.build();
        let same = |query: &str, limit: usize, all: bool| {
            let plain = plain_search(&index, query, limit, all);
            assert_eq!(
                searched(&index, query, limit, all),
                plain,
                "{query:?} limit {limit} all {all}"
            );
        };
        for all in [false, true] {
            for query in QUERIES {
                for limit in [0, 1, 7, 60, 200] {
                    *index.last.lock().unwrap() = None;
                    same(query, limit, all);
                }
                // Typed a letter at a time: each search can narrow what the one before found.
                let ends = query.char_indices().skip(1).map(|(end, _)| end).chain([query.len()]);
                for end in ends {
                    same(&query[..end], 60, all);
                }
            }
        }
        // Taken back and typed again, with and without what a listing hides.
        for (query, all) in [
            ("repo", false),
            ("rep", false),
            ("rex", false),
            ("re", true),
            ("rep", false),
            ("rep", true),
        ] {
            same(query, 60, all);
        }
    }

    #[test]
    fn the_pages_of_a_search_follow_on_from_one_another_in_every_order() {
        let tmp = tempfile::TempDir::new().unwrap();
        synthetic(tmp.path(), 3000);
        let index = Index::new(Root::new(tmp.path(), false).unwrap());
        index.build();
        let paths = |found: Found| found.hits.into_iter().map(|hit| hit.path).collect::<Vec<_>>();
        for query in ["re", "repo", "img", "zqxj"] {
            for order in [Order::Rank, Order::Name, Order::Folder, Order::Size, Order::Time] {
                for reverse in [false, true] {
                    let page = |offset, limit| Page {
                        offset,
                        limit,
                        order,
                        reverse,
                    };
                    let whole = index.search_page(query, page(0, usize::MAX), false);
                    let total = whole.total;
                    let whole = paths(whole);
                    assert_eq!(whole.len(), total, "{query:?} {order:?}");
                    let mut paged = Vec::new();
                    for offset in (0..total + 37).step_by(37) {
                        let found = index.search_page(query, page(offset, 37), false);
                        assert_eq!(found.total, total, "{query:?} {order:?} at {offset}");
                        paged.extend(paths(found));
                    }
                    assert_eq!(paged, whole, "{query:?} {order:?} {reverse}");
                }
            }
        }
        // The first page in rank order is what the palette is sent.
        let first = index.search_page("repo", Page::first(60), false);
        assert_eq!(paths(first), paths(index.search("repo", 60, false)));
    }

    #[test]
    fn a_search_sorts_by_name_folder_size_and_time_and_tells_each() {
        let tmp = tempfile::TempDir::new().unwrap();
        let top = tmp.path();
        let at = |seconds| SystemTime::UNIX_EPOCH + Duration::from_secs(seconds);
        for (path, size, time) in [
            ("b-report.txt", 30, 3_000),
            ("A-report.md", 10, 1_000),
            ("zz/c-report.rs", 20, 2_000),
        ] {
            fs::create_dir_all(top.join(path).parent().unwrap()).unwrap();
            let file = fs::File::create(top.join(path)).unwrap();
            file.set_len(size).unwrap();
            file.set_modified(at(time)).unwrap();
        }
        fs::create_dir_all(top.join("reports/inside")).unwrap();
        fs::write(top.join("reports/one.txt"), "").unwrap();
        fs::write(top.join("reports/.hidden"), "").unwrap();
        let index = Index::new(Root::new(top, true).unwrap());
        index.build();
        let sorted = |order, reverse| {
            let page = Page {
                offset: 0,
                limit: 10,
                order,
                reverse,
            };
            let found = index.search_page("-report", page, false);
            found.hits.into_iter().map(|hit| hit.path).collect::<Vec<_>>()
        };
        // Case does not count in a name, and a name's natural end comes first.
        assert_eq!(
            sorted(Order::Name, false),
            ["A-report.md", "b-report.txt", "zz/c-report.rs"]
        );
        assert_eq!(
            sorted(Order::Name, true),
            ["zz/c-report.rs", "b-report.txt", "A-report.md"]
        );
        assert_eq!(
            sorted(Order::Folder, true),
            ["zz/c-report.rs", "b-report.txt", "A-report.md"]
        );
        assert_eq!(
            sorted(Order::Size, false),
            ["b-report.txt", "zz/c-report.rs", "A-report.md"]
        );
        assert_eq!(
            sorted(Order::Time, false),
            ["b-report.txt", "zz/c-report.rs", "A-report.md"]
        );
        assert_eq!(
            sorted(Order::Time, true),
            ["A-report.md", "zz/c-report.rs", "b-report.txt"]
        );

        let found = index.search_page("report", Page::first(10), false);
        let hit = |path: &str| found.hits.iter().find(|hit| hit.path == path).unwrap();
        assert_eq!(
            (hit("b-report.txt").m, hit("b-report.txt").s, hit("b-report.txt").c),
            (3_000, 30, None)
        );
        // A folder tells how many entries its listing shows: the hidden one only when hidden ones are searched.
        assert_eq!((hit("reports").m, hit("reports").s, hit("reports").c), (0, 0, Some(2)));
        let all = index.search_page("reports", Page::first(10), true);
        assert_eq!(all.hits.iter().find(|hit| hit.path == "reports").unwrap().c, Some(3));
    }

    #[test]
    fn a_search_that_narrows_the_last_sees_what_changed_in_between() {
        let mut site = Watched::new(false);
        let same = |site: &Watched, query: &str| {
            let plain = plain_search(&site.index, query, 60, false);
            assert_eq!(searched(&site.index, query, 60, false), plain, "{query:?}");
        };
        same(&site, "rep");
        fs::write(site.served.join("sub/report.txt"), "x").unwrap();
        site.see(&[(CREATE, "sub/report.txt")]);
        same(&site, "repo");
        assert_eq!(found(&site.index, "repo"), ["sub/report.txt"]);
        fs::remove_file(site.served.join("sub/report.txt")).unwrap();
        site.see(&[(REMOVE, "sub/report.txt")]);
        same(&site, "repor");
        assert!(found(&site.index, "repor").is_empty());
        // A folder read again holds its entries in another order, under the same names.
        fs::write(site.served.join("sub/rep-a.txt"), "x").unwrap();
        site.see(&[(CREATE, "sub/rep-a.txt")]);
        same(&site, "r");
        fs::write(site.served.join("sub/rep-b.txt"), "x").unwrap();
        site.index.reread("sub");
        same(&site, "re");
        same(&site, "rep");
        assert_eq!(found(&site.index, "rep").len(), 2);
    }

    #[test]
    fn a_search_no_one_waits_for_stops_and_leaves_nothing_for_the_next() {
        let tmp = tempfile::TempDir::new().unwrap();
        synthetic(tmp.path(), 6000);
        let index = Index::new(Root::new(tmp.path(), false).unwrap());
        index.build();
        assert!(
            index
                .search_unless("rep", Page::first(60), false, &AtomicBool::new(true))
                .is_none()
        );
        assert!(index.last.lock().unwrap().is_none());
        assert_eq!(
            searched(&index, "repo", 60, false),
            plain_search(&index, "repo", 60, false)
        );
    }

    /// How much memory the process holds, in bytes, where that can be read.
    fn resident() -> Option<usize> {
        let statm = fs::read_to_string("/proc/self/statm").ok()?;
        let pages: usize = statm.split_whitespace().nth(1)?.parse().ok()?;
        Some(pages * 4096)
    }

    /// The search over a tree the size of a big home folder, each query timed. Run it in release:
    /// `OKFS_BENCH_TREE=<folder> cargo test --release --lib bench_search -- --ignored --nocapture`.
    /// The folder is written the first time.
    #[test]
    #[ignore = "a benchmark: run it by hand, in release"]
    fn bench_search() {
        let top = PathBuf::from(std::env::var("OKFS_BENCH_TREE").expect("OKFS_BENCH_TREE names a folder"));
        if !top.exists() {
            synthetic(&top, 311_174);
        }
        let before = resident();
        let index = Index::new(Root::new(&top, false).unwrap());
        index.build();
        let after = resident();
        let mb = |bytes: usize| bytes as f64 / 1e6;
        if let (Some(before), Some(after)) = (before, after) {
            println!(
                "{} entries, {:.1} MB resident for the index",
                index.len(),
                mb(after - before)
            );
        }
        let runs = 9;
        // The median time of `search`, each run after `before`, which is not timed.
        let time = |before: &dyn Fn(), search: &dyn Fn()| {
            let mut took: Vec<f64> = (0..runs)
                .map(|_| {
                    before();
                    let began = Instant::now();
                    search();
                    began.elapsed().as_secs_f64() * 1e3
                })
                .collect();
            took.sort_by(f64::total_cmp);
            took[runs / 2]
        };
        let forget = || *index.last.lock().unwrap() = None;
        let plain = std::env::var_os("OKFS_BENCH_PLAIN").is_some();
        for query in QUERIES {
            for all in [false, true] {
                assert_eq!(
                    searched(&index, query, 60, all),
                    plain_search(&index, query, 60, all),
                    "{query:?}"
                );
            }
            // As the first query typed, and as typed a letter at a time.
            let cold = time(&forget, &|| drop(index.search(query, 60, false)));
            let shorter = &query[..query.char_indices().last().unwrap().0];
            let typed = time(
                &|| {
                    forget();
                    drop(index.search(shorter, 60, false));
                },
                &|| drop(index.search(query, 60, false)),
            );
            let total = index.search(query, 60, false).total;
            let plain = if plain {
                let took = time(&|| {}, &|| drop(plain_search(&index, query, 60, false)));
                format!("plain {took:7.1} ms  ")
            } else {
                String::new()
            };
            // A page of the matches by name, as the list of every match asks for it: every match is sorted.
            let by_name = Page {
                offset: 0,
                limit: 200,
                order: Order::Name,
                reverse: false,
            };
            let sorted = time(&forget, &|| drop(index.search_page(query, by_name, false)));
            println!(
                "{query:>22} {total:>7} found  {plain}first {cold:7.1} ms  typed {typed:7.1} ms  by name {sorted:7.1} ms"
            );
        }
    }

    #[test]
    fn without_a_watcher_a_big_tree_is_walked_again_less_often() {
        assert_eq!(poll_wait(Duration::from_millis(5)), POLL);
        assert_eq!(poll_wait(Duration::from_secs(1)), POLL);
        assert_eq!(poll_wait(Duration::from_secs(90)), Duration::from_secs(30 * 60));
        assert_eq!(poll_wait(Duration::MAX), Duration::MAX);
    }
}
