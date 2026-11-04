# Install

The short version is in the [README](../README.md#install). This page has every way to get okfs.

With Homebrew, on macOS or Linux:

```sh
brew install jrnxf/tap/okfs
```

With nix, run it without installing anything, or put it on your `PATH`:

```sh
nix run github:jrnxf/okfs -- ~/photos   # run it once
nix profile install github:jrnxf/okfs   # or install it
```

`nix profile upgrade okfs` brings an installed copy up to date.

Without nix, download a release. okfs has none yet: the first is `v0.1.0-pre.1`. Until v0.1.0, releases are pre-releases, tagged `v0.1.0-pre.N`, and `gh release download` with no tag takes only a full release, so ask for the newest one by name.

Each release has an archive for Linux (x86-64 and arm64) and macOS (Apple silicon and Intel), named `okfs-<version>-<target>.tar.gz`, and a zip for Windows (x86-64), `okfs-<version>-x86_64-pc-windows-msvc.zip`, each with a `.sha256` beside it. The targets are `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`, `aarch64-apple-darwin`, `x86_64-apple-darwin` and `x86_64-pc-windows-msvc`. The Linux binaries are static, so they run on any distribution whatever its C library. An archive holds the `okfs` binary, its bash, zsh and fish completions under `completions/` and the manual page `okfs.1`.

```sh
tag=$(gh release list --repo jrnxf/okfs --limit 1 --json tagName --jq '.[0].tagName')
gh release download "$tag" --repo jrnxf/okfs --pattern '*-aarch64-apple-darwin.tar.gz*'
shasum -a 256 -c okfs-*-aarch64-apple-darwin.tar.gz.sha256
tar -xzf okfs-*-aarch64-apple-darwin.tar.gz
./okfs-*-aarch64-apple-darwin/okfs --version
```

With Docker, mount the folder to serve at `/srv`:

```sh
docker run -p 8080:8080 -v "$PWD:/srv:ro" ghcr.io/jrnxf/okfs
```

The image is the release's static binary and nothing else, for amd64 and arm64. It listens on every address, so it asks for the key. Inside a container okfs prints the container's own addresses, such as `172.17.0.2`, which a browser on the host cannot open: keep the `?key=...` part of the link and put the host's address in front of it, such as `http://192.168.1.20:8080/?key=...`. A plain IP address needs no `--allow-host`. The image runs as an unprivileged user, so to use a write flag (`--allow-upload` and the others), add `--user "$(id -u):$(id -g)"` and drop `:ro`. Anything after the image name is an okfs argument, and the `OKFS_*` variables below set its options. The image sets `OKFS_BIND`, `OKFS_PORT` (8080), `OKFS_NO_OPEN` and `OKFS_PATH` (`/srv`) itself: set one of them with `-e` to change it, and publish the new port with `-p`. The tags are the version, such as `0.1.0`, and `latest`, which follows full releases only. The thumbnail cache is the volume `/cache`.

With a Rust toolchain, `cargo install okfs` builds it from crates.io (from v0.1.0; until then use the git command below). The crate carries the built page, so it needs no bun.

Or build it from the repository. You need a Rust toolchain and [bun](https://bun.sh): bun builds the page while cargo builds the binary.

```sh
cargo install --git https://github.com/jrnxf/okfs
```

To build from a checkout without installing, the nix dev shell has both tools:

```sh
nix develop
cargo build --release    # the binary is target/release/okfs
```

The engine that draws the first page of a PDF is about 6 MB of the binary. `cargo build --release --no-default-features` leaves it out: PDFs then open in the browser's viewer alone. Every other preview is the same.

Platform notes:

- On Windows, download `okfs-<version>-x86_64-pc-windows-msvc.zip` from the [releases](https://github.com/jrnxf/okfs/releases); it holds `okfs.exe`. The drawing of a PDF's first page runs there without the memory and processor caps it has on Linux and a Mac, so only its time limit ends a PDF that will not draw.
- On a Mac, a binary downloaded with a browser is quarantined, and Gatekeeper refuses to open it because okfs is not signed. Download it with `gh` or `curl` as above, which leaves no quarantine mark, or clear the mark with `xattr -d com.apple.quarantine okfs`.
- On Windows, a `okfs.exe` downloaded with a browser is blocked by SmartScreen because okfs is not signed. Choose "More info", then "Run anyway", or run `Unblock-File okfs.exe` in PowerShell.
- Watching a folder for changes uses inotify on Linux and FSEvents on a Mac. On a network share, where a watcher does not see what other machines change, use `--rescan` (see [A big folder](usage.md#a-big-folder)).
- Shell completions: `okfs completions zsh` (or `bash`, `fish`, `powershell`) prints them. The release archive has them as files, and `okfs.1` is the manual page.
