//! Every name in the served tree, held in memory for the palette's search, with the
//! time each file was last written. One walk at start builds it; a file watcher keeps
//! it fresh after that.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::event::{EventKind, ModifyKind};
use notify::{RecursiveMode, Watcher};
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;

use crate::paths::{self, Root};

/// How long the tree must be quiet before changes are read.
const SETTLE: Duration = Duration::from_millis(150);
/// The longest a busy tree can delay a read.
const MAX_WAIT: Duration = Duration::from_secs(2);
/// How often the tree is walked again when no watcher could be set up.
const POLL: Duration = Duration::from_secs(30);
/// A match on the name itself outranks a match somewhere in the path.
const NAME_BONUS: u32 = 64;

struct Node {
    name: Box<str>,
    dir: bool,
    /// A real folder, not a link to one: the walk goes in.
    walk: bool,
    /// When a file was last written, in seconds. Zero for a folder and for a time that
    /// could not be read. Kept as 32 bits so a node stays as small as it was.
    modified: u32,
}

#[derive(Default)]
struct Tree {
    /// Folder path to its children. The served folder itself is the empty path.
    dirs: HashMap<String, Vec<Node>>,
    count: usize,
}

pub struct Index {
    root: Root,
    tree: RwLock<Tree>,
    ready: AtomicBool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Hit {
    pub path: String,
    pub dir: bool,
    /// Which characters matched, counted in characters.
    pub idx: Vec<u32>,
    /// True when `idx` counts into the name, false when into the whole path.
    pub name: bool,
}

#[derive(Debug, Serialize)]
pub struct Found {
    pub hits: Vec<Hit>,
    /// How many entries matched, of which `hits` holds the best.
    pub total: usize,
    pub indexed: usize,
    pub ready: bool,
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
    /// Newest first. Files with the same time are in path order.
    pub files: Vec<Changed>,
}

impl Index {
    /// An empty index. Call `build` to fill it.
    pub fn new(root: Root) -> Arc<Self> {
        Arc::new(Self {
            root,
            tree: RwLock::default(),
            ready: AtomicBool::new(false),
        })
    }

    /// Starts the first walk and the watcher on their own thread and returns at once.
    pub fn spawn(root: Root) -> Arc<Self> {
        let index = Self::new(root);
        let worker = Arc::clone(&index);
        std::thread::Builder::new()
            .name("okfs-index".to_owned())
            .spawn(move || worker.run())
            .expect("the index thread starts");
        index
    }

    fn run(&self) {
        let (send, events) = mpsc::channel();
        let watcher = notify::recommended_watcher(send).and_then(|mut watcher| {
            watcher.watch(self.root.dir(), RecursiveMode::Recursive)?;
            Ok(watcher)
        });
        self.build();
        let _watcher = match watcher {
            Ok(watcher) => watcher,
            Err(error) => {
                eprintln!(
                    "okfs: cannot watch the folder for changes ({error}); reading it again every {}s",
                    POLL.as_secs()
                );
                loop {
                    std::thread::sleep(POLL);
                    self.build();
                }
            }
        };

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

    /// Walks the whole served folder and replaces the index with what it finds.
    pub fn build(&self) {
        if self.ready() {
            let fresh = self.walk("");
            *self.tree.write().expect("the index lock") = fresh;
        } else {
            // The first walk of a big tree takes a while: each folder is shown as soon as
            // it is read, so the palette has something to list meanwhile.
            self.walk_with("", |dir, nodes| {
                let mut tree = self.tree.write().expect("the index lock");
                tree.count += nodes.len();
                tree.dirs.insert(dir, nodes);
            });
        }
        self.ready.store(true, Ordering::Release);
    }

    fn walk(&self, from: &str) -> Tree {
        let mut tree = Tree::default();
        self.walk_with(from, |dir, nodes| {
            tree.count += nodes.len();
            tree.dirs.insert(dir, nodes);
        });
        tree
    }

    fn walk_with(&self, from: &str, mut keep: impl FnMut(String, Vec<Node>)) {
        let mut todo = vec![from.to_owned()];
        while let Some(dir) = todo.pop() {
            let Some(nodes) = self.read(&dir, None) else { continue };
            todo.extend(nodes.iter().filter(|n| n.walk).map(|n| paths::join(&dir, &n.name)));
            keep(dir, nodes);
        }
    }

    /// The names in one folder. A file that `old` already holds keeps its time, and only
    /// a name that is new is looked at on the disk: a long folder is not read file by
    /// file each time one name in it changes. `restamp` brings the times up to date.
    fn read(&self, dir: &str, old: Option<&[Node]>) -> Option<Vec<Node>> {
        let at = self.root.dir().join(dir);
        let seen = self.root.scan(&at).ok()?;
        let kept: HashMap<&str, u32> = old
            .into_iter()
            .flatten()
            .filter(|n| !n.dir && n.modified != 0)
            .map(|n| (&*n.name, n.modified))
            .collect();
        Some(
            seen.into_iter()
                .map(|s| {
                    let modified = match kept.get(s.name.as_str()) {
                        _ if s.dir => 0,
                        Some(&time) => time,
                        None => seconds(self.root.modified(&at, &s.name)),
                    };
                    Node {
                        name: s.name.into_boxed_str(),
                        dir: s.dir,
                        walk: s.dir && !s.link,
                        modified,
                    }
                })
                .collect(),
        )
    }

    fn absorb(&self, batch: Vec<notify::Result<notify::Event>>) {
        // Paths whose name came or went: the folder holding each is read again.
        let mut named = HashSet::new();
        // Paths whose content may have changed, with no name changing.
        let mut written = HashSet::new();
        for event in batch {
            let Ok(event) = event else {
                return self.build();
            };
            if event.need_rescan() {
                return self.build();
            }
            match event.kind {
                EventKind::Access(_) => {}
                EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_)) => written.extend(event.paths),
                EventKind::Remove(_) => named.extend(event.paths),
                // A file written over by a rename has the same name and a new time.
                _ => {
                    written.extend(event.paths.iter().cloned());
                    named.extend(event.paths);
                }
            }
        }
        let dirty: HashSet<String> = named.iter().filter_map(|path| self.dir_of(path)).collect();
        for dir in dirty {
            self.reread(&dir);
        }
        self.restamp(written);
    }

    /// Reads the time of each file again and writes it into the index: one look at the
    /// disk per file, and one for all of them however often a file was written to
    /// since the last batch.
    fn restamp(&self, written: HashSet<PathBuf>) {
        let mut stamps: HashMap<String, HashMap<String, u32>> = HashMap::new();
        for path in written {
            let Some(rel) = path.strip_prefix(self.root.dir()).ok().and_then(Path::to_str) else {
                continue;
            };
            let rel = rel.replace(std::path::MAIN_SEPARATOR, "/");
            let Some(found) = self.root.resolve(&rel).filter(|found| found.meta.is_file()) else {
                continue;
            };
            let time = seconds(found.meta.modified().ok());
            stamps
                .entry(paths::parent(&found.rel).to_owned())
                .or_default()
                .insert(paths::file_name(&found.rel).to_owned(), time);
        }
        if stamps.is_empty() {
            return;
        }
        let mut tree = self.tree.write().expect("the index lock");
        for (dir, times) in stamps {
            let Some(nodes) = tree.dirs.get_mut(&dir) else {
                continue;
            };
            for node in nodes.iter_mut().filter(|n| !n.dir) {
                if let Some(&time) = times.get(&*node.name) {
                    node.modified = time;
                }
            }
        }
    }

    /// The indexed folder a changed path sits in, or `None` when it is not shown.
    fn dir_of(&self, path: &Path) -> Option<String> {
        let inner = path.parent()?.strip_prefix(self.root.dir()).ok()?;
        let rel = inner.to_str()?.replace(std::path::MAIN_SEPARATOR, "/");
        self.root.resolve(&rel).map(|found| found.rel)
    }

    /// Reads one folder again and folds what changed into the index. The watcher does
    /// this by itself a moment later; a delete calls it so the entry is gone at once.
    pub fn reread(&self, dir: &str) {
        let (nodes, known) = {
            let tree = self.tree.read().expect("the index lock");
            let old = tree.dirs.get(dir);
            // Not indexed yet: its parent's reread will walk it.
            if old.is_none() && !dir.is_empty() {
                return;
            }
            let Some(nodes) = self.read(dir, old.map(Vec::as_slice)) else {
                drop(tree);
                return self.forget(dir);
            };
            let known: HashSet<String> = old
                .into_iter()
                .flatten()
                .filter(|n| n.walk)
                .map(|n| n.name.to_string())
                .collect();
            (nodes, known)
        };
        let now: HashSet<&str> = nodes.iter().filter(|n| n.walk).map(|n| &*n.name).collect();
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

        let mut tree = self.tree.write().expect("the index lock");
        for path in gone {
            tree.remove(&path);
        }
        for sub in added {
            tree.count += sub.count;
            tree.dirs.extend(sub.dirs);
        }
        tree.count += nodes.len();
        if let Some(old) = tree.dirs.insert(dir.to_owned(), nodes) {
            tree.count -= old.len();
        }
    }

    /// Walks one folder again with everything under it, in place of what the index
    /// held of it. For a folder that changed at more than one depth: `reread` looks
    /// at one folder only.
    pub fn rewalk(&self, dir: &str) {
        let fresh = self.walk(dir);
        let mut tree = self.tree.write().expect("the index lock");
        // Not indexed yet: its parent's reread will walk it.
        if !tree.dirs.contains_key(dir) {
            return;
        }
        tree.remove(dir);
        tree.count += fresh.count;
        tree.dirs.extend(fresh.dirs);
    }

    fn forget(&self, dir: &str) {
        self.tree.write().expect("the index lock").remove(dir);
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
        tree.dirs.get(dir).map(Vec::len)
    }

    /// The `limit` files written last, newest first. Read from memory: the disk is not
    /// looked at. Folders never appear, and neither does a file whose time is unknown.
    pub fn recent(&self, limit: usize) -> Recent {
        let tree = self.tree.read().expect("the index lock");
        // Newer is greater, and of two with the same time the earlier path is greater.
        // The heap keeps the `limit` greatest, its least on top.
        let mut best = BinaryHeap::with_capacity(limit.saturating_add(1).min(1024));
        if limit > 0 {
            for (dir, nodes) in &tree.dirs {
                for node in nodes.iter().filter(|n| !n.dir && n.modified != 0) {
                    best.push(Reverse((node.modified, Reverse(dir.as_str()), Reverse(&*node.name))));
                    if best.len() > limit {
                        best.pop();
                    }
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

    /// Fuzzy search over every path. Returns the best `limit` matches.
    pub fn search(&self, query: &str, limit: usize) -> Found {
        let tree = self.tree.read().expect("the index lock");
        let mut found = Found {
            hits: Vec::new(),
            total: 0,
            indexed: tree.count,
            ready: self.ready(),
        };
        let query = query.trim();
        if query.is_empty() || limit == 0 {
            return found;
        }
        let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
        let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
        let (mut chars, mut path) = (Vec::new(), String::new());

        let mut scored: Vec<Scored> = Vec::new();
        for (dir, nodes) in &tree.dirs {
            for (at, node) in nodes.iter().enumerate() {
                let by_name = pattern.score(Utf32Str::new(&node.name, &mut chars), &mut matcher);
                if let Some(score) = by_name {
                    scored.push((score + NAME_BONUS, dir, at, true));
                    continue;
                }
                if dir.is_empty() {
                    continue;
                }
                path.clear();
                path.push_str(dir);
                path.push('/');
                path.push_str(&node.name);
                if let Some(score) = pattern.score(Utf32Str::new(&path, &mut chars), &mut matcher) {
                    scored.push((score, dir, at, false));
                }
            }
        }
        found.total = scored.len();
        // Best score first; ties go to the shorter path, then by name, so results never shuffle.
        let rank = |a: &Scored, b: &Scored| {
            let (left, right) = (&*tree.dirs[a.1][a.2].name, &*tree.dirs[b.1][b.2].name);
            (b.0.cmp(&a.0))
                .then_with(|| (a.1.len() + left.len()).cmp(&(b.1.len() + right.len())))
                .then_with(|| (a.1, left).cmp(&(b.1, right)))
        };
        if scored.len() > limit {
            scored.select_nth_unstable_by(limit - 1, rank);
            scored.truncate(limit);
        }
        scored.sort_by(rank);

        for (_, dir, at, by_name) in scored {
            let node = &tree.dirs[dir][at];
            let path = paths::join(dir, &node.name);
            let mut idx = Vec::new();
            let hay = if by_name { &*node.name } else { path.as_str() };
            pattern.indices(Utf32Str::new(hay, &mut chars), &mut matcher, &mut idx);
            idx.sort_unstable();
            idx.dedup();
            found.hits.push(Hit {
                path,
                dir: node.dir,
                idx,
                name: by_name,
            });
        }
        found
    }
}

/// A time as the index keeps it: whole seconds, with zero for one that is not known.
fn seconds(time: Option<SystemTime>) -> u32 {
    time.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| u32::try_from(since.as_secs()).unwrap_or(u32::MAX))
}

/// One match: score, folder, position in that folder, and whether the name itself matched.
type Scored<'a> = (u32, &'a str, usize, bool);

impl Tree {
    /// Drops a folder and everything under it.
    fn remove(&mut self, dir: &str) {
        let mut todo = vec![dir.to_owned()];
        while let Some(dir) = todo.pop() {
            let Some(nodes) = self.dirs.remove(&dir) else { continue };
            self.count -= nodes.len();
            todo.extend(nodes.iter().filter(|n| n.walk).map(|n| paths::join(&dir, &n.name)));
        }
    }
}
