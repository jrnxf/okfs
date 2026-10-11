//! The served folder. Every request path becomes a place on disk here and nowhere else.

use std::cmp::Ordering;
use std::ffi::OsStr;
use std::fs::{self, FileType, Metadata};
use std::io;
use std::path::{Component, Path, PathBuf};

/// The served folder and the rules for what inside it may be shown.
#[derive(Debug, Clone)]
pub struct Root {
    dir: PathBuf,
    hidden: bool,
}

/// A request path that passed every check.
#[derive(Debug)]
pub struct Resolved {
    /// Where it really is, after following links.
    pub abs: PathBuf,
    /// The path as asked for, cleaned: no leading slash, no empty segments.
    pub rel: String,
    pub meta: Metadata,
}

/// An entry that may be removed. See `Root::entry`.
#[derive(Debug)]
pub struct Entry {
    /// Where it is: its real folder, then its own name. A link is not followed.
    abs: PathBuf,
    /// The real folder holding it, relative to the served folder.
    pub folder: String,
    /// Of the entry itself, not of what a link points at.
    meta: Metadata,
}

impl Entry {
    /// True for a link: removing it leaves what it points at where it is.
    pub fn is_link(&self) -> bool {
        self.meta.file_type().is_symlink()
    }
}

/// Why a request path names nothing that may be removed.
#[derive(Debug, PartialEq, Eq)]
pub enum NoEntry {
    /// It is the served folder itself.
    Root,
    /// It is not a plain path to something shown: it steps up, or names a hidden entry.
    NotServed,
    /// Nothing shown is there: no entry at all, a link that is not shown, or a folder
    /// that is not inside the served folder.
    Missing,
}

/// Why a name in a folder is not shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unshown {
    /// It starts with a dot, and dotfiles are not served.
    Hidden,
    /// It cannot be served: a link that leads nowhere or out of what is served, or a
    /// name that is not text.
    Unserved,
}

/// Why `Root::remove` left an entry where it was.
#[derive(Debug)]
pub enum Kept {
    /// It is a folder that holds, at some depth, something that is not shown. Nothing
    /// was removed.
    Holds(Unshown),
    /// The disk refused. A folder may be half gone.
    Failed(io::Error),
}

impl From<io::Error> for Kept {
    fn from(error: io::Error) -> Self {
        Self::Failed(error)
    }
}

/// One name found in a folder.
#[derive(Debug, Clone)]
pub struct Seen {
    pub name: String,
    pub dir: bool,
    /// Reached through a symbolic link. Links are shown, but never walked into.
    pub link: bool,
}

impl Root {
    pub fn new(dir: &Path, hidden: bool) -> io::Result<Self> {
        let dir = dir.canonicalize()?;
        if !dir.is_dir() {
            return Err(io::Error::new(io::ErrorKind::NotADirectory, "not a folder"));
        }
        Ok(Self { dir, hidden })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The folder's own name, shown as the first breadcrumb.
    pub fn name(&self) -> String {
        match self.dir.file_name() {
            Some(name) => name.to_string_lossy().into_owned(),
            None => "/".to_owned(),
        }
    }

    fn shows(&self, name: &str) -> bool {
        self.hidden || !name.starts_with('.')
    }

    /// Splits a request path into segments, refusing anything that is not a plain name.
    fn segments<'a>(&self, request: &'a str) -> Option<Vec<&'a str>> {
        let mut out = Vec::new();
        for seg in request.split('/') {
            if seg.is_empty() {
                continue;
            }
            if seg == "." || seg == ".." || seg.contains('\0') || !self.shows(seg) {
                return None;
            }
            if cfg!(windows) && seg.contains(['\\', ':']) {
                return None;
            }
            out.push(seg);
        }
        Some(out)
    }

    /// Turns a request path into a real one inside the served folder.
    /// Anything that would leave the folder, by name or through a link, is not found.
    pub fn resolve(&self, request: &str) -> Option<Resolved> {
        let segments = self.segments(request)?;
        let mut joined = self.dir.clone();
        joined.extend(&segments);
        let abs = joined.canonicalize().ok()?;
        if !self.contains(&abs) {
            return None;
        }
        let meta = fs::metadata(&abs).ok()?;
        Some(Resolved {
            abs,
            rel: segments.join("/"),
            meta,
        })
    }

    /// Finds the entry a request path names, for removing it. Unlike `resolve`, the
    /// last name is not followed when it is a link: the link is what gets removed, and
    /// not what it points at. Only a link that is shown is found. The folder holding
    /// the entry is followed, and has to be inside the served folder like everything else.
    pub fn entry(&self, request: &str) -> Result<Entry, NoEntry> {
        let segments = self.segments(request).ok_or(NoEntry::NotServed)?;
        let Some((name, above)) = segments.split_last() else {
            return Err(NoEntry::Root);
        };
        let mut joined = self.dir.clone();
        joined.extend(above);
        let parent = joined
            .canonicalize()
            .ok()
            .filter(|parent| self.contains(parent))
            .ok_or(NoEntry::Missing)?;
        let folder = parent
            .strip_prefix(&self.dir)
            .ok()
            .and_then(Path::to_str)
            .ok_or(NoEntry::Missing)?
            .replace(std::path::MAIN_SEPARATOR, "/");
        let abs = parent.join(name);
        let meta = fs::symlink_metadata(&abs).map_err(|_| NoEntry::Missing)?;
        self.seen(&parent, OsStr::new(name), meta.file_type())
            .map_err(|_| NoEntry::Missing)?;
        Ok(Entry { abs, folder, meta })
    }

    /// Removes an entry found by `entry`: a file, a link, or a folder with everything
    /// in it. A folder goes only when all it holds, at every depth, is shown, and then
    /// exactly what this walk met is removed: a name it did not meet keeps its folder.
    /// Nothing is followed: a link is removed as a link, also one met inside a folder.
    pub fn remove(&self, entry: &Entry) -> Result<(), Kept> {
        // A folder comes before what it holds, so going back from the end empties it first.
        let mut doomed = vec![(entry.abs.clone(), entry.meta.file_type())];
        let mut next = 0;
        while let Some((dir, kind)) = doomed.get(next) {
            next += 1;
            if !kind.is_dir() {
                continue;
            }
            let dir = dir.clone();
            for held in fs::read_dir(&dir)? {
                let held = held?;
                let kind = held.file_type()?;
                self.seen(&dir, &held.file_name(), kind).map_err(Kept::Holds)?;
                doomed.push((held.path(), kind));
            }
        }
        for (at, kind) in doomed.iter().rev() {
            remove_one(at, *kind)?;
        }
        Ok(())
    }

    /// True for a canonical path that is inside the served folder and not hidden.
    fn contains(&self, abs: &Path) -> bool {
        let Ok(inner) = abs.strip_prefix(&self.dir) else {
            return false;
        };
        inner.components().all(|part| match part {
            Component::Normal(name) => name.to_str().is_some_and(|name| self.shows(name)),
            _ => false,
        })
    }

    /// What one name in the folder `dir` is, or why it is not shown. `kind` is the
    /// name's own, not that of what a link points at. Listing and deleting both ask here.
    fn seen(&self, dir: &Path, name: &OsStr, kind: FileType) -> Result<Seen, Unshown> {
        let name = name.to_str().ok_or(Unshown::Unserved)?;
        if !self.shows(name) {
            return Err(Unshown::Hidden);
        }
        let name = name.to_owned();
        if !kind.is_symlink() {
            return Ok(Seen {
                name,
                dir: kind.is_dir(),
                link: false,
            });
        }
        let target = dir
            .join(&name)
            .canonicalize()
            .ok()
            .filter(|target| self.contains(target))
            .ok_or(Unshown::Unserved)?;
        Ok(Seen {
            name,
            dir: target.is_dir(),
            link: true,
        })
    }

    /// The names in one folder that may be shown. `abs` must come from `resolve`.
    pub fn scan(&self, abs: &Path) -> io::Result<Vec<Seen>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(abs)? {
            let Ok(entry) = entry else { continue };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            out.extend(self.seen(abs, &entry.file_name(), kind).ok());
        }
        Ok(out)
    }
}

/// Removes one thing and never what is in it or behind it: an empty folder, a file or a link.
fn remove_one(at: &Path, kind: FileType) -> io::Result<()> {
    if kind.is_dir() {
        return fs::remove_dir(at);
    }
    fs::remove_file(at).or_else(|error| {
        // On Windows a link to a folder is removed the way a folder is.
        if kind.is_symlink() && fs::remove_dir(at).is_ok() {
            Ok(())
        } else {
            Err(error)
        }
    })
}

/// Joins a folder path and a name, both relative to the served folder.
pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

/// The folder part of a relative path, empty for a top-level name.
pub fn parent(rel: &str) -> &str {
    rel.rsplit_once('/').map_or("", |(dir, _)| dir)
}

/// The last name in a relative path.
pub fn file_name(rel: &str) -> &str {
    rel.rsplit_once('/').map_or(rel, |(_, name)| name)
}

/// The lowercase extension of a file name, empty when there is none.
pub fn extension(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// Orders names the way people read them: case does not matter and `file2` sorts before `file10`.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut left, mut right) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let (x, y) = (digits(&mut left), digits(&mut right));
                let (x, y) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                let by_value = x.len().cmp(&y.len()).then_with(|| x.cmp(y));
                if by_value != Ordering::Equal {
                    return by_value;
                }
            }
            (Some(x), Some(y)) => {
                let by_letter = x.to_lowercase().cmp(y.to_lowercase());
                if by_letter != Ordering::Equal {
                    return by_letter;
                }
                left.next();
                right.next();
            }
        }
    }
}

fn digits(chars: &mut std::iter::Peekable<std::str::Chars>) -> String {
    let mut run = String::new();
    while let Some(c) = chars.next_if(char::is_ascii_digit) {
        run.push(c);
    }
    run
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order_reads_numbers_and_ignores_case() {
        let mut names = vec!["file10", "File2", "file1", "b", "A", "file2"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, ["A", "b", "file1", "File2", "file2", "file10"]);
    }

    #[test]
    fn extension_ignores_dotfiles_and_case() {
        assert_eq!(extension("photo.JPG"), "jpg");
        assert_eq!(extension(".gitignore"), "");
        assert_eq!(extension("Makefile"), "");
        assert_eq!(extension("a.tar.gz"), "gz");
    }
}
