# How okfs compares

okfs is for looking at a folder. Its previews, columns and search are made for flipping through many files quickly with the keyboard. By default it listens on loopback only, it is read only, it withholds dotfiles, and beyond loopback it asks for a key.

It does less than the tools that manage files, on purpose. It reads until you turn writes on, and it has no accounts. File Browser, the project that FileBrowser Quantum is a fork of, was archived on 2026-09-01.

<!-- comparison:start - written by `npm run comparison` in web/ from web/src/comparison.ts -->

|  | okfs | `python -m http.server` | miniserve | dufs | copyparty |
| --- | --- | --- | --- | --- | --- |
| Default address | loopback only | all interfaces | all interfaces | all interfaces | all interfaces |
| Access control | a key in the link, beyond loopback | none | user and password, optional | accounts with rules for each path, optional | accounts with permissions for each folder, optional |
| Writes | none unless turned on: upload, edit and delete, each behind a flag | none | none unless turned on: upload, new folders and delete, each behind a flag | none unless turned on: upload and delete behind separate flags, or every operation with `-A` | with no arguments, everyone can read and write the current folder; accounts restrict it |
| Previews | images, video, audio, PDF, Markdown, code, CSV, JSON, zip, HTML | none | `README.md` shown in a folder, optional | none named in its README | image gallery with a video player, audio player, text viewer with highlighting, Markdown viewer and editors, thumbnails |
| Search | every name in the tree, from an index kept in memory | none | a filter by name (`?search=`) | by name (`?q=`), with `--allow-search` | by name, path, size and date, from an index on disk, with `-e2dsa` |
| Page follows the disk | yes | none documented | none documented | none documented | none documented for the listing; the index can scan again on a timer |
| TLS | yes, optional | since Python 3.14 | yes, optional | yes, optional | yes |

This is how each tool read on 2026-11-16, from its own documentation. "None documented" means that the pages below name no such feature, not that a test found none. Check the project you are comparing before you rely on a cell.

## Where another tool is the better choice

- Uploads that resume, accounts, or WebDAV, FTP and SFTP: copyparty.
- Users, permissions for each of them, share links, or a login through OIDC or LDAP: FileBrowser Quantum.
- A WebDAV server, or a place to upload to with `curl`: dufs. miniserve takes `curl` uploads too, and its WebDAV is read only.
- A terminal is already open on that machine: yazi, a file manager with previews that runs in the terminal.
- A plain listing for a moment, where Python is installed: `python -m http.server`.
- A file browser under a path such as `example.com/files/`: not okfs, which has no base-path option.

## Sources

- `python -m http.server`: <https://docs.python.org/3/library/http.server.html>
- miniserve: <https://github.com/svenstaro/miniserve/blob/master/README.md>
- dufs: <https://github.com/sigoden/dufs/blob/main/README.md>, <https://github.com/sigoden/dufs/blob/main/src/args.rs>
- copyparty: <https://github.com/9001/copyparty/blob/hovudstraum/README.md>
- FileBrowser Quantum: <https://github.com/gtsteffaniak/filebrowser/blob/main/README.md>
- File Browser: <https://github.com/filebrowser/filebrowser/blob/master/README.md>
- yazi: <https://github.com/sxyazi/yazi/blob/main/README.md>

<!-- comparison:end -->
