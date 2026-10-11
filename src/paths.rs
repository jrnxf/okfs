//! The served folder. Every request path becomes a place on disk here and nowhere else.

use std::cmp::Ordering;
use std::fs::{self, Metadata};
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

    /// The names in one folder that may be shown. `abs` must come from `resolve`.
    pub fn scan(&self, abs: &Path) -> io::Result<Vec<Seen>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(abs)? {
            let Ok(entry) = entry else { continue };
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if !self.shows(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                let Ok(target) = entry.path().canonicalize() else {
                    continue;
                };
                if !self.contains(&target) {
                    continue;
                }
                out.push(Seen {
                    name,
                    dir: target.is_dir(),
                    link: true,
                });
            } else {
                out.push(Seen {
                    name,
                    dir: kind.is_dir(),
                    link: false,
                });
            }
        }
        Ok(out)
    }
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
