//! What `cargo install okfs` builds from: the crate carries only the files `include` in Cargo.toml
//! names, so a file the source reads at compile time must be one of them.

use std::fs;
use std::path::{Path, PathBuf};

/// The patterns in Cargo.toml's `include`, without their leading slash.
fn included() -> Vec<String> {
    let manifest = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
    let list = manifest
        .lines()
        .find_map(|line| line.strip_prefix("include = ["))
        .expect("Cargo.toml has an include list")
        .trim_end_matches(']');
    list.split(',')
        .map(|pattern| pattern.trim().trim_matches('"').trim_start_matches('/').to_string())
        .filter(|pattern| !pattern.is_empty())
        .collect()
}

/// Whether the packaged crate holds `file`, a path from the crate's root.
fn packaged(patterns: &[String], file: &str) -> bool {
    patterns.iter().any(|pattern| {
        if let Some(folder) = pattern.strip_suffix("/**") {
            file.starts_with(&format!("{folder}/"))
        } else if let Some(stem) = pattern.strip_suffix(".*") {
            file.strip_prefix(stem).is_some_and(|rest| rest.starts_with('.'))
        } else {
            file == pattern
        }
    })
}

/// Every Rust file under `dir`.
fn sources(dir: &Path, found: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            sources(&path, found);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            found.push(path);
        }
    }
}

#[test]
fn every_file_the_source_includes_at_compile_time_is_in_the_package() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let patterns = included();
    let mut files = Vec::new();
    sources(&root.join("src"), &mut files);
    let mut checked = 0;
    for file in files {
        let text = fs::read_to_string(&file).unwrap();
        for call in ["include_str!(\"", "include_bytes!(\""] {
            for part in text.split(call).skip(1) {
                let relative = part.split('"').next().unwrap();
                let target = file.parent().unwrap().join(relative);
                let from_root = target
                    .components()
                    .fold(PathBuf::new(), |mut path, part| {
                        match part {
                            std::path::Component::ParentDir => {
                                path.pop();
                            }
                            other => path.push(other),
                        }
                        path
                    })
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                assert!(
                    packaged(&patterns, &from_root),
                    "{from_root} is read by {} but Cargo.toml's include leaves it out of the crate",
                    file.display()
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 0, "found no include_str! to check");
}
