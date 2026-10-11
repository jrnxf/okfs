//! Builds the page with bun and writes a table of its files for the binary to embed.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let ui = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("set by cargo")).join("ui");
    for watched in [
        "src",
        "index.html",
        "build.ts",
        "package.json",
        "bun.lock",
        "tsconfig.json",
    ] {
        println!("cargo:rerun-if-changed={}", ui.join(watched).display());
    }
    println!("cargo:rerun-if-env-changed=OKFS_SKIP_UI_BUILD");

    // Set OKFS_SKIP_UI_BUILD to embed an existing ui/dist, for machines without bun.
    if env::var_os("OKFS_SKIP_UI_BUILD").is_none() {
        bun(&ui, &["install", "--frozen-lockfile"]);
        bun(&ui, &["run", "build"]);
    }

    let dist = ui.join("dist");
    let mut files = Vec::new();
    collect(&dist, &dist, &mut files);
    files.sort();
    assert!(
        files.iter().any(|(name, _)| name == "index.html"),
        "ui/dist has no index.html: build the page first"
    );

    let mut table = String::from("pub static FILES: &[(&str, &str, &[u8])] = &[\n");
    for (name, path) in &files {
        let bytes = fs::read(path).expect("a built file");
        // FNV-1a over the contents: the file's ETag.
        let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
        });
        writeln!(
            table,
            "    ({name:?}, \"\\\"{hash:016x}\\\"\", include_bytes!({path:?})),"
        )
        .expect("a string");
    }
    table.push_str("];\n");
    let out = PathBuf::from(env::var("OUT_DIR").expect("set by cargo")).join("assets.rs");
    fs::write(out, table).expect("the asset table");
}

fn bun(ui: &Path, args: &[&str]) {
    let status = Command::new("bun").args(args).current_dir(ui).status();
    match status {
        Ok(status) if status.success() => {}
        Ok(status) => panic!("`bun {}` failed in ui/: {status}", args.join(" ")),
        Err(error) => {
            panic!("cannot run bun to build the page ({error}). Install bun, or use the dev shell: nix develop")
        }
    }
}

fn collect(top: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(top, &path, files);
        } else if let Ok(name) = path.strip_prefix(top) {
            files.push((name.to_string_lossy().replace('\\', "/"), path));
        }
    }
}
