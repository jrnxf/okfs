//! Putting a file in place, whole or not at all. A file is written beside where it goes, under a
//! name that is never shown, synced to disk, and only then given its name: a reader sees the old
//! file or the new one, never part of one. See `Part`.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};

use crate::paths::PART;

/// Names tried after the one asked for, when a file is kept beside one of the same name, at most.
const MAX_COPIES: u32 = 999;

/// A file that a write is putting together, beside where it goes. It is removed when it is dropped,
/// unless it was put in place: when the write fails, when the request is dropped part way, and once
/// a link has given it its name. Its name starts with a dot and is never shown, even with
/// `--hidden`: see `paths::is_part`.
pub struct Part {
    path: PathBuf,
    file: Option<File>,
    placed: bool,
}

impl Part {
    /// Makes an empty file in the folder `dir`, under a name no other write can have.
    pub fn new(dir: &Path) -> io::Result<Self> {
        let (start, end) = PART;
        loop {
            let mut bytes = [0u8; 8];
            getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
            let random: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            let path = dir.join(format!("{start}{random}{end}"));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        file: Some(file),
                        placed: false,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
    }

    /// The open file, to write the body into. Taken once.
    pub fn take_file(&mut self) -> Option<File> {
        self.file.take()
    }

    /// Gives the file the permissions of the file it replaces, so that a script stays one that
    /// runs. The owner stays only when okfs runs as the file's owner, which is the usual case.
    pub fn permissions_of(&self, file: &Path) -> io::Result<()> {
        fs::set_permissions(&self.path, fs::metadata(file)?.permissions())
    }

    /// Puts the file in place under a new name in its folder, and never over an entry that is
    /// there: that fails with `AlreadyExists`, and nothing is changed. A hard link gives the
    /// name, which the disk refuses atomically when the name is taken. A disk that has no hard
    /// links, such as FAT, gets a rename that the disk refuses atomically in the same way; where
    /// there is no such rename either, the write is refused with `Unsupported`.
    pub fn create(&mut self, to: &Path) -> io::Result<()> {
        match fs::hard_link(&self.path, to) {
            Ok(()) => {
                // The new name holds the file now. The name it was put together under goes when
                // this is dropped.
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(error),
            Err(_) => self.rename_new(to),
        }
    }

    /// Renames the file to `to` in one step that the disk refuses when the name is taken. See
    /// `rename_new`.
    fn rename_new(&mut self, to: &Path) -> io::Result<()> {
        rename_new(&self.path, to)?;
        self.placed = true;
        Ok(())
    }

    /// Puts the file in place under the first free name of `name`, `name (1)`, `name (2)` and so on
    /// up to `MAX_COPIES`, in the folder `dir`, with `create`. Answers with the name it took.
    pub fn create_free(&mut self, dir: &Path, name: &str) -> io::Result<String> {
        for copy in 0..=MAX_COPIES {
            let tried = if copy == 0 {
                name.to_owned()
            } else {
                numbered(name, copy)
            };
            match self.create(&dir.join(&tried)) {
                Ok(()) => return Ok(tried),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        Err(io::ErrorKind::AlreadyExists.into())
    }

    /// Puts the file in place over the file `to`, in one step: a reader sees the old file or this
    /// one. `to` is the real file, never a link to it, so a link stays a link. A hard link to the
    /// old file keeps the old file.
    pub fn replace(&mut self, to: &Path) -> io::Result<()> {
        fs::rename(&self.path, to)?;
        self.placed = true;
        Ok(())
    }
}

impl Drop for Part {
    fn drop(&mut self) {
        self.file.take();
        if !self.placed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Renames `from` to `to`, a file or a folder, in one step that the disk refuses with
/// `AlreadyExists` when the name is taken: `renameat2` with `RENAME_NOREPLACE` on Linux,
/// `renameatx_np` with `RENAME_EXCL` on macOS. A disk that cannot refuse that way answers
/// `Unsupported`, and nothing is renamed. Across disks the answer is `CrossesDevices`.
#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
pub fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    use rustix::fs::{CWD, RenameFlags, renameat_with};
    renameat_with(CWD, from, CWD, to, RenameFlags::NOREPLACE).map_err(|errno| match io::Error::from(errno) {
        error if error.kind() == io::ErrorKind::InvalidInput => io::ErrorKind::Unsupported.into(),
        error => error,
    })
}

/// No rename here can refuse a name that is taken, so none is tried.
#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
pub fn rename_new(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}

/// Renames `from` to the first free name of `name`, `name (1)`, `name (2)` and so on up to
/// `MAX_COPIES`, in the folder `dir`, with `rename_new`. Answers with the name it took.
pub fn rename_free(from: &Path, dir: &Path, name: &str) -> io::Result<String> {
    for copy in 0..=MAX_COPIES {
        let tried = if copy == 0 {
            name.to_owned()
        } else {
            numbered(name, copy)
        };
        match rename_new(from, &dir.join(&tried)) {
            Ok(()) => return Ok(tried),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::ErrorKind::AlreadyExists.into())
}

/// A folder that a copy is putting together, beside where it goes, under a name that is never
/// shown. It is removed with what it holds when it is dropped, unless it was put in place.
pub struct PartDir {
    path: PathBuf,
    placed: bool,
}

impl PartDir {
    /// Makes an empty folder in the folder `dir`, under a name no other write can have.
    pub fn new(dir: &Path) -> io::Result<Self> {
        let (start, end) = PART;
        loop {
            let mut bytes = [0u8; 8];
            getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
            let random: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            let path = dir.join(format!("{start}{random}{end}"));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path, placed: false }),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Puts the folder in place under the name `name` in `dir`, or with `keep` under the first free
    /// name like it, never over an entry that is there. Answers with the name it took.
    pub fn place(&mut self, dir: &Path, name: &str, keep: bool) -> io::Result<String> {
        let took = if keep {
            rename_free(&self.path, dir, name)?
        } else {
            rename_new(&self.path, &dir.join(name))?;
            name.to_owned()
        };
        self.placed = true;
        Ok(took)
    }
}

impl Drop for PartDir {
    fn drop(&mut self) {
        if !self.placed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

/// `name` with a number before its extension: `tides.csv` and 2 make `tides (2).csv`.
pub fn numbered(name: &str, copy: u32) -> String {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => format!("{stem} ({copy}).{extension}"),
        _ => format!("{name} ({copy})"),
    }
}

/// Syncs a folder, so that a name given in it stays after a power cut. Only Unix can open a folder
/// to sync it. A failure here leaves the file in place, so it is not told.
pub fn sync_folder(dir: &Path) {
    #[cfg(unix)]
    if let Ok(folder) = File::open(dir) {
        let _ = folder.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// The paths being written, one write at a time on each: the check that a file is still the one
/// its writer read, and the step that replaces it, are never split by another write from okfs. A
/// program outside okfs can still write between the two, for the moment they take.
#[derive(Default)]
pub struct Locks {
    held: Mutex<HashSet<PathBuf>>,
    freed: Condvar,
}

/// One path held by `Locks::hold`, let go when dropped.
pub struct Held<'a> {
    locks: &'a Locks,
    path: PathBuf,
}

impl Locks {
    /// Waits until no other write holds `path`, then holds it.
    pub fn hold(&self, path: &Path) -> Held<'_> {
        let mut held = self.held.lock().expect("the write lock");
        while held.contains(path) {
            held = self.freed.wait(held).expect("the write lock");
        }
        held.insert(path.to_owned());
        Held {
            locks: self,
            path: path.to_owned(),
        }
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        self.locks.held.lock().expect("the write lock").remove(&self.path);
        self.locks.freed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn part_with(dir: &Path, text: &str) -> Part {
        let mut part = Part::new(dir).unwrap();
        let mut file = part.take_file().unwrap();
        file.write_all(text.as_bytes()).unwrap();
        file.sync_all().unwrap();
        part
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_copy_is_numbered_before_its_extension() {
        assert_eq!(numbered("tides.csv", 1), "tides (1).csv");
        assert_eq!(numbered("Makefile", 2), "Makefile (2)");
        assert_eq!(numbered(".env", 3), ".env (3)");
        assert_eq!(numbered("a.tar.gz", 1), "a.tar (1).gz");
    }

    #[test]
    fn a_new_file_never_lands_on_a_name_that_is_taken() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        fs::write(dir.join("taken.txt"), "old").unwrap();

        let mut part = part_with(dir, "new");
        let error = part.create(&dir.join("taken.txt")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        drop(part);
        assert_eq!(fs::read_to_string(dir.join("taken.txt")).unwrap(), "old");
        assert_eq!(names(dir), ["taken.txt"]);

        let mut part = part_with(dir, "new");
        assert_eq!(part.create_free(dir, "taken.txt").unwrap(), "taken (1).txt");
        drop(part);
        assert_eq!(fs::read_to_string(dir.join("taken (1).txt")).unwrap(), "new");
        assert_eq!(names(dir), ["taken (1).txt", "taken.txt"]);
    }

    #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
    #[test]
    fn a_rename_without_hard_links_never_lands_on_a_name_that_is_taken() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        fs::write(dir.join("taken.txt"), "old").unwrap();

        let mut part = part_with(dir, "new");
        let error = part.rename_new(&dir.join("taken.txt")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        drop(part);
        assert_eq!(fs::read_to_string(dir.join("taken.txt")).unwrap(), "old");
        assert_eq!(names(dir), ["taken.txt"]);

        let mut part = part_with(dir, "new");
        part.rename_new(&dir.join("free.txt")).unwrap();
        drop(part);
        assert_eq!(fs::read_to_string(dir.join("free.txt")).unwrap(), "new");
        assert_eq!(names(dir), ["free.txt", "taken.txt"]);
    }

    #[test]
    fn a_replace_swaps_the_whole_file_and_leaves_nothing_behind() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        fs::write(dir.join("notes.md"), "old").unwrap();
        let mut part = part_with(dir, "new");
        part.replace(&dir.join("notes.md")).unwrap();
        drop(part);
        assert_eq!(fs::read_to_string(dir.join("notes.md")).unwrap(), "new");
        assert_eq!(names(dir), ["notes.md"]);
    }

    #[test]
    fn a_write_given_up_leaves_nothing_behind() {
        let tmp = tempfile::TempDir::new().unwrap();
        drop(part_with(tmp.path(), "half"));
        assert!(names(tmp.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_file_keeps_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::TempDir::new().unwrap();
        let script = tmp.path().join("run.sh");
        fs::write(&script, "old").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o750)).unwrap();
        let mut part = part_with(tmp.path(), "new");
        part.permissions_of(&script).unwrap();
        part.replace(&script).unwrap();
        assert_eq!(fs::metadata(&script).unwrap().permissions().mode() & 0o777, 0o750);
    }

    #[test]
    fn one_write_at_a_time_holds_a_path() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let locks = Arc::new(Locks::default());
        let inside = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let (locks, inside, most) = (Arc::clone(&locks), Arc::clone(&inside), Arc::clone(&most));
                std::thread::spawn(move || {
                    let _held = locks.hold(Path::new("/served/a.txt"));
                    let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                    most.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(2));
                    inside.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(most.load(Ordering::SeqCst), 1);
        // Another path is never held up by it.
        let _a = locks.hold(Path::new("/served/a.txt"));
        let _b = locks.hold(Path::new("/served/b.txt"));
    }
}
