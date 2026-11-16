<!-- The title is a conventional commit that states the outcome, for example `fix: a zip leaves out what the listing hides`. -->

What this changes, and why:

How you checked it:

- [ ] `cargo test`, `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` pass
- [ ] `cd ui && bun run check` passes, if the page changed
- [ ] `docs/` matches the new behavior
