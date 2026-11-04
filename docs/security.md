# What is safe to serve

- No path leaves the served folder. Symbolic links that point outside it are not followed and not listed.
- Nothing is written into the served folder, and nothing in it is changed unless you pass `--allow-upload`, `--allow-edit` or `--allow-delete`. With `--allow-delete`, the Trash is kept in `.okfs-trash` at the top of the served folder. Thumbnails and the first pages of PDFs are cached in your cache folder (`$XDG_CACHE_HOME/okfs` on Linux).
- HTML and SVG files from the served folder are always sent sandboxed. They run in an origin of their own, in the preview and when opened directly, so a served page can never act as okfs. One effect: such a page cannot `fetch` its neighbours or load module scripts and web fonts from the folder. While a key is on, the preview shows it with a pass that reads its own folder and below, and nothing else (see [Letting other machines in](network.md#letting-other-machines-in)).
- A PDF is drawn in a process of its own, which is handed the open file and no path, and is ended after 5 seconds. A PDF that is broken, or made to break a reader, costs that one picture: its preview is then the browser's viewer alone. PDFs over 64 MB are not drawn.
- Only dotfiles are withheld. A file that a `.gitignore` names is still listed, searched and served, as is every other file that is not a dotfile (see [A big folder](usage.md#a-big-folder): the ignore rules only decide what is searched and watched). A folder named in a `.gitignore` can be opened at its address. Put nothing in the served folder that you do not want a visitor to read, a `secrets.yml` listed in a `.gitignore` included, or move it out.
- The page itself loads nothing from another site, but Markdown it renders can: an image in a README that points at a remote address is fetched by each visitor's browser from that address. A file in the folder can therefore make every visitor's browser contact a site of its choosing.
- okfs has no accounts. On loopback, only programs on your machine can reach it. Beyond loopback, anyone with the key can read every file in the folder, and without [HTTPS](network.md#https) the key crosses plain HTTP (see [Letting other machines in](network.md#letting-other-machines-in)). With `--no-key`, anyone who can reach the address can read every file.

With `--allow-upload` or `--allow-edit`:

- With `--allow-edit`, a rename or a move never replaces an entry and never leaves the served folder. On an NFS or SMB share it takes two steps, with a moment between them that a program outside okfs could write in (see [Uploading and editing](writing.md#uploading-and-editing)). A folder moves with all it holds, a link moves as a link, and dotfiles are neither moved nor made without `--hidden`. A copy, with `--allow-upload`, follows no link inside a folder: it copies the link.

- Anyone who can reach the address with the key (or anyone at all, with `--no-key`) can add files to the folder, and with `--allow-edit` change every file in it. Use them where you would hand everyone on that network the folder itself.
- A write goes only where okfs shows: never out of the served folder, through a link or a `..`, and never to a dotfile unless you also pass `--hidden`. A new name is one name, with no control characters in it.
- `--allow-upload` alone never replaces or changes a file.
- A change is refused when the file changed since it was read. The check and the step that replaces the file are not split by another write from okfs, but a program outside okfs could still write in the moment between them.
- Another website cannot make your browser write, and an HTML or SVG file in the folder cannot write to its neighbours, by the same rules as for deleting, below.
- With `--allow-edit` the page's policy lets in style elements that carry a nonce made fresh for each page, which the editor needs. Nothing else in the policy changes.

With `--allow-delete`:

- Anyone who can reach the address with the key (or anyone at all, with `--no-key`) can also delete every file and folder in it, and empty the Trash, after which nothing comes back. There is no password in front of it. Use it where you would hand everyone on that network the folder itself.
- Only what okfs shows can go: never the served folder itself, and no dotfile unless you also pass `--hidden`. A folder that holds something okfs does not show, at any depth, is refused whole and nothing in it is removed or moved to the Trash.
- What is in the Trash takes room on the disk until it goes for good. Empty it, or use `--trash-days` or `--no-trash`, where that matters.
- Deleting never follows a symbolic link that sits in the folder. A link is removed as a link. What it points at is left alone, also when the link sits in a folder that is deleted. A link that leads out of the served folder is not shown, so it is never removed. A delete therefore stays inside the served folder, as long as nothing else changes the folder while the delete runs.
- Deleting is not hardened against another process on the same machine that rewrites the served folder while a delete runs, for example one that swaps a folder for a link at that moment. Do not use `--allow-delete` on a folder that local users you do not trust can write to.
- Another website cannot make your browser delete. okfs takes a delete only from its own page, at the address it answers to: `localhost`, a plain address, or a name from `--allow-host`.
- Another website cannot put the page in a frame and steer your clicks onto the delete button. With this flag, or any write flag, the page tells the browser that only okfs itself may frame it (`frame-ancestors 'self'`). Without them the page can still be framed, and nothing can be changed through it.
- An HTML or SVG file in the folder cannot delete its neighbours. It runs sandboxed, in an origin of its own.
