//! Every name in the served tree, held in memory for the palette's search.
//! One walk at start builds it; a file watcher keeps it fresh after that. The same
//! watcher is what open pages follow: every change it reads is told to the feed.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use notify::event::{EventKind, ModifyKind};
use notify::{RecursiveMode, Watcher};
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;

use crate::live::{BACKLOG, Change, Feed};
use crate::paths::{self, Root};

/// How long the tree must be quiet before changes are read.
const SETTLE: Duration = Duration::from_millis(150);
/// The longest a busy tree can delay a read.
const MAX_WAIT: Duration = Duration::from_secs(2);
/// How often the tree is walked again when no watcher could be set up.
const POLL: Duration = Duration::from_secs(30);
/// A file that is written without a pause for longer than this is told all the same,
/// so that a log that never rests still moves on the page.
const MAX_HOLD: Duration = Duration::from_secs(10);
/// One read that finds more changed folders than this tells the pages to read
/// everything again. It leaves room in the feed, so a page in step stays in step.
const MAX_TOLD: usize = BACKLOG / 2;
/// More written files than this in one folder are not named one by one.
const MAX_NAMED: usize = 32;
/// A match on the name itself outranks a match somewhere in the path.
const NAME_BONUS: u32 = 64;

/// What the watcher saw, each with the time it was read.
type Batch = Vec<(Instant, notify::Result<notify::Event>)>;
/// Paths the watcher touched and the pages have not been told of yet, each with the
/// first and the last time it was seen.
type Held = HashMap<PathBuf, (Instant, Instant)>;

struct Node {
    name: Box<str>,
    dir: bool,
    /// A real folder, not a link to one: the walk goes in.
    walk: bool,
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
                    self.rebuild();
                }
            }
        };

        let mut held = Held::new();
        loop {
            // While files are held back the wait is short: they are told once they rest.
            let first = if held.is_empty() {
                events.recv().map_err(|_| RecvTimeoutError::Disconnected)
            } else {
                events.recv_timeout(SETTLE)
            };
            let started = Instant::now();
            let mut batch = Batch::new();
            // True while the tree has not been quiet since the last event.
            let mut busy = match first {
                Ok(event) => {
                    batch.push((started, event));
                    true
                }
                Err(RecvTimeoutError::Timeout) => false,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            while busy && started.elapsed() < MAX_WAIT {
                match events.recv_timeout(SETTLE) {
                    Ok(event) => batch.push((Instant::now(), event)),
                    Err(RecvTimeoutError::Timeout) => busy = false,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            self.absorb(batch, busy, &mut held);
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

    fn read(&self, dir: &str) -> Option<Vec<Node>> {
        let at = self.root.dir().join(dir);
        let seen = self.root.scan(&at).ok()?;
        Some(
            seen.into_iter()
                .map(|s| Node {
                    name: s.name.into_boxed_str(),
                    dir: s.dir,
                    walk: s.dir && !s.link,
                })
                .collect(),
        )
    }

    /// Walks everything again and tells the pages to do the same.
    fn rebuild(&self) {
        self.build();
        self.feed.tell(Change::Sync);
    }

    /// Folds what the watcher saw into the index and tells the pages. `busy` says the
    /// tree was still changing when the batch was cut off. `held` carries the files
    /// that are still being written over to the next batch: a page is told of a written
    /// file once it has settled, so a preview never shows one half written.
    fn absorb(&self, batch: Batch, busy: bool, held: &mut Held) {
        let mut dirty = HashSet::new();
        for (at, event) in batch {
            let Ok(event) = event else {
                held.clear();
                return self.rebuild();
            };
            if event.need_rescan() {
                held.clear();
                return self.rebuild();
            }
            if matches!(event.kind, EventKind::Access(_)) {
                continue;
            }
            // A write changes no name, so the index has nothing to read again for it.
            let written = matches!(
                event.kind,
                EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_))
            );
            for path in event.paths {
                if !written && let Some(dir) = self.dir_of(&path) {
                    dirty.insert(dir);
                }
                held.entry(path).or_insert((at, at)).1 = at;
            }
        }

        // The files that have settled, by folder. Only what a listing shows is named.
        let mut settled: HashMap<String, Vec<String>> = HashMap::new();
        held.retain(|path, (first, last)| {
            if busy && last.elapsed() < SETTLE && first.elapsed() < MAX_HOLD {
                return true;
            }
            if let Some(dir) = self.dir_of(path) {
                let names = settled.entry(dir).or_default();
                if names.len() <= MAX_NAMED
                    && let Some(name) = self.shown_file(path)
                {
                    names.push(name);
                }
            }
            false
        });

        let mut told = Vec::new();
        let dirs: HashSet<String> = dirty.iter().chain(settled.keys()).cloned().collect();
        for dir in dirs {
            let reshaped = dirty.contains(&dir) && self.refresh(&dir);
            let names = settled.remove(&dir).unwrap_or_default();
            if reshaped || !names.is_empty() {
                let files = (names.len() <= MAX_NAMED).then_some(names);
                told.push(Change::Folder { dir, files });
            }
        }
        if told.len() > MAX_TOLD {
            return self.feed.tell(Change::Sync);
        }
        for change in told {
            self.feed.tell(change);
        }
    }

    /// The indexed folder a changed path sits in, by its real place, or `None` when
    /// it is not shown.
    fn dir_of(&self, path: &Path) -> Option<String> {
        let inner = path.parent()?.strip_prefix(self.root.dir()).ok()?;
        let rel = inner.to_str()?.replace(std::path::MAIN_SEPARATOR, "/");
        self.root.place(&self.root.resolve(&rel)?)
    }

    /// The name of a changed path, when it is a file that a listing shows.
    fn shown_file(&self, path: &Path) -> Option<String> {
        let inner = path.strip_prefix(self.root.dir()).ok()?;
        let rel = inner.to_str()?.replace(std::path::MAIN_SEPARATOR, "/");
        let found = self.root.resolve(&rel).filter(|found| found.meta.is_file())?;
        Some(paths::file_name(&found.rel).to_owned())
    }

    /// Reads one folder again, folds what changed into the index and tells the pages.
    /// The watcher does this by itself a moment later; a delete calls it so the entry
    /// is gone at once.
    pub fn reread(&self, dir: &str) {
        if self.refresh(dir) {
            self.feed.tell(Change::Folder {
                dir: dir.to_owned(),
                files: Some(Vec::new()),
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
        drop(tree);
        // It changed at depths no single folder names.
        self.feed.tell(Change::Sync);
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

#[cfg(test)]
mod tests {
    use std::fs;
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
        held: Held,
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
                held: Held::new(),
            }
        }

        /// Hands the index what a watcher would have seen, after the tree went quiet.
        fn see(&mut self, events: &[(EventKind, &str)]) -> Vec<Change> {
            self.see_at(events, Instant::now(), false)
        }

        fn see_at(&mut self, events: &[(EventKind, &str)], at: Instant, busy: bool) -> Vec<Change> {
            let batch = events
                .iter()
                .map(|(kind, path)| (at, Ok(Event::new(*kind).add_path(self.served.join(path)))))
                .collect();
            self.index.absorb(batch, busy, &mut self.held);
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
            files: Some(files.iter().map(|name| (*name).to_owned()).collect()),
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
    fn a_burst_of_files_in_one_folder_is_one_change_that_names_none() {
        let mut site = Watched::new(false);
        let names: Vec<String> = (0..500).map(|at| format!("sub/burst-{at}.txt")).collect();
        let mut events = Vec::new();
        for name in &names {
            fs::write(site.served.join(name), "x").unwrap();
            events.extend([(CREATE, name.as_str()), (WRITE, name.as_str())]);
        }
        let told = site.see(&events);
        assert_eq!(
            told,
            [Change::Folder {
                dir: "sub".to_owned(),
                files: None
            }]
        );
        assert_eq!(site.index.child_count("sub"), Some(501));
    }

    #[test]
    fn a_burst_across_many_folders_is_one_call_to_catch_up() {
        let mut site = Watched::new(false);
        let names: Vec<String> = (0..=MAX_TOLD).map(|at| format!("dir-{at}")).collect();
        for name in &names {
            fs::create_dir(site.served.join(name)).unwrap();
        }
        site.index.build();
        let files: Vec<String> = names.iter().map(|name| format!("{name}/new.txt")).collect();
        for file in &files {
            fs::write(site.served.join(file), "x").unwrap();
        }
        let events: Vec<_> = files.iter().map(|file| (CREATE, file.as_str())).collect();
        assert_eq!(site.see(&events), [Change::Sync]);
    }

    #[test]
    fn a_file_still_being_written_is_told_once_it_has_settled() {
        let mut site = Watched::new(false);
        fs::write(site.served.join("a.txt"), "half").unwrap();
        // The batch was cut off while the file was still being written.
        assert_eq!(site.see_at(&[(WRITE, "a.txt")], Instant::now(), true), []);
        assert_eq!(site.held.len(), 1);
        // No more came: it has settled.
        assert_eq!(site.see(&[]), [folder("", &["a.txt"])]);
        assert!(site.held.is_empty());
    }

    #[test]
    fn a_file_that_never_rests_is_told_all_the_same() {
        let mut site = Watched::new(false);
        let long_ago = Instant::now().checked_sub(MAX_HOLD * 2).unwrap();
        site.held.insert(site.served.join("a.txt"), (long_ago, long_ago));
        let told = site.see_at(&[(WRITE, "a.txt")], Instant::now(), true);
        assert_eq!(told, [folder("", &["a.txt"])]);
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
        site.index
            .absorb(vec![(Instant::now(), Ok(lost))], false, &mut site.held);
        assert_eq!(site.told(), [Change::Sync]);
    }
}
