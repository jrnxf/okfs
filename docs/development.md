# Develop

```sh
nix develop
cargo test                                  # server behavior and the theme checker
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cd ui && bun run check                      # type check the page and test it
```

The server is Rust (axum, tokio). The page is TypeScript, Preact and Tailwind CSS in `ui/`, built by `build.rs` into the binary. To work on the page without rebuilding the binary each time, run a debug build with `OKFS_UI_DIR=ui/dist` and rebuild the page with `cd ui && bun run build`.

The pictures in `docs/screenshots/` are shot again with one command, from a release build and a folder to serve. It needs `chrome-devtools-axi` and nix. The script says which files the folder must hold:

```sh
cargo build --release
scripts/shoot-readme.sh path/to/tidewater
```
