# Develop

```sh
nix develop
cargo test                                  # server behavior and the theme checker
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cd ui && bun run check                      # type check the page and test it
```

The server is Rust (axum, tokio). The page is TypeScript, Preact and Tailwind CSS in `ui/`, built by `build.rs` into the binary. To work on the page without rebuilding the binary each time, run a debug build with `OKFS_UI_DIR=ui/dist` and rebuild the page with `cd ui && bun run build`.

okfs builds with the latest stable Rust. `Cargo.toml` sets no `rust-version`, and CI builds with the `stable` toolchain only, so an older compiler may stop working in any release.

okfs has no stable library API. The crate has a library target so that the binary and the tests share one body of code. Its modules may change or go in any release. What okfs keeps stable is in [What you can rely on](usage.md#what-you-can-rely-on).

The pictures in `docs/screenshots/` are shot again with one command, from a release build and a folder to serve. It needs `chrome-devtools-axi` and nix. The script says which files the folder must hold:

```sh
cargo build --release
scripts/shoot-readme.sh path/to/tidewater
```
