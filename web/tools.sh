# Sourced by build.sh: puts Rust with the wasm32-wasip1 target, wasm-opt and bun in reach, at the exact
# versions below, downloading them into $tools when they are missing. That is what happens in Cloudflare's
# Workers Builds, which has Node and nothing else this build needs.

RUST_VERSION=1.99.1
RUSTUP_VERSION=1.29.1
RUSTUP_SHA256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
BINARYEN_VERSION=133
BINARYEN_SHA256=2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489

web=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$web")
tools=${OKFS_WEB_TOOLS:-$web/.build/tools}
mkdir -p "$tools"

sha256() {
    if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d ' ' -f 1
}

# Downloads $1 to $3 unless it is there already, and checks it is $2.
fetch() {
    if [ -f "$3" ] && [ "$(sha256 "$3")" = "$2" ]; then return; fi
    echo "Downloading $1"
    curl -sSfL --retry 3 -o "$3.part" "$1"
    actual=$(sha256 "$3.part")
    if [ "$actual" != "$2" ]; then
        echo "$1: expected sha256 $2, got $actual" >&2
        exit 1
    fi
    mv "$3.part" "$3"
}

linux_x86() { [ "$(uname -s)-$(uname -m)" = Linux-x86_64 ]; }

# Rust: from PATH when it can build for wasm32-wasip1, otherwise rustup, pinned, into $tools.
if ! rustc --print target-list 2>/dev/null | grep -qx wasm32-wasip1 || ! rustup target list --installed 2>/dev/null | grep -qx wasm32-wasip1; then
    if ! linux_x86; then
        echo "Put Rust with the wasm32-wasip1 target on PATH (rustup target add wasm32-wasip1)" >&2
        exit 1
    fi
    export RUSTUP_HOME=$tools/rustup CARGO_HOME=$tools/cargo
    if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
        fetch "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/x86_64-unknown-linux-gnu/rustup-init" \
            "$RUSTUP_SHA256" "$tools/rustup-init"
        chmod +x "$tools/rustup-init"
        "$tools/rustup-init" -y --no-modify-path --profile minimal --default-toolchain "$RUST_VERSION" --target wasm32-wasip1
    fi
    PATH=$CARGO_HOME/bin:$PATH
fi
rustc --version

# wasm-opt: binaryen's release, pinned, unless that version is on PATH.
if wasm-opt --version 2>/dev/null | grep -q "version $BINARYEN_VERSION\b"; then
    wasm_opt=wasm-opt
elif linux_x86; then
    binaryen=binaryen-version_$BINARYEN_VERSION
    fetch "https://github.com/WebAssembly/binaryen/releases/download/version_$BINARYEN_VERSION/$binaryen-x86_64-linux.tar.gz" \
        "$BINARYEN_SHA256" "$tools/$binaryen.tar.gz"
    [ -d "$tools/$binaryen" ] || tar -xzf "$tools/$binaryen.tar.gz" -C "$tools"
    wasm_opt=$tools/$binaryen/bin/wasm-opt
else
    wasm_opt=$(command -v wasm-opt || true)
    [ -n "$wasm_opt" ] || { echo "Put binaryen's wasm-opt on PATH" >&2; exit 1; }
fi

# bun builds okfs's page, as ui/build.ts does: the version pinned in web/package.json, or bun from PATH.
if [ -x "$web/node_modules/.bin/bun" ]; then bun=$web/node_modules/.bin/bun; else bun=$(command -v bun); fi
"$bun" --version >/dev/null
