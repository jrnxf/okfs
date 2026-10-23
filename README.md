<h1 align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/logo/okfs-dark.svg"><img src="docs/logo/okfs-light.svg" alt="okfs" width="300"></picture>
</h1>

<p align="center">An open-source web file browser in one binary: run it in a folder and browse every file in your browser, with previews and instant search.</p>

<p align="center"><a href="https://okfs.jrnxf.co/demo/">Try it in your browser</a> · <a href="https://okfs.jrnxf.co">okfs.jrnxf.co</a></p>

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.webp"><img src="docs/screenshots/hero-light.webp" alt="okfs serving a folder: a dense file list on the left, the photo under the cursor on the right" width="100%"></picture>
</p>

okfs ("ok file server") is an open-source web file browser in one binary. The page is compiled into it, so there is nothing to install beside it, and the page loads nothing from another site while it runs. Run it in a folder and the whole tree is a keyboard-driven browser: a dense list, a preview of whatever is under the cursor, and a search of every name in the tree.

## Install

With nix, run it without installing anything, or put it on your `PATH`:

```sh
nix run github:jrnxf/okfs -- ~/photos   # run it once
nix profile install github:jrnxf/okfs   # or install it
```

`nix profile upgrade okfs` brings an installed copy up to date.

Without nix, download a release. okfs has none yet: the first is `v0.1.0-pre.1`. Until v0.1.0, releases are pre-releases, tagged `v0.1.0-pre.N`, and `gh release download` with no tag takes only a full release, so ask for the newest one by name.

Each release has an archive for Linux (x86-64 and arm64) and macOS (Apple silicon and Intel), named `okfs-<version>-<target>.tar.gz`, with a `.sha256` beside it. The targets are `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`, `aarch64-apple-darwin` and `x86_64-apple-darwin`. The Linux binaries are static, so they run on any distribution whatever its C library. An archive holds the `okfs` binary, its bash, zsh and fish completions under `completions/` and the manual page `okfs.1`.

```sh
tag=$(gh release list --repo jrnxf/okfs --limit 1 --json tagName --jq '.[0].tagName')
gh release download "$tag" --repo jrnxf/okfs --pattern '*-aarch64-apple-darwin.tar.gz*'
shasum -a 256 -c okfs-*-aarch64-apple-darwin.tar.gz.sha256
tar -xzf okfs-*-aarch64-apple-darwin.tar.gz
./okfs-*-aarch64-apple-darwin/okfs --version
```

Or build it. You need a Rust toolchain and [bun](https://bun.sh): bun builds the page while cargo builds the binary.

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

- There is no Windows build yet. The code has not been run there.
- On a Mac, a binary downloaded with a browser is quarantined, and Gatekeeper refuses to open it because okfs is not signed. Download it with `gh` or `curl` as above, which leaves no quarantine mark, or clear the mark with `xattr -d com.apple.quarantine okfs`.
- Watching a folder for changes uses inotify on Linux and FSEvents on a Mac. On a network share, where a watcher does not see what other machines change, use `--rescan` (see [A big folder](#a-big-folder)).
- Shell completions: `okfs completions zsh` (or `bash`, `fish`) prints them. The release archive has them as files, and `okfs.1` is the manual page.

## Quick start

```sh
okfs ~/photos               # serve a folder and open it in the browser
okfs --bind 0.0.0.0 --qr    # let a phone on the same network in, with a QR code to scan
okfs --help                 # every flag, with examples
```

okfs listens on `127.0.0.1:8080` and opens the page. Press `?` in it for the keys, and `Ctrl K` or `Cmd K` to find any file in the tree.

## What it does

- A dense list on the left, and beside it what is under the cursor: hold `j` and every file shows as the cursor passes it.
- Previews for images, video, audio, PDF, Markdown, source code, CSV, JSON, zip files and HTML pages.
- A palette that finds any file in the whole tree at once, from an index kept in memory.
- Columns that show what is inside the folder under the cursor, and the page follows the folder as files are added, removed or rewritten, with no reload.
- Five built-in themes, light and dark, each one CSS file.
- Read only unless you say otherwise. There is no upload, no editing and no accounts. Deleting is behind `--allow-delete`.
- Loopback by default. Beyond it, only a link with a key that okfs prints gets in (see [Letting other machines in](#letting-other-machines-in)).

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/palette-dark.webp"><img src="docs/screenshots/palette-light.webp" alt="The palette finding files across the tree" width="49%"></picture>
</p>

## Why okfs

okfs is for looking at a folder. Its previews, columns and search are made for flipping through many files quickly with the keyboard, and its defaults are safe: loopback only, read only, dotfiles hidden, a key beyond loopback.

It does less than the tools that manage files, on purpose. It has no upload and no accounts, and it has no TLS of its own (see [Behind a proxy or a tunnel](#behind-a-proxy-or-a-tunnel)). For uploads, use dufs or copyparty. For a file manager with users, use File Browser Quantum. File Browser itself was archived in September 2026.

| | okfs | `python -m http.server` | miniserve | dufs | copyparty |
| --- | --- | --- | --- | --- | --- |
| Default address | loopback only | all interfaces | all interfaces | all interfaces | all interfaces |
| Beyond loopback | secret link | none | basic auth, optional | basic or digest auth, optional | accounts |
| Writes | none; delete behind a flag | none | upload, optional | upload, edit, move and delete, each optional | upload, per account |
| Previews | images, video, audio, PDF, Markdown, code, CSV, JSON, zip, HTML | none | none | none | thumbnails, audio spectrograms |
| Search of the whole tree | instant, in memory | none | none | yes | yes, indexed |
| Live updates | yes | none | none | none | not checked |
| TLS | through a proxy | since Python 3.14 | yes | yes | yes |

This is how each tool read on 2026-10-21, from its documentation. Check the project you are comparing before you rely on a cell.

## The page

These are the details behind the list above.

- A dense list on the left, and beside it what is under the cursor: a file is shown as soon as the cursor is on it, in the same pane. Hold `j` to flip through a folder: every file shows as the cursor passes it.
- A page of 256 KB or more, a PDF's viewer and a player wait until the key is let go, unless they were loaded ahead: the next few pages and PDFs past the cursor are, in hidden frames, so a page may run its scripts before you look at it. A PDF shows a picture of its first page meanwhile, and a video one frame of itself when it was reached in time, so a held key flips through those too. A phone has no space bar: there a tap opens the file over the list, with previous and next in a bar at its foot and download and delete behind a `...` button.
- Markdown, an SVG drawing and JSON open as their source, as it is written, colored and never run. `r` flips them to what is made from them, and the choice holds for the files of that kind that follow, until you flip it back or leave the page. An HTML page opens as the page, and a CSV table opens as a table; `r` flips either to its source. Pictures, PDFs, video and audio have no source and are always shown as themselves. There is a button for it beside the file's name. The source of Markdown, an HTML page, a text and a log wraps at the edge of the pane, with wrapped lines hanging from the line number; source code never wraps. `w` turns wrapping off and on, and the choice holds for the files of that kind that follow.
- A folder under the cursor shows what is in it: its list in a column as wide as the main list, then the inside of its first entry in the next, or of the entry you were on when you last left it, as far down as the window has room. A folder there gets a column of its own, and a file is shown as it would be under the cursor, so a folder that holds one file shows that file. The pointer leads them too: the entry it is on in a column is the one the columns after it go into, a folder or a file, and a key that moves the cursor takes over until the pointer moves again. Going into the folder puts the cursor on the entry its column leads on to, whatever the sort. The window is cut into four equal parts, three under 1,200 px and two under 900 px, and the main list is one of them. Every column comes in one answer, so a held key shows them as it passes. They hold names, sizes and times, and no file is read for them. The main list has the same bar over it as each column, so a folder's rows sit at the same height in every slot, and the columns slide sideways into their new slots as you go in or out, with the cursor's highlight travelling from the row it was on to the row it lands on, so the eye can follow it.
- Hidden files stay out of the way: dotfiles, and the folders left out of the search, such as `node_modules` and what a `.gitignore` names (see [A big folder](#a-big-folder)). `.`, or the eye button at the top, shows them and hides them again, and the browser remembers the choice. The counts beside each folder are of what is shown, so a folder says how many entries you will find in it, and the bar at the foot says how many are hidden. The search hides the same ones.
- A palette (`Ctrl K` or `Cmd K`) that finds any file in the whole tree, lists the most recently changed files before you type, and runs commands when you start with `>`. `Ctrl Enter` or `Cmd Enter`, or the row under its matches, lists every match in place of the folder: ranked, with the folder each is in, sortable by name, folder, size and time, and loaded a page at a time as you scroll. The query is in the address (`?find=`), so back, a reload and a shared link all work, and a folder or a file opened from the matches leads back to them.
- The page follows the folder. A file that is added, removed, renamed or rewritten shows at once, and so does an open preview, with no reload.

## Use

```sh
okfs                        # serve this folder at http://127.0.0.1:8080/
okfs ~/photos --port 9000   # another folder, another port
okfs --bind 0.0.0.0         # let other machines on the network in, with a key in the link
okfs --bind 0.0.0.0 --qr    # and print a QR code a phone can scan to open it
```

A folder's `README.md` is shown under its listing.

The page follows changes through a watcher on the folder. Where okfs cannot set one up, it says so when it starts and reads the whole folder again on a timer: every 30 seconds, or 20 times as long as one read of it takes when that is longer, so a tree that takes minutes to read is not read over and over. The page catches up at that pace. Something reached through a symbolic link is not followed as it changes: it catches up when the page is reloaded or shown again.

With `--rescan`, okfs sets up no watcher and reads the whole folder again on a timer you choose: `--rescan 6h`. That suits a tree too big to watch, and a network share, where a watcher does not see what other machines change. A folder's listing is always read from the disk when it is opened, so only what comes from the index waits for the next read: the search, its list of recent files, and how many entries a folder holds.

<details>
<summary>All flags</summary>

| Flag | What it does |
| --- | --- |
| `[PATH]` | The folder to serve. Default: the current folder. |
| `-b`, `--bind <ADDR>` | Address to listen on: an IP address or `localhost`. Default `127.0.0.1`. Beyond loopback, a [key](#letting-other-machines-in) is asked for. |
| `-p`, `--port <PORT>` | Port to listen on, `0` for any free one. Without it, `8080`, or the next free port after it. |
| `--qr` | Print a QR code for the first address another device can use, in a terminal. It carries the key. Off by default. |
| `--no-open` | Do not open the browser. It opens by default in a terminal, never as a service and never over SSH. |
| `--index <FILE>` | Open a folder that holds a file of this name as that page: `--index index.html`. Off by default. See below. |
| `--theme <NAME\|FILE>` | Theme a new visitor starts in: a built-in name or a theme file. |
| `--header <FILE.md>` | A Markdown note shown above every folder. |
| `--title <TEXT>` | Name shown in the corner and the browser tab. Default `okfs`. |
| `--accent <COLOR>` | Accent color in every theme, as hex: `"#2d6a4f"`. |
| `-H`, `--hidden` | Serve dotfiles, and show hidden files to a browser that has made no choice with `.`. Without it, dotfiles are never sent, and `.` shows only the folders left out of the search. |
| `--key` | Ask for the key on a loopback address too, as behind a tunnel that anyone can reach. Any write flag does the same. |
| `--no-key` | Let in anyone who reaches an address beyond loopback, with no key. For a proxy that signs people in itself. See [Letting other machines in](#letting-other-machines-in). |
| `--allow-host <NAME>` | Also answer to this host name. Repeatable. See below. |
| `--allow-upload` | Let anyone who can reach the address add files and folders. A file never replaces one that is there. Off by default. See [Uploading and editing](#uploading-and-editing). |
| `--allow-edit` | Let anyone who can reach the address change the files that are there. Off by default. See [Uploading and editing](#uploading-and-editing). |
| `--allow-delete` | Let anyone who can reach the address delete files and folders. Off by default. See [Deleting](#deleting). |
| `--max-upload <SIZE>` | The largest file an upload or a save may be: `500M`, `4G`. No limit by default. |
| `--rescan <EVERY>` | Read the whole tree again this often instead of watching it for changes: `90s`, `30m`, `6h`, `1d`, `1h30m`. Off by default. See [A big folder](#a-big-folder). |

</details>
### Keys

| Key | Does |
| --- | --- |
| `j` `k`, arrows | Move down and up |
| `Enter` | Open the folder, or give the file the full width |
| `r` | Rendered or source, for a file that has both: HTML, Markdown, SVG, CSV, JSON |
| `w` | Wrap long lines or not, for prose shown as its source: Markdown, HTML, text, logs |
| `Backspace`, `-` | Up one folder |
| `h` `l`, left and right arrows | Out of a folder and into one. With a file open, left goes back to the list it was opened from. |
| `Home` `End` | First and last in the folder |
| `PageDown` `PageUp` | Down and up by a page |
| `y` | Copy a link to the file or folder under the cursor, with the key if there is one |
| `/` | Filter this folder |
| `Ctrl K`, `Cmd K` | Find anything in the tree. Start with `>` for commands. |
| `s` | Change the sort |
| `t` | Light or dark |
| `.` | Show hidden files, or hide them again |
| `Esc` | Close the open file or the filter. In a folder entered from the matches, go back to them. |
| `u` | Upload files into this folder. Only with `--allow-upload`. |
| `n` | Make a new file in this folder. Only with `--allow-upload`. |
| `Shift D` | Delete the file or folder. Only with `--allow-delete`. |
| `?` | Show the keys |
### Addresses you can rely on

These addresses are stable. Scripts, bookmarks and `curl` can use them:

| Address | Gives |
| --- | --- |
| `/<path>` | In a browser, the page showing that file or folder. For a program that does not ask for HTML, such as `curl` or `wget`, the file itself. |
| `/raw/<path>` | The file's bytes, with ranges. |
| `/zip/<path>` | A folder as a zip stream. |
| `/?find=<query>` | The page with the search for that query open. |

```sh
curl -O http://127.0.0.1:8080/notes/todo.md
curl -o photos.zip http://127.0.0.1:8080/zip/photos
```

Everything under `/api/` is okfs's own channel to its page. It may change in any release, so do not build on it.

### A folder that is a small site

A folder is shown as its listing. With `--index`, a folder that holds a file of that name opens as that page, at the folder's own address, so a link to the folder is a link to the site:

```sh
okfs --index index.html
```

The page is shown the way any HTML file is: full width under the thin bar, sandboxed. A link in it to another folder opens that folder's index page too. Closing it shows the folder's listing with the page under the cursor. A folder of that name is not an index page. Neither is a file okfs does not serve: a dotfile without `--hidden`, or a link that leaves the served folder.

### A big folder

`Ctrl K` searches an index of every name in the tree, kept in memory. okfs reads the tree once when it starts, and the search works on what it has found so far while that goes on: the count in its footer climbs until it says the tree is indexed.

Some folders are left out of that index, so that a home folder does not spend minutes and hundreds of megabytes on `node_modules` and caches. A folder that is left out is a hidden file in its folder's listing, as a dotfile is: `.` shows it there, and it opens like any other at its address. What is inside it is not searched, not held in memory, and not followed by the watcher beyond telling an open page that something in it changed. These are left out:

- Folders named `node_modules`, `.git`, `.cache`, `.npm` or `.Trash`, wherever they are.
- `Library`, in the served folder, when it is a Mac's home folder.
- What the `.gitignore` files inside the served folder name, each for its own folder and below. A folder is left out when a rule names it as a folder (`build/`, `dist`); files that are named are searched as before. okfs reads only the files in the served folder and below, not those above it, `.git/info/exclude`, or your global ignore file.
- What the file `.okfsignore` in the served folder names. It is written the way a `.gitignore` is, with paths from the served folder, and is read after the `.gitignore` there, so a `!` line in it can let a folder back in.

```gitignore
# .okfsignore in the served folder
photos/raw
backups/
!dist
```

A change to any of these files is read when it happens. The built-in names are always left out. The watcher still looks at the whole tree on Linux: it takes one inotify watch per folder, left out or not, so a very large tree can reach `fs.inotify.max_user_watches`. okfs then reads the folder again on a timer, as described above. To choose that timer, or to spare a large tree the watches, pass `--rescan`:

```sh
okfs --rescan 6h /mnt/archive
```

Each of those reads also removes the cached thumbnails that have not been used for 30 days, which otherwise happens only when okfs starts.
### Letting other machines in

okfs listens on the loopback address, which only the machine it runs on can reach. `--bind 0.0.0.0` lets the network in, and from then on okfs asks for a key. It makes a random one each time it starts, and prints every address with the key on it:

```text
  at       http://192.168.1.20:8080/?key=...
  key      on: anyone with one of these links can read every file shown
```

A request without the key is refused. A browser that opens the link is given a cookie that holds the key, and the key is taken out of the address bar; a program such as `curl` adds `?key=...` to each request. `--qr` prints a code for the same link, so a phone opens the folder by scanning it. The key is new at every start, so an old link stops working when okfs restarts.

What the key does and does not do:

- It stops anyone who can reach the address but does not have the link. It does not stop anyone who can watch the traffic. okfs speaks plain HTTP, so on open Wi-Fi, or on a network whose password others know, a program that captures packets reads the key and then every file. Treat the link as you would a password sent over plain HTTP. For anything beyond a network you trust, put a TLS proxy in front (see [Behind a proxy or a tunnel](#behind-a-proxy-or-a-tunnel)).
- The cookie is `HttpOnly` and `SameSite=Strict`, which keeps scripts and other sites' pages from using it. A browser still sends a cookie to every port of the same host. Any other web service on the same machine, on any port, therefore receives the key from a browser that has opened okfs. Do not run okfs on a machine that also runs listeners you do not trust.
- On a machine with other users, another account can read the command that opens the browser. So the browser okfs opens itself gets a one-time `?once=` code in place of the key. The first request that brings the code trades it for the cookie, and a code no browser has used dies after 60 seconds.
- The key is not a login. Anyone who has the link has all of it: with a write flag, that includes changing and deleting.
- An HTML page from the served folder cannot load its own stylesheet, scripts or images while the key is on. It is sandboxed in an origin of its own, a browser sends it no cookie, and the key is not put in its address on purpose, so its requests for the folder's other files are refused. The page shows with no styling, and its links to other files fail. Without a key, the same page loads them.

`--no-key` turns the key off. Use it only when something in front of okfs already decides who gets in, such as a proxy that signs people in, or on a network where everyone may read the folder. `--key` asks for the key on a loopback address too, for a tunnel that exposes it to anyone. `--allow-upload`, `--allow-edit` and `--allow-delete` each do the same, so that another account on the machine cannot change the folder. The browser okfs opens gets a one-time code, so on your own machine nothing looks different.

### Behind a proxy or a tunnel

On every address it listens on, okfs answers only to `localhost`, to plain addresses such as `127.0.0.1` or `192.168.1.20`, and to the names you give it with `--allow-host`. Any other name in a request's `Host` gets a refusal that names the flag to pass. This stops a hostile web page from reaching okfs by pointing a host name of its own at your machine, also when okfs listens on `0.0.0.0` and the machine it points at is another one on your network. If you put a proxy or a tunnel in front, name the host it uses:

```sh
okfs --allow-host files.example.com
```

A name of your own on the network, such as `my-laptop.local`, needs `--allow-host` too. A plain address always works, as `--bind 0.0.0.0` prints it.

The host check is not a password. A program other than a browser can send any name it likes, so okfs behind a proxy that asks people to sign in is still open to anything that can reach its own address directly. Keep that address where only the proxy can reach it: listen on loopback with the proxy on the same machine, or let a firewall through to okfs's port from the proxy alone. On loopback okfs asks for no key, unless a write flag is on. If okfs has to listen beyond loopback behind a proxy that signs people in, pass `--no-key`, or the proxy's users are asked for a key they do not have.

okfs has no TLS of its own. A proxy that ends TLS gives you https, and okfs then marks its key cookie `Secure` when the proxy sends `X-Forwarded-Proto: https`. A tunnel such as Cloudflare Tunnel or Tailscale Funnel does the same job without a proxy of your own: run okfs on loopback, name the tunnel's host with `--allow-host`, and add `--key` unless the tunnel signs people in.

okfs cannot live under a path such as `example.com/files/`. Every address it uses starts at `/`, and there is no base-path option. Give it a host name of its own, such as `files.example.com`.

### Run it for good

okfs stops cleanly on SIGTERM as well as Ctrl-C, so a service manager can stop it. Run it on loopback, without opening a browser, and put the proxy in front.

#### systemd

`/etc/systemd/system/okfs.service`:

```ini
[Unit]
Description=okfs file browser
After=network.target

[Service]
ExecStart=/usr/local/bin/okfs --no-open --bind 127.0.0.1 --port 8080 --allow-host files.example.com /srv/files
DynamicUser=yes
ReadOnlyPaths=/srv/files
Environment=XDG_CACHE_HOME=/var/cache
CacheDirectory=okfs
NoNewPrivileges=yes
ProtectHome=yes
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`DynamicUser=yes` runs okfs as a user with no account, so the files in `/srv/files` must be readable by everyone. With a write flag, okfs has to be able to write there: use `ReadWritePaths=` in place of `ReadOnlyPaths=`, and a `User=` that owns the folder. `CacheDirectory=okfs` gives it `/var/cache/okfs` for thumbnails and PDF pictures, and `XDG_CACHE_HOME` points okfs there. Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now okfs
```

#### launchd

`~/Library/LaunchAgents/co.example.okfs.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>co.example.okfs</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/okfs</string>
    <string>--no-open</string>
    <string>--bind</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>8080</string>
    <string>/Users/user/files</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/co.example.okfs.plist
```

A service on a Mac reads only the folders it has been given access to. If `/Users/user/files` is under Documents, Desktop or Downloads, give the `okfs` binary Full Disk Access in System Settings first.

#### Caddy

```caddyfile
files.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

Caddy gets the certificate and passes the `Host` header on.

#### nginx

```nginx
server {
    listen 443 ssl;
    server_name files.example.com;
    # ssl_certificate and ssl_certificate_key here

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

`proxy_buffering off` and the long read timeout keep `/api/events`, the stream that tells the page about changes, open. Without them the page still works but stops following the folder.

In both, start okfs with `--allow-host files.example.com`. To ask people to sign in, add that to the proxy (basic auth in Caddy or nginx, or an auth proxy), and keep okfs on loopback.

### Uploading and editing

okfs is read only until you start it with a write flag. Two flags let it change what is there, each a different kind of change:

```sh
okfs --allow-upload        # add files and folders
okfs --allow-edit          # change the files that are there
```

`--allow-upload` only adds. A file whose name is taken is refused, or kept beside the one that is there under the next free name, such as `tides (1).csv`. It never replaces anything, so it is the one to use for a folder that people drop files into.

With it, drop files or folders anywhere on the list to upload them into the folder on screen, or on a folder in the list or a column to upload them into that folder. The upload button above the list, `u` and the palette open the file picker, and the palette can also upload a whole folder. A dropped folder is made, folders and all, before its files. Files land in the list as they arrive, and a small tray in the corner shows how far each has got. A dotfile, or a folder whose name starts with a dot, is left out unless okfs runs with `--hidden`.

When a name is taken, okfs asks: keep both, which is where the focus starts, skip, or replace the file that is there, which only `--allow-edit` offers. The choice can be made once for every other name that is taken in the same upload. `n` and the `+` button make a new, empty file, and the palette makes a new folder. On a phone the upload and `+` buttons sit at the top of the screen; there is no drag and drop.

`--allow-edit` changes files in place. Every change names the version of the file it started from, and is refused when the file has changed on disk since: nothing is lost to a write that came in between. With it, a new file may also replace one of the same name.

Every write lands whole or not at all. The file is written beside where it goes, under a hidden name okfs never shows (`.okfs-....part`), synced to disk, and moved into place in one step. A reader sees the old file or the new one, never part of one, and a write that is cut off leaves nothing. A replaced file keeps its permissions. A symbolic link stays a link, and the file it points at is the one written. A hard link to the old file keeps the old content.

There is no limit on size unless you give one: `--max-upload 4G`.

### Deleting

okfs deletes nothing until you start it with `--allow-delete`:

```sh
okfs --allow-delete
```

The page then shows a delete button for the file or folder under the cursor, `Shift D` does the same, and the palette has it as a command. The palette can also delete the folder you are in, and on a narrow screen such as a phone a button at the top does that. A folder goes with everything in it. okfs always asks first and names what will be removed. There is no trash and no undo.

okfs deletes only what it shows. A folder that holds something it does not show, at any depth, is not deleted: okfs removes nothing and tells you why. That is a dotfile while `--hidden` is off, or a symbolic link that leads out of the served folder. Pass `--hidden` to delete dotfiles too, or remove the entry yourself first. A symbolic link is removed as a link, and the file or folder it points at stays.

A folder is not removed in one step. If the disk refuses part way, for example at a subfolder okfs has no permission to change, okfs says that it stopped part way and shows what is left. What it removed before that point does not come back.

okfs has no accounts, so with a write flag anyone who can reach the address and has its key can change the folder. With this one they can delete (anyone who can reach it, with `--no-key`). Read [What is safe to serve](#what-is-safe-to-serve) before you use it beyond your own machine.

Deleting works only from the address okfs answers to. If you reach okfs through a proxy, a tunnel or a host name of your own, name it with `--allow-host`, also when okfs listens on `0.0.0.0`.
## Themes

<table>
  <tr>
    <td width="50%" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/theme-default-dark.png"><img src="docs/screenshots/theme-default-light.png" alt="The Default theme showing a Markdown file" width="100%"></picture><br><b><code>default</code></b><br>The contract's own values.</td>
    <td width="50%" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/theme-paper-dark.png"><img src="docs/screenshots/theme-paper-light.png" alt="The Paper theme showing a Markdown file" width="100%"></picture><br><b><code>paper</code></b><br>Warm, bookish, serif. Flat: no shadows, almost no radius.</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/theme-terminal-dark.png"><img src="docs/screenshots/theme-terminal-light.png" alt="The Terminal theme showing a Markdown file" width="100%"></picture><br><b><code>terminal</code></b><br>Monospace everywhere, square corners, tight rows, no icons.</td>
    <td width="50%" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/theme-fjord-dark.png"><img src="docs/screenshots/theme-fjord-light.png" alt="The Fjord theme showing a Markdown file" width="100%"></picture><br><b><code>fjord</code></b><br>Cool and roomy: blue-grey surfaces, soft corners, solid icons.</td>
  </tr>
  <tr>
    <td width="50%" valign="top"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/theme-riso-dark.png"><img src="docs/screenshots/theme-riso-light.png" alt="The Riso theme showing a Markdown file" width="100%"></picture><br><b><code>riso</code></b><br>Deliberately loud. Two-ink print: thick outlines, hard offset shadows, capitals.</td>
    <td width="50%" align="center"><b>yours</b><br>One CSS file. See <a href="#write-one">Write one</a>.</td>
  </tr>
</table>

A theme is one CSS file that sets tokens and nothing else. The contract is [`ui/src/styles/tokens.css`](ui/src/styles/tokens.css): 42 tokens for color, type, shape and icons. The built-in themes are in [`themes/`](themes).

```sh
okfs theme list              # the built-in themes
okfs --theme paper           # start in one
okfs --theme ./mine.css      # start in your own
okfs theme check ./mine.css  # check a file against the contract
```

Visitors can switch between the built-in themes in the page, with `Theme` in the palette. Moving over a theme shows it and `Enter` chooses it. The choice is remembered per browser.

### Write one

Copy a file from `themes/`, change the values and run `okfs --theme ./mine.css` to see it on your own files. Edits show on the next page load.

```css
/* @name Mine  @author you  @version 1
   One line about it. */
:root {
  --accent: #2d6a4f;
  --accent-fg: #ffffff;
  --radius: 2px;
  --font-ui: "Newsreader", Georgia, serif;
}
:root[data-scheme="dark"] {
  --accent: #8fc7a6;
  --accent-fg: #14211a;
}
```

<details>
<summary>The rules and bounds a theme file must keep</summary>

The rules, all enforced by `okfs theme check` and again when okfs loads a theme file:

- The file starts with a comment that names the theme with `@name`.
- Exactly two blocks, in this order: `:root` and `:root[data-scheme="dark"]`. Either may be empty. No other selector and no at-rule.
- Only the 42 tokens may be set. A token left out keeps its default.
- Nothing may be loaded: no `url()`, no `@import`, no `@font-face`. Fonts are the three bundled families (`Geist`, `Geist Mono`, `Newsreader`) or ones on the visitor's system.
- Bounds:

  | Token | Allowed |
  | --- | --- |
  | `--text` | 12px to 16px |
  | `--density` | 0.8 to 1.3 |
  | `--radius` | 0 to 12px |
  | `--radius-lg` | 0 to 20px |
  | `--line-w` | 1px to 2px |
  | `--icon-stroke` | 1 to 2 |
  | `--weight`, `--weight-strong` | 100 to 900 |
  | `--tracking` | -0.05em to 0.15em, or -1px to 2px |
  | `--icon-set` | `line`, `solid` or `none` |
  | `--label-case` | `none` or `uppercase` |

- `--bg`, `--surface`, `--fg`, `--faint`, `--accent` and `--accent-fg` are opaque hex or `rgb()` colors, so contrast can be checked. In both schemes `--fg` needs at least 4.5:1 against `--bg` and `--surface`, `--faint` at least 3:1 against `--bg`, and `--accent-fg` at least 3:1 against `--accent`.

</details>

To add a theme to okfs itself, open a pull request that adds one file to `themes/`.

## What is safe to serve

- No path leaves the served folder. Symbolic links that point outside it are not followed and not listed.
- Nothing is written into the served folder, and nothing in it is changed unless you pass `--allow-upload`, `--allow-edit` or `--allow-delete`. Thumbnails and the first pages of PDFs are cached in your cache folder (`$XDG_CACHE_HOME/okfs` on Linux).
- HTML and SVG files from the served folder are always sent sandboxed. They run in an origin of their own, in the preview and when opened directly, so a served page can never act as okfs. One effect: such a page cannot `fetch` its neighbours or load module scripts and web fonts from the folder, and while a key is on, it cannot load its stylesheet, scripts or images from the folder at all.
- A PDF is drawn in a process of its own, which is handed the open file and no path, and is ended after 5 seconds. A PDF that is broken, or made to break a reader, costs that one picture: its preview is then the browser's viewer alone. PDFs over 64 MB are not drawn.
- Only dotfiles are withheld. A file that a `.gitignore` names is still listed, searched and served, as is every other file that is not a dotfile (see [A big folder](#a-big-folder): the ignore rules only decide what is searched and watched). A folder named in a `.gitignore` can be opened at its address. Put nothing in the served folder that you do not want a visitor to read, a `secrets.yml` listed in a `.gitignore` included, or move it out.
- The page itself loads nothing from another site, but Markdown it renders can: an image in a README that points at a remote address is fetched by each visitor's browser from that address. A file in the folder can therefore make every visitor's browser contact a site of its choosing.
- okfs has no accounts. On loopback, only programs on your machine can reach it. Beyond loopback, anyone with the key can read every file in the folder, and the key crosses plain HTTP (see [Letting other machines in](#letting-other-machines-in)). With `--no-key`, anyone who can reach the address can read every file.

With `--allow-upload` or `--allow-edit`:

- Anyone who can reach the address with the key (or anyone at all, with `--no-key`) can add files to the folder, and with `--allow-edit` change every file in it. Use them where you would hand everyone on that network the folder itself.
- A write goes only where okfs shows: never out of the served folder, through a link or a `..`, and never to a dotfile unless you also pass `--hidden`. A new name is one name, with no control characters in it.
- `--allow-upload` alone never replaces or changes a file.
- A change is refused when the file changed since it was read. The check and the step that replaces the file are not split by another write from okfs, but a program outside okfs could still write in the moment between them.
- Another website cannot make your browser write, and an HTML or SVG file in the folder cannot write to its neighbours, by the same rules as for deleting, below.
- With `--allow-edit` the page's policy lets in style elements that carry a nonce made fresh for each page, which the editor needs. Nothing else in the policy changes.

With `--allow-delete`:

- Anyone who can reach the address with the key (or anyone at all, with `--no-key`) can also delete every file and folder in it. There is no password in front of it and no way to get a file back. Use it where you would hand everyone on that network the folder itself.
- Only what okfs shows can go: never the served folder itself, and no dotfile unless you also pass `--hidden`. A folder that holds something okfs does not show, at any depth, is refused whole and nothing in it is removed.
- Deleting never follows a symbolic link that sits in the folder. A link is removed as a link. What it points at is left alone, also when the link sits in a folder that is deleted. A link that leads out of the served folder is not shown, so it is never removed. A delete therefore stays inside the served folder, as long as nothing else changes the folder while the delete runs.
- Deleting is not hardened against another process on the same machine that rewrites the served folder while a delete runs, for example one that swaps a folder for a link at that moment. Do not use `--allow-delete` on a folder that local users you do not trust can write to.
- Another website cannot make your browser delete. okfs takes a delete only from its own page, at the address it answers to: `localhost`, a plain address, or a name from `--allow-host`.
- Another website cannot put the page in a frame and steer your clicks onto the delete button. With this flag, or any write flag, the page tells the browser that only okfs itself may frame it (`frame-ancestors 'self'`). Without them the page can still be framed, and nothing can be changed through it.
- An HTML or SVG file in the folder cannot delete its neighbours. It runs sandboxed, in an origin of its own.

## Develop

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

## License

okfs is released under the MIT License. See `LICENSE`.

Geist, Geist Mono and Newsreader are bundled under the SIL Open Font License 1.1. `THIRD_PARTY.md` holds the notices for them and for the other work okfs bundles; each release attaches the full list, Rust crates included, as `okfs-third-party-notices.md`.
