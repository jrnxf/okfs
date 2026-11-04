# Uploading, editing and deleting

## Uploading and editing

okfs is read only until you start it with a write flag. Two flags let it change what is there, each a different kind of change:

```sh
okfs --allow-upload        # add files and folders
okfs --allow-edit          # change the files that are there
```

`--allow-upload` only adds. A file whose name is taken is refused, or kept beside the one that is there under the next free name, such as `tides (1).csv`. It never replaces anything, so it is the one to use for a folder that people drop files into.

With it, drop files or folders anywhere on the list to upload them into the folder on screen, or on a folder in the list or a column to upload them into that folder. The upload button above the list, `u` and the palette open the file picker, and the palette can also upload a whole folder. A dropped folder is made, folders and all, before its files. Files land in the list as they arrive, and a small tray in the corner shows how far each has got. A dotfile, or a folder whose name starts with a dot, is left out unless okfs runs with `--hidden`.

When a name is taken, okfs asks: keep both, which is where the focus starts, skip, or replace the file that is there, which only `--allow-edit` offers. The choice can be made once for every other name that is taken in the same upload. `n` and the `+` button make a new, empty file, and the palette makes a new folder. On a phone the upload and `+` buttons sit at the top of the screen; there is no drag and drop.

`--allow-edit` changes files in place. Every change names the version of the file it started from, and is refused when the file has changed on disk since: nothing is lost to a write that came in between. With it, a new file may also replace one of the same name.

With it, entries can also be renamed and moved. A right click on a row, a long press on a phone, or `a` opens a menu of what can be done there: open, rename, move, copy, duplicate, download, copy the link or the path, and move to the Trash. A right click on the empty space of the list is about the folder: a new file or folder, upload, select all, sort, the zip, and the Trash. `Shift` and a right click give the browser's own menu. What the server does not allow is left out of the menu, and a line at its foot says which flag would turn it on.

Rename happens in the row: the name turns into a field with the part before the extension selected. `Enter` saves, `Esc` puts the old name back, and a click elsewhere saves. A name that is empty, holds a `/`, starts with a dot without `--hidden`, or is taken in the folder is refused under the field before it is sent. Move to and Copy to open a folder picker, with the tree open at the folder you are in and a field that finds any folder by name. Rows can also be dragged onto a folder in the list or a column, or onto a folder in the path above, to move them, or with `Alt` held, to copy them. A move is one rename on the disk and never replaces anything: a name taken where it goes is kept beside it under the next free name, such as `notes (1).md`, as an upload does. A folder cannot go inside itself, and a move across disks is refused. A copy is put together under a hidden name and moved into place whole, and copies only what okfs shows; `--max-upload` limits it as it does an upload. Copying needs `--allow-upload`, as it adds.

Several rows can be selected: `Ctrl` or `Cmd` and a click picks one more, `Shift` and a click picks from the last one picked, and `Space`, `Shift` and the arrows, and `Ctrl A` do the same from the keys. As in Finder and Explorer, a `Shift` click replaces the range it made before rather than adding to it, so going back shrinks it, and what was picked with `Ctrl` stays. On a phone, Select in the menu ticks the row and shows a box on every row; a `Shift` tap gives every row between the last one tapped and this one the state this one takes, so a range can be unticked too. The menu, `m`, `c` and `Shift D` then act on all of them.

What was just renamed, moved, copied or moved to the Trash is said in a note at the foot of the page, with Undo and `Ctrl Z` or `Cmd Z`, for 8 seconds or as long as the pointer is on it.

With it, `e`, the pen button above a text file and the palette open the file in an editor, in place of its preview and at the full width. That is any text file of up to 2 MB: code, Markdown, JSON, CSV, HTML, plain text and logs. The editor colors code in the theme's own colors, and finds and replaces with `Ctrl F` or `Cmd F`. Its bar says whether the text is saved and how many lines changed. `Ctrl S` or `Cmd S` saves, Discard drops the changes, and `Esc` leaves, asking first when something is unsaved. A file keeps the line endings and the byte-order mark it had. A file that mixes CRLF and LF endings is the one exception: the editor says so, and a save writes the ending most of its lines have at the end of every line, counted in the lines changed. When the file changes on disk while it is open, a bar says so and offers their version, which undo can take back, or yours over it. Nothing is lost either way. The editor is loaded only the first time a file is edited, so a server without `--allow-edit` never sends it. On a phone the pen sits behind the `...` button. With `--allow-upload` as well, a new file made with `n` opens in the editor.

Every write lands whole or not at all. The file is written beside where it goes, under a hidden name okfs never shows (`.okfs-....part`), synced to disk, and moved into place in one step. A reader sees the old file or the new one, never part of one, and a write that is cut off leaves nothing. A replaced file keeps its permissions. A symbolic link stays a link, and the file it points at is the one written. A hard link to the old file keeps the old content.

A rename, a move, a copy of a folder and putting back from the Trash take one step on most disks, which the disk refuses when the name is taken. An NFS or SMB share has no such step, and there okfs takes two, still never over an entry that is there. A file gets its new name with a hard link, which the disk refuses when the name is taken, and then loses the old one: for that moment it has both names, and a power cut then leaves it under both, with nothing lost. A folder, or a file on a disk with no hard links, first takes its new name with an empty folder or file of its own and is then renamed over it. Only in the moment between the two steps could a program outside okfs write into that empty file, which the rename would then replace, or swap that empty folder for an empty one of its own.

There is no limit on size unless you give one: `--max-upload 4G`.

## Deleting

okfs deletes nothing until you start it with `--allow-delete`:

```sh
okfs --allow-delete
```

The page then shows a delete button for the file or folder under the cursor, `Shift D` does the same, and the menu and the palette have it as a command. The palette can also delete the folder you are in, and on a narrow screen such as a phone a button at the top does that. A folder goes with everything in it.

A delete moves the entry to the Trash at once, without asking, and a note at the foot of the page offers Undo. The Trash keeps it for 30 days, or as many as `--trash-days` says, and then deletes it for good. The trash button in the top bar shows how many entries it holds and opens it in place of the list: each entry with the folder it was in, when it was deleted and how many days it has left, and beside it Put back and Delete forever. Put back returns the entry to where it was, makes its folder again when that is gone, and when its name is taken there by then, brings it back under the next free name. Delete forever and Empty Trash ask first and name what goes: those cannot be undone. In the Trash, `Shift R` puts back and `Shift Backspace` deletes for good.

The Trash is a folder at the top of the served folder, `.okfs-trash`. okfs never lists, serves, searches, zips or writes to it through a request, even with `--hidden`. As it is on the same disk as the files, a move into the Trash and back is one rename: instant for a folder of any size, and whole or not at all. An entry in a folder on another disk, such as a drive mounted inside the served folder, cannot go there: okfs says so and offers to delete it for good. What is past its days goes when okfs starts and every hour after, and only while `--allow-delete` is on: without it, okfs changes nothing in the folder, and the Trash waits. `--no-trash` turns the Trash off: a delete then asks first, names what will be removed, and is for good, with no undo.

okfs deletes only what it shows. A folder that holds something it does not show, at any depth, is not deleted: okfs removes nothing and tells you why. That is a dotfile while `--hidden` is off, or a symbolic link that leads out of the served folder. Pass `--hidden` to delete dotfiles too, or remove the entry yourself first. A symbolic link is removed as a link, and the file or folder it points at stays.

A folder is not removed in one step. If the disk refuses part way, for example at a subfolder okfs has no permission to change, okfs says that it stopped part way and shows what is left. What it removed before that point does not come back.

okfs has no accounts, so with a write flag anyone who can reach the address and has its key can change the folder. With this one they can delete (anyone who can reach it, with `--no-key`). Read [What is safe to serve](security.md) before you use it beyond your own machine.

Deleting works only from the address okfs answers to. If you reach okfs through a proxy, a tunnel or a host name of your own, name it with `--allow-host`, also when okfs listens on `0.0.0.0`.
