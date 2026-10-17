//! Every name in the served tree, held in memory for the palette's search, with the
//! time each file was last written. One walk at start builds it; a file watcher keeps
//! it fresh after that. The same watcher is what open pages follow: every change it
//! reads is told to the feed.

use std::cmp::Reverse;
use std::collections::{BTreeSet, BinaryHeap, HashMap, HashSet};
use std::fs;
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

use crate::live::{Change, Feed};
use crate::paths::{self, Resolved, Root};

/// How long the tree must be quiet before changes are read.
const SETTLE: Duration = Duration::from_millis(150);
/// The longest a busy tree can delay a read.
const MAX_WAIT: Duration = Duration::from_secs(2);
/// How often the tree is walked again when no watcher could be set up.
const POLL: Duration = Duration::from_secs(30);
/// A match on the name itself outranks a match somewhere in the path.
const NAME_BONUS: u32 = 64;
/// How many files are listed as the ones written last.
const RECENT: usize = 8;

struct Node {
    name: Box<str>,
    dir: bool,
    /// A real folder, not a link to one: the walk goes in.
    walk: bool,
    /// When a file was last written, in seconds. Zero for a folder, for a link, and for
    /// a time that could not be read. Kept as 32 bits so a node stays as small as it was.
    modified: u32,
}

impl Node {
    /// All that a listing tells of an entry.
    fn shape(&self) -> (&str, bool, bool) {
        (&self.name, self.dir, self.walk)
    }
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
    feed: Feed,
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
    /// Newest first. Files with the same time are ordered by folder, then by name.
    pub files: Vec<Changed>,
}

impl Index {
    /// An empty index. Call `build` to fill it.
    pub fn new(root: Root) -> Arc<Self> {
        Arc::new(Self {
            root,
            tree: RwLock::default(),
            ready: AtomicBool::new(false),
            feed: Feed::default(),
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
        // The watcher goes where the walk goes: into real folders, and through no link.
        let config = notify::Config::default().with_follow_symlinks(false);
        let watcher = notify::RecommendedWatcher::new(send, config).and_then(|mut watcher| {
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
                    self.rebuild();
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

    /// The changes to the served folder, for the pages that are open.
    pub fn feed(&self) -> &Feed {
        &self.feed
    }

    /// Walks the whole served folder and replaces the index with what it finds.
    pub fn build(&self) {
        let fresh = self.walk("");
        *self.tree.write().expect("the index lock") = fresh;
        self.ready.store(true, Ordering::Release);
    }

    fn walk(&self, from: &str) -> Tree {
        let mut tree = Tree::default();
        let mut todo = vec![from.to_owned()];
        while let Some(dir) = todo.pop() {
            let Some(nodes) = self.read(&dir) else { continue };
            todo.extend(nodes.iter().filter(|n| n.walk).map(|n| paths::join(&dir, &n.name)));
            tree.count += nodes.len();
            tree.dirs.insert(dir, nodes);
        }
        tree
    }

    /// The names in one folder, each file with the time the disk has for it now.
    fn read(&self, dir: &str) -> Option<Vec<Node>> {
        let at = self.root.dir().join(dir);
        let seen = self.root.scan(&at).ok()?;
        Some(
            seen.into_iter()
                .map(|s| {
                    let modified = if s.dir {
                        0
                    } else {
                        seconds(self.root.modified(&at, &s.name))
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
                if wrote {
                    written.insert(path.clone());
                } else if let Some(dir) = self.dir_of(&path) {
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
        for (dir, files) in told {
            self.feed.tell(Change::Folder { dir, files });
        }
        if !arrived.is_empty() {
            self.feed.tell(Change::Sync);
        }
    }

    /// Reads the time of each written file again, the way `read` does, and writes it
    /// into the index: one look at the disk per file, however often it was written to
    /// since the last batch.
    fn restamp(&self, written: HashSet<PathBuf>) {
        let mut stamps: HashMap<String, HashMap<String, u32>> = HashMap::new();
        for path in written {
            let (Some(dir), Some(name)) = (self.dir_of(&path), path.file_name().and_then(|name| name.to_str())) else {
                continue;
            };
            let time = seconds(self.root.modified(&self.root.dir().join(&dir), name));
            stamps.entry(dir).or_default().insert(name.to_owned(), time);
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
        if self.refresh(dir) {
            self.feed.tell(Change::Folder {
                dir: dir.to_owned(),
                files: Vec::new(),
            });
        }
    }

    /// Reads one folder again and folds what changed into the index. True when the
    /// folder does not list what it listed before.
    fn refresh(&self, dir: &str) -> bool {
        let Some(nodes) = self.read(dir) else {
            return self.forget(dir);
        };
        let known: HashSet<String> = {
            let tree = self.tree.read().expect("the index lock");
            match tree.dirs.get(dir) {
                Some(old) => old.iter().filter(|n| n.walk).map(|n| n.name.to_string()).collect(),
                // Not indexed yet: its parent's reread will walk it.
                None if !dir.is_empty() => return false,
                None => HashSet::new(),
            }
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
        let Some(old) = tree.dirs.insert(dir.to_owned(), nodes) else {
            return true;
        };
        tree.count -= old.len();
        let now = &tree.dirs[dir];
        let before: HashSet<(&str, bool, bool)> = old.iter().map(Node::shape).collect();
        old.len() != now.len() || now.iter().any(|node| !before.contains(&node.shape()))
    }

    /// Walks one folder again with everything under it, in place of what the index
    /// held of it, and tells the pages. For a folder that changed at more than one
    /// depth: `reread` looks at one folder only.
    pub fn rewalk(&self, dir: &str) {
        // It changed at depths no single folder names.
        if self.walk_again(dir) {
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
        let fresh = self.walk(dir);
        let mut tree = self.tree.write().expect("the index lock");
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
        let mut tree = self.tree.write().expect("the index lock");
        let held = tree.dirs.contains_key(dir);
        tree.remove(dir);
        held
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

    /// The files written last, newest first. Read from memory: the disk is not looked
    /// at. Folders and links never appear, and neither does a file whose time is unknown.
    pub fn recent(&self) -> Recent {
        let tree = self.tree.read().expect("the index lock");
        // Newer is greater, and of two with the same time the earlier folder, then the
        // earlier name, is greater.
        // The heap keeps the `RECENT` greatest, its least on top.
        let mut best = BinaryHeap::with_capacity(RECENT + 1);
        for (dir, nodes) in &tree.dirs {
            for node in nodes.iter().filter(|n| !n.dir && n.modified != 0) {
                best.push(Reverse((node.modified, Reverse(dir.as_str()), Reverse(&*node.name))));
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
        let mut idx = Vec::new();
        for (dir, nodes) in &tree.dirs {
            for (at, node) in nodes.iter().enumerate() {
                let by_name = pattern.score(Utf32Str::new(&node.name, &mut chars), &mut matcher);
                if let Some(score) = by_name {
                    let close = is_close(&pattern, &node.name, &mut idx, &mut chars, &mut matcher);
                    scored.push((score + NAME_BONUS, dir, at, true, close));
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
                    let close = is_close(&pattern, &path, &mut idx, &mut chars, &mut matcher);
                    scored.push((score, dir, at, false, close));
                }
            }
        }
        // Letters spread over a whole path are a match of last resort: they only show when nothing is closer.
        if scored.iter().any(|s| s.4) {
            scored.retain(|s| s.4);
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

        for (_, dir, at, by_name, _) in scored {
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

/// One match: score, folder, position in that folder, whether the name itself matched, and whether
/// its letters sit close together (see `is_close`).
type Scored<'a> = (u32, &'a str, usize, bool, bool);

/// Whether every matched letter of `hay` either follows the one before it or starts a word. A query
/// found as a run, or as the starts of words, is close; letters picked out of the middle of
/// several words are not.
fn is_close(pattern: &Pattern, hay: &str, idx: &mut Vec<u32>, chars: &mut Vec<char>, matcher: &mut Matcher) -> bool {
    idx.clear();
    pattern.indices(Utf32Str::new(hay, chars), matcher, idx);
    idx.sort_unstable();
    idx.dedup();
    let letters: Vec<char> = hay.chars().collect();
    let mut last = None;
    idx.iter().all(|&i| {
        let i = i as usize;
        let ok = last.is_some_and(|l| i == l + 1) || i == 0 || letters.get(i - 1).is_some_and(|c| !c.is_alphanumeric());
        last = Some(i);
        ok
    })
}

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
            let tmp = tempfile::TempDir::new().unwrap();
            let top = tmp.path().canonicalize().unwrap();
            let (served, outside) = (top.join("served"), top.join("outside"));
            fs::create_dir_all(served.join("sub")).unwrap();
            fs::create_dir_all(&outside).unwrap();
            fs::write(served.join("a.txt"), "a").unwrap();
            fs::write(served.join("sub/b.txt"), "b").unwrap();
            fs::write(outside.join("secret.txt"), "secret").unwrap();
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
            let hits = site.index.search(query, 10).hits;
            hits.into_iter().map(|hit| hit.path).collect()
        };
        assert_eq!(found("fresh"), ["sub/fresh.txt"]);
        assert_eq!(found("inner"), ["sub/deep/inner.txt"]);
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
                .search(query, 10)
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
        let hits = site.index.search("more", 10).hits;
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
}
