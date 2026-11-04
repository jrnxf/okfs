# How okfs compares

okfs is for looking at a folder. Its previews, columns and search are made for flipping through many files quickly with the keyboard, and its defaults are safe: loopback only, read only, dotfiles hidden, a key beyond loopback.

It does less than the tools that manage files, on purpose. It reads until you turn writes on, and it has no accounts. For uploads of very large files that pick up where a dropped connection left them, use copyparty. For a file manager with users, use File Browser Quantum. File Browser itself was archived in September 2026.

| | okfs | `python -m http.server` | miniserve | dufs | copyparty |
| --- | --- | --- | --- | --- | --- |
| Default address | loopback only | all interfaces | all interfaces | all interfaces | all interfaces |
| Beyond loopback | secret link | none | basic auth, optional | basic or digest auth, optional | accounts |
| Writes | none unless turned on: upload, edit and delete, each behind a flag | none | upload, optional | upload, edit, move and delete, each optional | upload, per account |
| Previews | images, video, audio, PDF, Markdown, code, CSV, JSON, zip, HTML | none | none | none | thumbnails, audio spectrograms |
| Search of the whole tree | instant, in memory | none | none | yes | yes, indexed |
| Live updates | yes | none | none | none | not checked |
| TLS | yes, optional | since Python 3.14 | yes | yes | yes |

This is how each tool read on 2026-10-21, from its documentation. Check the project you are comparing before you rely on a cell.
