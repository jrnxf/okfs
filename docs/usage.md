# Using okfs

## The page

These are the details behind the list above.

- A dense list on the left, and beside it what is under the cursor: a file is shown as soon as the cursor is on it, in the same pane. Hold `j` to flip through a folder: every file shows as the cursor passes it.
- A page of 256 KB or more, a PDF's viewer and a player wait until the key is let go, unless they were loaded ahead: the next few pages and PDFs past the cursor are, in hidden frames, so a page may run its scripts before you look at it. A PDF shows a picture of its first page meanwhile, and a video one frame of itself when it was reached in time, so a held key flips through those too. A phone has no space bar: there a tap opens the file over the list, with previous and next in a bar at its foot and download and delete behind a `...` button.
- Markdown opens rendered, an HTML page opens as the page, and a CSV table opens as a table, from the list and from a link to the file alike; `r` flips each to its source, as it is written, colored and never run. An SVG drawing and JSON open as their source, and `r` flips them to what is made from them. The choice holds for the files of that kind that follow, until you flip it back or leave the page. Pictures, PDFs, video and audio have no source and are always shown as themselves. There is a button for it beside the file's name. The source of Markdown, an HTML page, a text and a log wraps at the edge of the pane, with wrapped lines hanging from the line number; source code never wraps. `w` turns wrapping off and on, and the choice holds for the files of that kind that follow.
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

## Options from the environment

Every option can also come from an environment variable named for it: `OKFS_PORT` for `--port`, `OKFS_BIND`, `OKFS_THEME`, `OKFS_ALLOW_UPLOAD`, `OKFS_RESCAN`, and the folder itself as `OKFS_PATH`. `okfs --help` shows each one as `[env: OKFS_PORT=]`. That is how a Docker Compose file or a systemd unit configures okfs without a command line to rewrite. A flag on the command line beats the variable. A switch takes `true` or `false`: `OKFS_ALLOW_UPLOAD=true`. `OKFS_ALLOW_HOST` takes names separated by commas, and `--allow-host a,b` on the command line now means two names too. A switch also accepts `1`, `0`, `yes`, `no`, `on` and `off`, and an empty one counts as off, so an unset `${VAR}` in a Compose file does no harm. `--no-key` with `--key`, and `--no-trash` with `--trash-days`, are refused when either one comes from a variable and both are on. `--key` is the one that is not `OKFS_KEY`, which would read as the key's value: `--key` is `OKFS_ASK_KEY`, and `--no-key` is `OKFS_NO_KEY`.

```yaml
services:
  okfs:
    image: ghcr.io/jrnxf/okfs
    ports: ["8080:8080"]
    volumes: ["/srv/photos:/srv:ro"]
    environment:
      OKFS_THEME: gruvbox
      OKFS_TITLE: Photos
```

The page follows changes through a watcher on the folder. Where okfs cannot set one up, it says so when it starts and reads the whole folder again on a timer: every 30 seconds, or 20 times as long as one read of it takes when that is longer, so a tree that takes minutes to read is not read over and over. The page catches up at that pace. Something reached through a symbolic link is not followed as it changes: it catches up when the page is reloaded or shown again.

With `--rescan`, okfs sets up no watcher and reads the whole folder again on a timer you choose: `--rescan 6h`. That suits a tree too big to watch, and a network share, where a watcher does not see what other machines change. A folder's listing is always read from the disk when it is opened, so only what comes from the index waits for the next read: the search, its list of recent files, and how many entries a folder holds.

<details>
<summary>All flags</summary>

| Flag | What it does |
| --- | --- |
| `[PATH]` | The folder to serve. Default: the current folder. |
| `-b`, `--bind <ADDR>` | Address to listen on: an IP address or `localhost`. Default `127.0.0.1`. Beyond loopback, a [key](network.md#letting-other-machines-in) is asked for. |
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
| `--no-key` | Let in anyone who reaches an address beyond loopback, with no key. For a proxy that signs people in itself. See [Letting other machines in](network.md#letting-other-machines-in). |
| `--allow-host <NAME>` | Also answer to this host name. Repeatable. See below. |
| `--tls-cert <FILE>` | Serve https with this certificate, in PEM. Needs `--tls-key`. See [HTTPS](network.md#https). |
| `--tls-key <FILE>` | The private key of the `--tls-cert` certificate, in PEM. Needs `--tls-cert`. |
| `--allow-upload` | Let anyone who can reach the address add files and folders. A file never replaces one that is there. Off by default. See [Uploading and editing](writing.md#uploading-and-editing). |
| `--allow-edit` | Let anyone who can reach the address change the files that are there, and rename and move them. Off by default. See [Uploading and editing](writing.md#uploading-and-editing). |
| `--allow-delete` | Let anyone who can reach the address delete files and folders. A delete goes to the Trash first. Off by default. See [Deleting](writing.md#deleting). |
| `--trash-days <DAYS>` | How long the Trash keeps what is deleted before it goes for good. 30 by default. |
| `--no-trash` | Delete for good at once, after asking, with no Trash and no undo. |
| `--max-upload <SIZE>` | The largest file an upload or a save may be: `500M`, `4G`. No limit by default. |
| `--rescan <EVERY>` | Read the whole tree again this often instead of watching it for changes: `90s`, `30m`, `6h`, `1d`, `1h30m`. Off by default. See [A big folder](#a-big-folder). |

</details>
## Keys

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
| `Esc` | Let the selection go, or close the open file or the filter. In a folder entered from the matches, go back to them. |
| `a`, `Shift F10`, the menu key | The menu of the row under the cursor, or of the selection: the same menu a right click opens |
| `Space` | Select the row and step down. With `Shift`, select from the anchor to the row. |
| `Shift` and the arrows | Select from the anchor, growing and shrinking as `Shift` and a click do |
| `Ctrl A`, `Cmd A` | Select every row of the folder |
| `Y` | Copy the path of the row, or of every selected row |
| `e` | Edit the text file. Only with `--allow-edit`. |
| `F2`, `Shift R` | Rename in place. Only with `--allow-edit`. |
| `m` | Move to a folder you pick. Only with `--allow-edit`. |
| `c` | Copy to a folder you pick. Only with `--allow-upload`. |
| `u` | Upload files into this folder. Only with `--allow-upload`. |
| `n`, `Shift N` | Make a new file or folder in this folder and name it in place. Only with `--allow-upload`. |
| `Shift D` | Move the file or folder, or the selection, to the Trash. Only with `--allow-delete`. |
| `Ctrl Z`, `Cmd Z` | Undo the last move to the Trash, rename, move or copy, while its note is up |
| `?` | Show the keys |
## Addresses you can rely on

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

## A folder that is a small site

A folder is shown as its listing. With `--index`, a folder that holds a file of that name opens as that page, at the folder's own address, so a link to the folder is a link to the site:

```sh
okfs --index index.html
```

The page is shown the way any HTML file is: full width under the thin bar, sandboxed. A link in it to another folder opens that folder's index page too. Closing it shows the folder's listing with the page under the cursor. A folder of that name is not an index page. Neither is a file okfs does not serve: a dotfile without `--hidden`, or a link that leaves the served folder.

## A big folder

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
