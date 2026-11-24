# Contributing

Bug reports, fixes and themes are welcome. For a larger change, open an issue first, so we can agree on the shape before you write it.

## Build and test

You need a Rust toolchain and [bun](https://bun.sh). The nix dev shell has both. `build.rs` builds the page with bun and puts it in the binary.

```sh
nix develop
cargo test                                  # server behavior and the theme checker
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cd ui && bun run check                      # type check the page and test it
```

CI runs the same four checks. [docs/development.md](docs/development.md) has more, such as how to work on the page without a rebuild of the binary.

To try a change, run a debug build on a scratch folder, not on files you care about:

```sh
cargo run -- --no-open /tmp/scratch
```

## Commits and pull requests

- One change per pull request.
- The title is a [conventional commit](https://www.conventionalcommits.org) that states the outcome, not the activity. Examples from the history: `fix: a zip leaves out what the listing hides`, `feat(ui): the file list and the palette tell a screen reader where the cursor is`.
- A change in behavior comes with a test, and with the matching change in `docs/`.

## Add a theme

A theme is one CSS file in [`themes/`](themes) that sets tokens and nothing else. [docs/themes.md](docs/themes.md) has the contract.

1. Copy a file from `themes/` and change the values.
2. Check it: `cargo run -- theme check themes/<name>.css`.
3. Look at it on real files: `cargo run -- --no-open --theme themes/<name>.css /tmp/scratch`.
4. Add the name to `BUILT_IN` in `src/theme.rs`, and the palette's license to `THIRD_PARTY.md`.

## Report a bug

Use the bug form. A good report holds:

- the output of `okfs --version`
- the operating system, and the browser when the fault is in the page
- how you installed okfs
- the full command line, with keys and private names removed
- what you did, what you expected and what happened

Do not report a security fault in a public issue. See [SECURITY.md](SECURITY.md).
