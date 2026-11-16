# Security

okfs is a file server. It has had no outside security review yet. [docs/security.md](docs/security.md) states what each default does and does not stop, and [docs/network.md](docs/network.md) covers the key and HTTPS.

## Supported versions

Only the latest release gets fixes. Check that the fault is still there in the latest release before you report it.

## Report a vulnerability

Report it in private, not in a public issue or discussion. On the repository's [Security tab](https://github.com/jrnxf/okfs/security), choose "Report a vulnerability". The direct link is <https://github.com/jrnxf/okfs/security/advisories/new>.

Please include the output of `okfs --version`, the command line, and the steps or a file that shows the fault.

## In scope

A way to make okfs break a statement in [docs/security.md](docs/security.md) is in scope. Examples:

- a read or a write that leaves the served folder, by a path, a `..` or a symbolic link
- a read beyond loopback without the key, while a key is on
- a write, a rename or a delete without the flag that allows it
- a served HTML or SVG file that acts with the rights of the okfs page
- another website that makes a visitor's browser write or delete
- a file that crashes or hangs the server

## Out of scope

- What the docs already state as a limit: the key is a shared secret and not a login, it crosses plain HTTP unless HTTPS is on, and `--no-key` lets in anyone who can reach the address.
- Faults that need another process on the same machine to rewrite the served folder while okfs writes to it. docs/security.md names these.
- Faults in a proxy, a tunnel or a browser in front of okfs.
