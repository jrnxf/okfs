//! Which folders the index leaves out. What is inside a folder left out is kept out of
//! the search and out of memory. The folder itself is hidden from listings, as a dotfile
//! is, until the page asks for hidden entries, and it still opens at its address.
//!
//! Three things leave a folder out, checked in this order:
//! - a short built-in list of names (`NAMES`), and `Library` in a Mac's home folder;
//! - the `.gitignore` files inside the served folder, each for its own folder and below;
//! - an `.okfsignore` file in the served folder, in the same format, which wins over them.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};

/// The extra ignore file in the served folder.
pub const OWN: &str = ".okfsignore";
const GIT: &str = ".gitignore";

/// Folders with no `.gitignore` to leave them out, left out wherever they are.
const NAMES: &[&str] = &["node_modules", ".git", ".cache", ".npm", ".Trash"];
/// Left out of the served folder itself when it is a Mac's home folder.
const HOME: &[&str] = &["Library"];

pub struct Skip {
    /// Names left out only at the top of the served folder.
    top: &'static [&'static str],
}

/// The ignore files that hold inside one folder, and those of the folders above it.
#[derive(Clone, Default)]
pub struct Rules(Option<Arc<Level>>);

struct Level {
    up: Rules,
    ignore: Gitignore,
}

impl Skip {
    pub fn new(served: &Path) -> Self {
        let home = dirs::home_dir().and_then(|home| home.canonicalize().ok());
        Self::with_home(served, home.as_deref(), cfg!(target_os = "macos"))
    }

    fn with_home(served: &Path, home: Option<&Path>, mac: bool) -> Self {
        let top = if mac && home == Some(served) { HOME } else { &[] };
        Self { top }
    }

    /// The rules that hold inside the folder `abs`. `served` is true for the served folder itself.
    pub fn enter(&self, abs: &Path, served: bool, up: &Rules) -> Rules {
        let mut builder = GitignoreBuilder::new(abs);
        let mut any = false;
        let files = if served { &[GIT, OWN][..] } else { &[GIT][..] };
        for name in files {
            let Ok(bytes) = fs::read(abs.join(name)) else { continue };
            let text = String::from_utf8_lossy(&bytes);
            for line in text.trim_start_matches('\u{feff}').lines() {
                // A line that is not a pattern is not a rule, and the others still are.
                any |= builder.add_line(None, line).is_ok();
            }
        }
        match builder.build() {
            Ok(ignore) if any && !ignore.is_empty() => Rules(Some(Arc::new(Level { up: up.clone(), ignore }))),
            _ => up.clone(),
        }
    }

    /// Whether the folder `name`, inside the folder `abs`, is left out. `rules` are those of `abs`.
    pub fn skips(&self, rules: &Rules, abs: &Path, served: bool, name: &str) -> bool {
        if NAMES.contains(&name) || (served && self.top.contains(&name)) {
            return true;
        }
        if rules.0.is_none() {
            return false;
        }
        let path = abs.join(name);
        let mut level = &rules.0;
        // The nearest file with a say decides, and a later line in it beats an earlier one.
        while let Some(held) = level {
            match held.ignore.matched(&path, true) {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => level = &held.up.0,
            }
        }
        false
    }

    /// The rules inside the folder `dir`, a path under the served folder `served`. `None` when
    /// the folder is left out, or one above it is: nothing under it is kept.
    pub fn rules_for(&self, served: &Path, dir: &str) -> Option<Rules> {
        self.climb(served, dir, true)
    }

    /// The rules inside the folder `dir`, whether or not it is left out: what a listing
    /// of it asks about the folders in it.
    pub fn rules_in(&self, served: &Path, dir: &str) -> Rules {
        self.climb(served, dir, false).unwrap_or_default()
    }

    /// The rules inside `dir`, read down from the served folder. `stop`: `None` when a
    /// folder on the way is left out.
    fn climb(&self, served: &Path, dir: &str, stop: bool) -> Option<Rules> {
        let mut abs = served.to_path_buf();
        let mut rules = self.enter(&abs, true, &Rules::default());
        let mut top = true;
        for name in dir.split('/').filter(|name| !name.is_empty()) {
            if stop && self.skips(&rules, &abs, top, name) {
                return None;
            }
            abs.push(name);
            rules = self.enter(&abs, false, &rules);
            top = false;
        }
        Some(rules)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn left_out(served: &Path, skip: &Skip, dir: &str) -> bool {
        skip.rules_for(served, dir).is_none()
    }

    #[test]
    fn the_built_in_names_are_left_out_wherever_they_are() {
        let tmp = tempfile::tempdir().unwrap();
        let served = tmp.path().canonicalize().unwrap();
        let skip = Skip::new(&served);
        for dir in [
            "node_modules",
            "app/node_modules",
            ".git",
            "a/b/.cache",
            ".Trash",
            "app/node_modules/deep",
        ] {
            assert!(left_out(&served, &skip, dir), "{dir}");
        }
        for dir in ["", "app", "modules", "node_modules_not", "a/Library"] {
            assert!(!left_out(&served, &skip, dir), "{dir}");
        }
    }

    #[test]
    fn library_is_left_out_of_a_mac_home_folder_and_nowhere_else() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().canonicalize().unwrap();
        let mac = Skip::with_home(&home, Some(&home), true);
        assert!(left_out(&home, &mac, "Library"));
        assert!(left_out(&home, &mac, "Library/Caches"));
        // Only at the top: a Library further down is the user's own.
        assert!(!left_out(&home, &mac, "work/Library"));
        // Not on another system, and not in a folder that is not home.
        assert!(!left_out(&home, &Skip::with_home(&home, Some(&home), false), "Library"));
        assert!(!left_out(
            &home,
            &Skip::with_home(&home, Some(&home.join("other")), true),
            "Library"
        ));
        assert!(!left_out(&home, &Skip::with_home(&home, None, true), "Library"));
    }

    #[test]
    fn a_gitignore_leaves_out_what_it_names_for_its_own_folder_and_below() {
        let tmp = tempfile::tempdir().unwrap();
        let served = tmp.path().canonicalize().unwrap();
        fs::create_dir_all(served.join("app/sub")).unwrap();
        fs::write(served.join(GIT), "/dist\nbuild/\n!keep/\n").unwrap();
        fs::write(served.join("app/.gitignore"), "target\n").unwrap();
        let skip = Skip::new(&served);

        assert!(left_out(&served, &skip, "dist"));
        assert!(left_out(&served, &skip, "app/build"));
        assert!(left_out(&served, &skip, "app/target"));
        assert!(left_out(&served, &skip, "app/sub/target"));
        // Anchored to the folder that holds the file; and `target` is app's rule only.
        assert!(!left_out(&served, &skip, "app/dist"));
        assert!(!left_out(&served, &skip, "target"));
        assert!(!left_out(&served, &skip, "keep"));
    }

    #[test]
    fn a_nearer_gitignore_can_let_back_in_what_a_farther_one_left_out() {
        let tmp = tempfile::tempdir().unwrap();
        let served = tmp.path().canonicalize().unwrap();
        fs::create_dir_all(served.join("app")).unwrap();
        fs::write(served.join(GIT), "out\n").unwrap();
        fs::write(served.join("app/.gitignore"), "!out\n").unwrap();
        let skip = Skip::new(&served);
        assert!(left_out(&served, &skip, "out"));
        assert!(!left_out(&served, &skip, "app/out"));
    }

    #[test]
    fn the_okfs_ignore_file_adds_to_the_gitignore_and_can_undo_it() {
        let tmp = tempfile::tempdir().unwrap();
        let served = tmp.path().canonicalize().unwrap();
        fs::write(served.join(GIT), "dist\n").unwrap();
        fs::write(served.join(OWN), "# comment\n\nphotos/raw\n!dist\n").unwrap();
        let skip = Skip::new(&served);
        assert!(left_out(&served, &skip, "photos/raw"));
        assert!(!left_out(&served, &skip, "photos"));
        assert!(!left_out(&served, &skip, "dist"));
        // Only the served folder's own file counts.
        fs::create_dir_all(served.join("sub")).unwrap();
        fs::write(served.join("sub").join(OWN), "inner\n").unwrap();
        assert!(!left_out(&served, &skip, "sub/inner"));
    }

    #[test]
    fn the_rules_inside_a_folder_that_is_left_out_still_hold() {
        let tmp = tempfile::tempdir().unwrap();
        let served = tmp.path().canonicalize().unwrap();
        fs::create_dir_all(served.join("node_modules/pkg")).unwrap();
        fs::write(served.join(GIT), "dist\n").unwrap();
        let skip = Skip::new(&served);
        let rules = skip.rules_in(&served, "node_modules/pkg");
        let abs = served.join("node_modules/pkg");
        assert!(skip.skips(&rules, &abs, false, "dist"));
        assert!(skip.skips(&rules, &abs, false, "node_modules"));
        assert!(!skip.skips(&rules, &abs, false, "lib"));
    }

    #[test]
    fn a_built_in_name_stays_out_whatever_a_file_says() {
        let tmp = tempfile::tempdir().unwrap();
        let served = tmp.path().canonicalize().unwrap();
        fs::write(served.join(OWN), "!node_modules\n").unwrap();
        assert!(left_out(&served, &Skip::new(&served), "node_modules"));
    }
}
