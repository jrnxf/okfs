# harbor

The code behind tidewater: the gauge daemon, the archive, the chart tiles and the site.

| Path        | What                                      |
| ----------- | ----------------------------------------- |
| `apps/`     | the site, the dashboard, the API, the daemon |
| `packages/` | shared TypeScript: tides, charts, ui      |
| `crates/`   | Rust: harmonics, the gauge protocol, tiles |
| `docs/`     | how it fits together                      |

```sh
bun install
bun run dev        # the site and the dashboard
cargo run -p gauge-daemon
```
