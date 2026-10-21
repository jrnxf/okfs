#!/bin/sh
# Builds the site into web/dist: one page, index.html, holding okfs's page built from ui/, okfs's index built
# from src/ for WebAssembly, and the demo. See README.md.
set -eu
. "$(dirname "$0")/tools.sh"

build=$web/.build
mkdir -p "$build"

# okfs's page needs its own dependencies: preact and the bundled fonts.
(cd "$root/ui" && "$bun" install --frozen-lockfile)

# Panic messages carry source paths: keep the build machine's folders out of the module.
cargo_home=$(cd "${CARGO_HOME:-$HOME/.cargo}" 2>/dev/null && pwd || echo "${CARGO_HOME:-$HOME/.cargo}")
RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$root=/okfs --remap-path-prefix=$cargo_home=/cargo" \
    cargo build --manifest-path "$web/engine/Cargo.toml" --release --locked --target wasm32-wasip1
"$wasm_opt" -O3 --enable-bulk-memory --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int \
    "$web/engine/target/wasm32-wasip1/release/okfs_engine.wasm" -o "$build/okfs_engine.wasm"

rm -rf "$web/dist"
"$bun" run "$web/build.ts" "$build/okfs_engine.wasm" "$web/dist"
cp -R "$web/public/." "$web/dist/"
ls -l "$web/dist"
