<h1 align="center">okfs</h1>

<p align="center">A web file browser. Run it in a folder and flip through every file inside.</p>

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.webp"><img src="docs/screenshots/hero-light.webp" alt="okfs serving a folder: a dense file list on the left, the photo under the cursor on the right" width="100%"></picture>
</p>

`okfs` stands for "ok file server". It is one small binary. The page is compiled into it, so there is nothing to install beside it and nothing is fetched from another site while it runs.

- A dense list on the left, and beside it what is under the cursor: a file is shown as soon as the cursor is on it, in the same pane. Hold `j` to flip through a folder: every file shows as the cursor passes it.
- A page of 256 KB or more, a PDF's viewer and a player wait until the key is let go, unless they were loaded ahead: the next few pages and PDFs past the cursor are, in hidden frames, so a page may run its scripts before you look at it. A PDF shows a picture of its first page meanwhile, and a video one frame of itself when it was reached in time, so a held key flips through those too. A phone has no space bar: there a tap opens the file over the list, with previous and next in a bar at its foot and download and delete behind a `...` button.
- Markdown, an SVG drawing and JSON open as their source, as it is written, colored and never run. `r` flips them to what is made from them, and the choice holds for the files of that kind that follow, until you flip it back or leave the page. An HTML page opens as the page, and a CSV table opens as a table; `r` flips either to its source. Pictures, PDFs, video and audio have no source and are always shown as themselves. There is a button for it beside the file's name. The source of Markdown, an HTML page, a text and a log wraps at the edge of the pane, with wrapped lines hanging from the line number; source code never wraps. `w` turns wrapping off and on, and the choice holds for the files of that kind that follow.
- A folder under the cursor shows what is in it: its list in a column as wide as the main list, then the inside of its first entry in the next, as far down as the window has room. A folder there gets a column of its own, and a file is shown as it would be under the cursor, so a folder that holds one file shows that file. The pointer leads them too: the entry it is on in a column is the one the columns after it go into, a folder or a file, and a key that moves the cursor takes over until the pointer moves again. The window is cut into four equal parts, three under 1,200 px and two under 900 px, and the main list is one of them. Every column comes in one answer, so a held key shows them as it passes. They hold names, sizes and times, and no file is read for them. The main list has the same bar over it as each column, so a folder's rows sit at the same height in every slot, and the columns slide sideways into their new slots as you go in or out.
- Hidden files stay out of the way: dotfiles, and the folders left out of the search, such as `node_modules` and what a `.gitignore` names (see [A big folder](#a-big-folder)). `.`, or the eye button at the top, shows them and hides them again, and the browser remembers the choice. The counts beside each folder are of what is shown, so a folder says how many entries you will find in it, and the bar at the foot says how many are hidden. The search hides the same ones.
- Previews for images, video, audio, PDF, Markdown, source code, CSV, JSON, zip files and HTML pages.
- A palette (`Ctrl K` or `Cmd K`) that finds any file in the whole tree, lists the most recently changed files before you type, and runs commands when you start with `>`.
- The page follows the folder. A file that is added, removed, renamed or rewritten shows at once, and so does an open preview, with no reload.
- Themes: one CSS file each, five built in, light and dark.
- Read only unless you say otherwise. Deleting is behind a flag, `--allow-delete`. There is no upload, no editing and no accounts.

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/palette-dark.webp"><img src="docs/screenshots/palette-light.webp" alt="The palette finding files across the tree" width="49%"></picture>
</p>

## Install

With nix, run it without installing anything, or put it on your `PATH`:

```sh
nix run github:jrnxf/okfs -- ~/photos   # run it once
nix profile install github:jrnxf/okfs   # or install it
```

`nix profile upgrade okfs` brings an installed copy up to date.

On x86-64 Linux, each [release](https://github.com/jrnxf/okfs/releases) has the binary on its own, built on Ubuntu 24.04, so it runs on any system with glibc 2.39 or newer:

```sh
gh release download --repo jrnxf/okfs --pattern 'okfs-x86_64-unknown-linux-gnu*'
sha256sum -c okfs-x86_64-unknown-linux-gnu.sha256
chmod +x okfs-x86_64-unknown-linux-gnu
```

Without nix you need a Rust toolchain and [bun](https://bun.sh). Bun builds the page while cargo builds the binary.

```sh
cargo install --path .    # from a checkout of this repository
```

To build without installing, the nix dev shell has both:

```sh
nix develop
cargo build --release    # the binary is target/release/okfs
```

The engine that draws the first page of a PDF is about 6 MB of the binary. `cargo build --release --no-default-features` leaves it out: PDFs then open in the browser's viewer alone. Every other preview is the same.

## Use

```sh
okfs                        # serve this folder at http://127.0.0.1:8080/
okfs ~/photos --port 9000   # another folder, another port
okfs --bind 0.0.0.0         # let other machines on the network in
okfs --bind 0.0.0.0 --qr    # and print a QR code a phone can scan to open it
```

A folder's `README.md` is shown under its listing.

The page follows changes through a watcher on the folder. Where okfs cannot set one up, it reads the folder again every 30 seconds and the page catches up at that pace. Something reached through a symbolic link is not followed as it changes: it catches up when the page is reloaded or shown again.

<details>
<summary>All flags</summary>

| Flag | What it does |
| --- | --- |
| `[PATH]` | The folder to serve. Default: the current folder. |
| `-b`, `--bind <ADDR>` | Address to listen on. Default `127.0.0.1`. |
| `-p`, `--port <PORT>` | Port to listen on. Default `8080`. |
| `--qr` | Print a QR code for the first address another device can use, in a terminal. Off by default. |
| `--no-open` | Do not open the browser. It opens by default in a terminal, never as a service and never over SSH. |
| `--index <FILE>` | Open a folder that holds a file of this name as that page: `--index index.html`. Off by default. See below. |
| `--theme <NAME\|FILE>` | Theme a new visitor starts in: a built-in name or a theme file. |
| `--css <FILE>` | Your own stylesheet, loaded after the theme. Class names are not a promise and may change. |
| `--header <FILE.md>` | A Markdown note shown above every folder. |
| `--title <TEXT>` | Name shown in the corner and the browser tab. Default `okfs`. |
| `--accent <COLOR>` | Accent color in every theme, as hex: `"#2d6a4f"`. |
| `-H`, `--hidden` | Serve dotfiles, and show hidden files to a browser that has made no choice with `.`. Without it, dotfiles are never sent, and `.` shows only the folders left out of the search. |
| `--allow-host <NAME>` | Also answer to this host name. Repeatable. See below. |
| `--allow-delete` | Let anyone who can reach the address delete files and folders. Off by default. See [Deleting](#deleting). |

</details>

### Keys

| Key | Does |
| --- | --- |
| `j` `k`, arrows | Move down and up |
| `Enter` | Open the folder, or give the file the full width |
| `r` | Rendered or source, for a file that has both: HTML, Markdown, SVG, CSV, JSON |
| `w` | Wrap long lines or not, for prose shown as its source: Markdown, HTML, text, logs |
| `Backspace`, `-` | Up one folder |
| `h` `l`, left and right arrows | Out of a folder and into one. With a file open, back and on through the folder's files. |
| `Home` `End` | First and last in the folder |
| `/` | Filter this folder |
| `Ctrl K`, `Cmd K` | Find anything in the tree. Start with `>` for commands. |
| `s` | Change the sort |
| `t` | Light or dark |
| `.` | Show hidden files, or hide them again |
| `Esc` | Close the open file or the filter |
| `Shift D` | Delete the file or folder. Only with `--allow-delete`. |
| `?` | Show the keys |

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

A change to any of these files is read when it happens. The built-in names are always left out. The watcher still looks at the whole tree on Linux: it takes one inotify watch per folder, left out or not, so a very large tree can reach `fs.inotify.max_user_watches`. okfs then reads the folder again every 30 seconds, as described above.

### Behind a proxy or a tunnel

While okfs listens on a loopback address it answers only to `localhost` and to plain addresses. This stops a hostile web page from reaching it by pointing a host name at your machine. If you put a proxy or a tunnel in front, name the host it uses:

```sh
okfs --allow-host files.example.com
```

### Deleting

okfs is read only until you start it with `--allow-delete`:

```sh
okfs --allow-delete
```

The page then shows a delete button for the file or folder under the cursor, `Shift D` does the same, and the palette has it as a command. The palette can also delete the folder you are in, and on a narrow screen such as a phone a button at the top does that. A folder goes with everything in it. okfs always asks first and names what will be removed. There is no trash and no undo.

okfs deletes only what it shows. A folder that holds something it does not show, at any depth, is not deleted: okfs removes nothing and tells you why. That is a dotfile while `--hidden` is off, or a symbolic link that leads out of the served folder. Pass `--hidden` to delete dotfiles too, or remove the entry yourself first. A symbolic link is removed as a link, and the file or folder it points at stays.

A folder is not removed in one step. If the disk refuses part way, for example at a subfolder okfs has no permission to change, okfs says that it stopped part way and shows what is left. What it removed before that point does not come back.

okfs has no accounts, so with this flag anyone who can reach the address can delete. Read [What is safe to serve](#what-is-safe-to-serve) before you use it beyond your own machine.

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
- Nothing is written into the served folder, and nothing in it is changed unless you pass `--allow-delete`. Thumbnails and the first pages of PDFs are cached in your cache folder (`$XDG_CACHE_HOME/okfs` on Linux).
- HTML and SVG files from the served folder are always sent sandboxed. They run in an origin of their own, in the preview and when opened directly, so a served page can never act as okfs. One effect: such a page cannot `fetch` its neighbours or load module scripts and web fonts from the folder.
- A PDF is drawn in a process of its own, which is handed the open file and no path, and is ended after 5 seconds. A PDF that is broken, or made to break a reader, costs that one picture: its preview is then the browser's viewer alone. PDFs over 64 MB are not drawn.
- okfs has no accounts. Anyone who can reach the address can read every file in the folder.

With `--allow-delete`:

- Anyone who can reach the address can also delete every file and folder in it. There is no password in front of it and no way to get a file back. Use it where you would hand everyone on that network the folder itself.
- Only what okfs shows can go: never the served folder itself, and no dotfile unless you also pass `--hidden`. A folder that holds something okfs does not show, at any depth, is refused whole and nothing in it is removed.
- Deleting never follows a symbolic link that sits in the folder. A link is removed as a link. What it points at is left alone, also when the link sits in a folder that is deleted. A link that leads out of the served folder is not shown, so it is never removed. A delete therefore stays inside the served folder, as long as nothing else changes the folder while the delete runs.
- Deleting is not hardened against another process on the same machine that rewrites the served folder while a delete runs, for example one that swaps a folder for a link at that moment. Do not use `--allow-delete` on a folder that local users you do not trust can write to.
- Another website cannot make your browser delete. okfs takes a delete only from its own page, at the address it answers to: `localhost`, a plain address, or a name from `--allow-host`.
- Another website cannot put the page in a frame and steer your clicks onto the delete button. With this flag the page tells the browser that only okfs itself may frame it (`frame-ancestors 'self'`). Without the flag the page can still be framed, and nothing can be deleted through it.
- An HTML or SVG file in the folder cannot delete its neighbours. It runs sandboxed, in an origin of its own.

## Develop

```sh
nix develop
cargo test                                  # server behavior and the theme checker
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cd ui && bun run check                      # type check the page and test it
```

The server is Rust (axum, tokio). The page is TypeScript and Preact in `ui/`, built by `build.rs` into the binary. To work on the page without rebuilding the binary each time, run a debug build with `OKFS_UI_DIR=ui/dist` and rebuild the page with `cd ui && bun run build`.

The pictures in `docs/screenshots/` are shot again with one command, from a release build and a folder to serve. It needs `chrome-devtools-axi` and nix. The script says which files the folder must hold:

```sh
cargo build --release
scripts/shoot-readme.sh path/to/tidewater
```

## License

okfs is released under the MIT License. See `LICENSE`.

Geist, Geist Mono and Newsreader are bundled under the SIL Open Font License 1.1.
