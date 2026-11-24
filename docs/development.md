# Develop

```sh
nix develop
cargo test                                  # server behavior and the theme checker
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cd ui && bun run check                      # type check the page and test it
```

CI runs the tests with `cargo nextest run`, which the dev shell also has. It runs each test in its own process. It does not run doctests, so CI also runs `cargo test --doc`.

The server is Rust (axum, tokio). The page is TypeScript, Preact and Tailwind CSS in `ui/`, built by `build.rs` into the binary. To work on the page without rebuilding the binary each time, run a debug build with `OKFS_UI_DIR=ui/dist` and rebuild the page with `cd ui && bun run build`.

okfs builds with Rust 1.92 or later. `Cargo.toml` says so in `rust-version`, and CI builds with that version and with `stable`. The oldest Rust may go up in any release, when a dependency asks for a later one.

okfs has no stable library API. The crate has a library target so that the binary and the tests share one body of code. Its modules may change or go in any release. What okfs keeps stable is in [What you can rely on](usage.md#what-you-can-rely-on).

The pictures in `docs/screenshots/` are shot again with one command, from a release build and a folder to serve. It needs `chrome-devtools-axi` and nix. The script says which files the folder must hold:

```sh
cargo build --release
scripts/shoot-readme.sh path/to/tidewater
```
