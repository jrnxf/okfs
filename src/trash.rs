//! The Trash: with `--allow-delete`, a delete moves the entry here instead of removing it, and it
//! stays for `--trash-days` days, 30 unless told otherwise. It can be put back where it was, or
//! deleted for good at once. What is older is deleted by a sweep.
//!
//! The Trash is a folder at the top of the served folder, `.okfs-trash`, which okfs never shows,
//! serves, searches or lets a request write to, even with `--hidden` (see `paths::TRASH`). Being on
//! the same disk as the files, a move in or out is one rename: instant for a folder of any size,
//! and whole or not at all. Each entry has a folder of its own, named by when it was deleted so a
//! listing comes in date order, holding the entry as `item` and what is known of it as `info.json`:
//!
//! ```text
//! .okfs-trash/
//!   01792790214-7f3a9c01/
//!     item          the file or folder, moved here whole
//!     info.json     {"path": "tides/old.csv", "deleted": 1792790214, "dir": false, "size": 9100, ...}
//! ```

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::paths::{self, Entry, Kept, NoEntry, Root, Unshown};
use crate::write::{self, Part};

/// How long the Trash keeps what is deleted, unless `--trash-days` says otherwise.
pub const DAYS: u32 = 30;
/// The name of an entry in its own folder in the Trash.
const ITEM: &str = "item";
/// The name of what is known of it.
const INFO: &str = "info.json";
const DAY: i64 = 24 * 60 * 60;

/// What is known of an entry in the Trash, kept beside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Info {
    /// Where it was, relative to the served folder: its real folder, then its name.
    pub path: String,
    /// When it was deleted, in seconds since 1970.
    pub deleted: i64,
    pub dir: bool,
    #[serde(default)]
    pub link: bool,
    /// Its size in bytes: for a folder, of all the files in it.
    pub size: u64,
    /// For a folder, how many entries it held.
    #[serde(default)]
    pub count: u64,
}

/// An entry in the Trash, as the page lists it.
#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub id: String,
    #[serde(flatten)]
    pub info: Info,
    /// When the sweep deletes it for good, in seconds since 1970.
    pub gone: i64,
}

/// Why an entry did not go to the Trash. Nothing changed.
#[derive(Debug)]
pub enum Refused {
    /// A folder that holds something okfs does not show: see `Root::whole`.
    Holds(Unshown),
    /// It is on another disk than the Trash, so it cannot be moved there in one step.
    OtherDisk,
    /// The disk refused, or the entry is no longer where it was found.
    Failed(io::Error),
}

impl From<io::Error> for Refused {
    fn from(error: io::Error) -> Self {
        Self::Failed(error)
    }
}

/// Why an entry was not put back. Nothing changed.
#[derive(Debug)]
pub enum Unrestored {
    /// There is no such entry in the Trash.
    Missing,
    /// Its place is no longer one okfs writes to: a name on the way is a file now, or is hidden.
    Blocked(String),
    Failed(io::Error),
}

impl From<io::Error> for Unrestored {
    fn from(error: io::Error) -> Self {
        Self::Failed(error)
    }
}

/// Where an entry went back to.
#[derive(Debug)]
pub struct Restored {
    /// Its path now, relative to the served folder. Its name differs from the one it had when that
    /// is taken: it comes back under the first free name like it, as an upload does.
    pub path: String,
    /// The folders it was in that were gone and were made again, the highest one, when any were.
    pub made: Option<String>,
}

pub struct Trash {
    dir: PathBuf,
    days: u32,
    /// One change to the Trash at a time: a sweep never removes what is being put back.
    busy: Mutex<()>,
}

/// Now, in seconds since 1970.
pub fn now() -> i64 {
    seconds(SystemTime::now())
}

fn seconds(at: SystemTime) -> i64 {
    at.duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs() as i64)
}

/// True for a name an entry's folder in the Trash can have: digits, a dash, hex. A request names
/// one by it, so nothing else is let near the disk.
fn is_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

impl Trash {
    /// The Trash of the served folder `root`, keeping what is deleted for `days` days. Nothing is
    /// made on disk until the first delete.
    pub fn new(root: &Root, days: u32) -> Self {
        Self {
            dir: root.dir().join(paths::TRASH),
            days: days.max(1),
            busy: Mutex::new(()),
        }
    }

    pub fn days(&self) -> u32 {
        self.days
    }

    fn hold(&self) -> std::sync::MutexGuard<'_, ()> {
        self.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// When an entry deleted at `deleted` goes for good.
    fn gone(&self, deleted: i64) -> i64 {
        deleted + i64::from(self.days) * DAY
    }

    /// Moves an entry found by `Root::entry` into the Trash. A folder goes only when all it holds is
    /// shown, as for a delete. A link goes as a link. Answers with what the Trash now lists for it.
    pub fn put(&self, root: &Root, entry: &Entry) -> Result<Item, Refused> {
        let _busy = self.hold();
        root.whole(entry).map_err(|kept| match kept {
            Kept::Holds(why) => Refused::Holds(why),
            Kept::Failed(error) | Kept::Partly(error) => Refused::Failed(error),
        })?;
        let now_entry = root.again(entry)?;
        let (size, count) = measure(now_entry.abs(), now_entry.is_dir());
        let deleted = now();
        let info = Info {
            path: now_entry.place(),
            deleted,
            dir: now_entry.is_dir(),
            link: now_entry.is_link(),
            size,
            count,
        };
        fs::create_dir_all(&self.dir)?;
        let (id, slot) = self.new_slot(deleted)?;
        let placed = write_info(&slot, &info).and_then(|()| fs::rename(now_entry.abs(), slot.join(ITEM)));
        if let Err(error) = placed {
            let _ = fs::remove_dir_all(&slot);
            return Err(if error.kind() == io::ErrorKind::CrossesDevices {
                Refused::OtherDisk
            } else {
                Refused::Failed(error)
            });
        }
        if let Some(folder) = now_entry.abs().parent() {
            write::sync_folder(folder);
        }
        write::sync_folder(&slot);
        Ok(Item {
            id,
            gone: self.gone(deleted),
            info,
        })
    }

    /// A fresh folder in the Trash for one entry, named so that the names sort by date.
    fn new_slot(&self, deleted: i64) -> io::Result<(String, PathBuf)> {
        loop {
            let mut bytes = [0u8; 4];
            getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
            let random: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            let id = format!("{deleted:011}-{random}");
            let slot = self.dir.join(&id);
            match fs::create_dir(&slot) {
                Ok(()) => return Ok((id, slot)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
    }

    /// What the Trash holds, the last deleted first. An entry whose folder lost its item or what is
    /// known of it, as a delete cut off part way leaves it, is not listed: the sweep removes it.
    pub fn list(&self) -> io::Result<Vec<Item>> {
        let _busy = self.hold();
        let mut items = self.read()?;
        items.sort_by(|a, b| b.id.cmp(&a.id));
        Ok(items)
    }

    fn read(&self) -> io::Result<Vec<Item>> {
        let names = match fs::read_dir(&self.dir) {
            Ok(names) => names,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut items = Vec::new();
        for name in names.flatten() {
            let Some(id) = name.file_name().to_str().filter(|id| is_id(id)).map(str::to_owned) else {
                continue;
            };
            let slot = name.path();
            if fs::symlink_metadata(slot.join(ITEM)).is_err() {
                continue;
            }
            let Some(info) = read_info(&slot) else { continue };
            items.push(Item {
                id,
                gone: self.gone(info.deleted),
                info,
            });
        }
        Ok(items)
    }

    /// Puts an entry back where it was. The folders it was in are made again when they are gone.
    /// When its name is taken there now, it comes back under the first free name like it.
    pub fn restore(&self, root: &Root, id: &str) -> Result<Restored, Unrestored> {
        let _busy = self.hold();
        if !is_id(id) {
            return Err(Unrestored::Missing);
        }
        let slot = self.dir.join(id);
        let item = slot.join(ITEM);
        let Some(info) = read_info(&slot).filter(|_| fs::symlink_metadata(&item).is_ok()) else {
            return Err(Unrestored::Missing);
        };
        let made = make_folders(root, paths::parent(&info.path))?;
        let place = root.target(&info.path).map_err(|why| match why {
            NoEntry::Missing => Unrestored::Blocked(paths::parent(&info.path).to_owned()),
            NoEntry::Root | NoEntry::NotServed => Unrestored::Blocked(info.path.clone()),
        })?;
        let name = write::rename_free(&item, &place.dir, &place.name)?;
        write::sync_folder(&place.dir);
        // What is left is what was known of it.
        let _ = fs::remove_dir_all(&slot);
        Ok(Restored {
            path: paths::join(&place.folder, &name),
            made,
        })
    }

    /// Deletes one entry in the Trash for good. False when there is no such entry.
    pub fn forget(&self, id: &str) -> io::Result<bool> {
        let _busy = self.hold();
        if !is_id(id) {
            return Ok(false);
        }
        let slot = self.dir.join(id);
        if fs::symlink_metadata(&slot).is_err() {
            return Ok(false);
        }
        remove_slot(&slot)?;
        Ok(true)
    }

    /// Deletes everything in the Trash for good. Answers with how many entries went.
    pub fn empty(&self) -> io::Result<usize> {
        let _busy = self.hold();
        let mut gone = 0;
        for item in self.read()? {
            remove_slot(&self.dir.join(&item.id))?;
            gone += 1;
        }
        self.clear_leftovers()?;
        Ok(gone)
    }

    /// Deletes for good what has been in the Trash longer than it keeps things, as of `now`, and
    /// what a delete cut off part way left. Answers with how many entries went.
    pub fn sweep(&self, now: i64) -> io::Result<usize> {
        let _busy = self.hold();
        let mut gone = 0;
        for item in self.read()? {
            if item.gone <= now {
                remove_slot(&self.dir.join(&item.id))?;
                gone += 1;
            }
        }
        self.clear_leftovers()?;
        Ok(gone)
    }

    /// Removes the folders in the Trash that hold no whole entry.
    fn clear_leftovers(&self) -> io::Result<()> {
        let Ok(names) = fs::read_dir(&self.dir) else {
            return Ok(());
        };
        for name in names.flatten() {
            let slot = name.path();
            let whole = fs::symlink_metadata(slot.join(ITEM)).is_ok() && read_info(&slot).is_some();
            if !whole && name.file_type().is_ok_and(|kind| kind.is_dir()) {
                remove_slot(&slot)?;
            }
        }
        Ok(())
    }
}

/// Removes one entry's folder in the Trash with all it holds. No link in it is followed.
fn remove_slot(slot: &Path) -> io::Result<()> {
    match fs::remove_dir_all(slot) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Writes what is known of an entry beside where it goes, whole or not at all.
fn write_info(slot: &Path, info: &Info) -> io::Result<()> {
    let mut part = Part::new(slot)?;
    let mut file: File = part.take_file().expect("a fresh part");
    file.write_all(&serde_json::to_vec(info).map_err(io::Error::other)?)?;
    file.sync_all()?;
    drop(file);
    part.create(&slot.join(INFO))
}

fn read_info(slot: &Path) -> Option<Info> {
    serde_json::from_slice(&fs::read(slot.join(INFO)).ok()?).ok()
}

/// The size of an entry, and for a folder how many entries it holds. No link is followed.
fn measure(abs: &Path, dir: bool) -> (u64, u64) {
    if !dir {
        return (fs::symlink_metadata(abs).map_or(0, |meta| meta.len()), 0);
    }
    let count = fs::read_dir(abs).map_or(0, |names| names.count() as u64);
    let mut size = 0;
    let mut todo = vec![abs.to_owned()];
    while let Some(dir) = todo.pop() {
        let Ok(names) = fs::read_dir(&dir) else { continue };
        for name in names.flatten() {
            let Ok(meta) = name.metadata() else { continue };
            if meta.is_dir() {
                todo.push(name.path());
            } else if meta.is_file() {
                size += meta.len();
            }
        }
    }
    (size, count)
}

/// Makes the folders on the path `dir` that are gone, one level at a time, each one okfs may
/// write to. Answers with the highest one it made, when it made any.
fn make_folders(root: &Root, dir: &str) -> Result<Option<String>, Unrestored> {
    let mut made = None;
    let mut at = String::new();
    for name in dir.split('/').filter(|name| !name.is_empty()) {
        at = paths::join(&at, name);
        let place = root.target(&at).map_err(|_| Unrestored::Blocked(at.clone()))?;
        match fs::symlink_metadata(place.abs()) {
            Ok(_) if place.abs().is_dir() => {}
            Ok(_) => return Err(Unrestored::Blocked(at)),
            Err(_) => {
                fs::create_dir(place.abs())?;
                write::sync_folder(&place.dir);
                made.get_or_insert_with(|| at.clone());
            }
        }
    }
    Ok(made)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Site {
        _tmp: tempfile::TempDir,
        root: Root,
        trash: Trash,
    }

    fn site() -> Site {
        let tmp = tempfile::TempDir::new().unwrap();
        let top = tmp.path().canonicalize().unwrap();
        fs::create_dir_all(top.join("tides/2026")).unwrap();
        fs::write(top.join("tides/old.csv"), "date,level\n").unwrap();
        fs::write(top.join("tides/2026/a.csv"), "aaaa").unwrap();
        fs::write(top.join("notes.md"), "# notes").unwrap();
        let root = Root::new(&top, false).unwrap();
        let trash = Trash::new(&root, DAYS);
        Site { _tmp: tmp, root, trash }
    }

    fn put(site: &Site, path: &str) -> Item {
        site.trash.put(&site.root, &site.root.entry(path).unwrap()).unwrap()
    }

    #[test]
    fn a_file_goes_to_the_trash_and_back_to_where_it_was() {
        let site = site();
        let item = put(&site, "tides/old.csv");
        assert!(!site.root.dir().join("tides/old.csv").exists());
        assert_eq!(item.info.path, "tides/old.csv");
        assert_eq!(item.info.size, 11);
        assert_eq!(item.gone - item.info.deleted, 30 * DAY);
        let listed = site.trash.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, item.id);

        let back = site.trash.restore(&site.root, &item.id).unwrap();
        assert_eq!(back.path, "tides/old.csv");
        assert_eq!(back.made, None);
        assert_eq!(
            fs::read_to_string(site.root.dir().join("tides/old.csv")).unwrap(),
            "date,level\n"
        );
        assert!(site.trash.list().unwrap().is_empty());
    }

    #[test]
    fn a_folder_goes_whole_and_comes_back_whole() {
        let site = site();
        let item = put(&site, "tides");
        assert!(item.info.dir);
        assert_eq!(item.info.count, 2);
        assert_eq!(item.info.size, 11 + 4);
        site.trash.restore(&site.root, &item.id).unwrap();
        assert_eq!(
            fs::read_to_string(site.root.dir().join("tides/2026/a.csv")).unwrap(),
            "aaaa"
        );
    }

    #[test]
    fn a_name_taken_since_comes_back_beside_it_and_a_gone_folder_is_made_again() {
        let site = site();
        let item = put(&site, "notes.md");
        fs::write(site.root.dir().join("notes.md"), "new").unwrap();
        let back = site.trash.restore(&site.root, &item.id).unwrap();
        assert_eq!(back.path, "notes (1).md");
        assert_eq!(fs::read_to_string(site.root.dir().join("notes.md")).unwrap(), "new");

        let deep = put(&site, "tides/2026/a.csv");
        fs::remove_dir_all(site.root.dir().join("tides")).unwrap();
        let back = site.trash.restore(&site.root, &deep.id).unwrap();
        assert_eq!(back.path, "tides/2026/a.csv");
        assert_eq!(back.made.as_deref(), Some("tides"));
    }

    #[test]
    fn a_folder_that_holds_a_dotfile_is_refused_and_nothing_moves() {
        let site = site();
        fs::write(site.root.dir().join("tides/.secret"), "x").unwrap();
        let refused = site.trash.put(&site.root, &site.root.entry("tides").unwrap());
        assert!(matches!(refused, Err(Refused::Holds(Unshown::Hidden))));
        assert!(site.root.dir().join("tides/old.csv").exists());
        assert!(site.trash.list().unwrap().is_empty());
    }

    #[test]
    fn the_sweep_deletes_only_what_is_older_than_the_days_it_keeps() {
        let site = site();
        let young = put(&site, "notes.md");
        let old = put(&site, "tides/old.csv");
        // Deleted 31 days ago, as far as the Trash knows.
        let slot = site.root.dir().join(paths::TRASH).join(&old.id);
        let mut info = old.info.clone();
        info.deleted -= 31 * DAY;
        fs::remove_file(slot.join(INFO)).unwrap();
        write_info(&slot, &info).unwrap();

        assert_eq!(site.trash.sweep(now()).unwrap(), 1);
        let left: Vec<String> = site.trash.list().unwrap().into_iter().map(|item| item.id).collect();
        assert_eq!(left, std::slice::from_ref(&young.id));
        // A day before its time it stays; at its time it goes.
        assert_eq!(site.trash.sweep(young.gone - 1).unwrap(), 0);
        assert_eq!(site.trash.sweep(young.gone).unwrap(), 1);
        assert!(site.trash.list().unwrap().is_empty());
    }

    #[test]
    fn days_set_how_long_it_keeps() {
        let site = site();
        let trash = Trash::new(&site.root, 2);
        let item = trash.put(&site.root, &site.root.entry("notes.md").unwrap()).unwrap();
        assert_eq!(item.gone - item.info.deleted, 2 * DAY);
        assert_eq!(trash.sweep(item.info.deleted + DAY).unwrap(), 0);
        assert_eq!(trash.sweep(item.info.deleted + 2 * DAY).unwrap(), 1);
    }

    #[test]
    fn forget_and_empty_delete_for_good() {
        let site = site();
        let one = put(&site, "notes.md");
        put(&site, "tides");
        assert!(site.trash.forget(&one.id).unwrap());
        assert!(!site.trash.forget(&one.id).unwrap());
        assert_eq!(site.trash.empty().unwrap(), 1);
        assert!(site.trash.list().unwrap().is_empty());
        assert!(!site.root.dir().join("notes.md").exists());
    }

    #[test]
    fn a_name_that_is_not_an_id_reaches_nothing() {
        let site = site();
        put(&site, "notes.md");
        for id in ["..", "../notes.md", "a/b", "", ".okfs-trash"] {
            assert!(
                matches!(site.trash.restore(&site.root, id), Err(Unrestored::Missing)),
                "{id}"
            );
            assert!(!site.trash.forget(id).unwrap(), "{id}");
        }
        assert_eq!(site.trash.list().unwrap().len(), 1);
    }

    #[test]
    fn a_leftover_of_a_cut_off_delete_is_swept_and_not_listed() {
        let site = site();
        let slot = site.root.dir().join(paths::TRASH).join("00000000001-deadbeef");
        fs::create_dir_all(&slot).unwrap();
        fs::write(slot.join(INFO), "{").unwrap();
        assert!(site.trash.list().unwrap().is_empty());
        site.trash.sweep(now()).unwrap();
        assert!(!slot.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_goes_as_a_link_and_what_it_points_at_stays() {
        let site = site();
        std::os::unix::fs::symlink("notes.md", site.root.dir().join("to-notes")).unwrap();
        let item = put(&site, "to-notes");
        assert!(item.info.link);
        assert!(site.root.dir().join("notes.md").exists());
        site.trash.empty().unwrap();
        assert!(site.root.dir().join("notes.md").exists());
    }
}
