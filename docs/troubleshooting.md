# Troubleshooting

The errors a new user meets first, and the short answers: update, uninstall, the cache and browsers.

## 403: okfs does not answer to the name

```text
okfs does not answer to the name "files.example.com".
To allow it, start okfs with: --allow-host files.example.com
```

okfs answers only to `localhost`, a name that ends in `.localhost`, and a plain IP address. A request that carries another host name, such as the machine's own name, is refused. This stops a page on another site from reaching okfs through a name that points at your machine.

To use a name of your own, such as the one a proxy or a tunnel gives, pass it once for each name:

```sh
okfs --allow-host files.example.com
```

Give the name alone: no `http://`, no port and no path. See [Behind a proxy or a tunnel](network.md#behind-a-proxy-or-a-tunnel).

## 401: this link needs its key

Beyond loopback, and with a write flag or `--require-key`, okfs asks for the key that it prints when it starts. A request without it gets a 401.

- Open one of the addresses okfs printed. Each one ends in `?key=...`.
- The key is new at every start. A link or a QR code from an earlier start no longer works: use the new one.
- With `curl`, add `?key=...` to each address.

See [Letting other machines in](network.md#letting-other-machines-in) for what the key does and why there is no fixed one.

## The port is busy

```text
cannot listen on 127.0.0.1:9000: the port is busy. Pass another --port, or --port 0 for any free one
```

Without `--port`, okfs takes 8080, or the next free port after it, and prints the one it took. With `--port`, it takes that port or none, because a proxy or a bookmark points at it. Pass another port, or `--port 0` for any free one. To see what holds the port, run `lsof -i :9000` on Linux or a Mac.

## Update

| Installed with | Update with |
| --- | --- |
| Homebrew | `brew upgrade okfs` |
| nix | `nix profile upgrade okfs` |
| Docker | `docker pull ghcr.io/jrnxf/okfs:<version>`, then start the container again |
| cargo | the `cargo install` command again, with `--force` |
| A release archive | download the new archive and put its `okfs` in place of the old one |

## Uninstall

| Installed with | Remove with |
| --- | --- |
| Homebrew | `brew uninstall okfs` |
| nix | `nix profile remove okfs` |
| Docker | `docker image rm ghcr.io/jrnxf/okfs` |
| cargo | `cargo uninstall okfs` |
| A release archive | delete the `okfs` binary |

okfs writes nothing else outside the cache below, and nothing into the served folder unless a write flag is on. With `--allow-delete`, the Trash is the folder `.okfs-trash` at the top of the served folder.

## The cache

okfs keeps the thumbnails and the pictures of PDF first pages that it makes in one folder:

| System | Folder |
| --- | --- |
| Linux | `$XDG_CACHE_HOME/okfs/thumbs`, or `~/.cache/okfs/thumbs` |
| macOS | `~/Library/Caches/okfs/thumbs` |
| Windows | `%LOCALAPPDATA%\okfs\thumbs` |

okfs removes a thumbnail that has not been used for 30 days. You can delete the folder at any time: okfs makes the thumbnails again when it needs them. In the Docker image, the cache is the volume `/cache`.

## Browsers

The page is tested in Chromium, in CI, at every change. It is written for current browsers: Chrome, Edge, Firefox and Safari. No other browser is tested in CI, so report what does not work in one of them.

## Report a bug

Open an issue on [GitHub](https://github.com/jrnxf/okfs/issues). Report a vulnerability in private, as [SECURITY.md](../SECURITY.md) tells.
