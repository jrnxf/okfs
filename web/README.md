# okfs.jrnxf.co

The okfs site: a landing page whose okfs is real. okfs's own page, built from `ui/`, runs in frames against
okfs's own index, built from `src/` for WebAssembly, over a demo folder of about 300,000 entries that the page
makes in the visitor's browser. Nothing is fetched while it runs, and the site is one file, `dist/index.html`.

## How it fits together

- `engine/`: a crate that compiles `src/index.rs`, `src/paths.rs`, `src/skip.rs`, `src/live.rs` and
  `src/every.rs` as they are, for `wasm32-wasip1`, and exports what the page asks: open, build (the first walk),
  search, recent, list, and reread (which returns what the index's feed told, as `/api/events` sends it).
  `list` is server.rs `list_folder` without the readme and links.
- `src/wasi.js`: the WASI calls the engine imports, over a folder held in memory. `src/tree.js` makes that
  folder, "tidewater", from a seed: the same tree in every tab and in the index's worker.
- `src/backend.js`: okfs's HTTP API as its page sees it: listings and search from the engine, previews from
  `demo/answers.json`. `src/media.js`: which real file, picture or template stands behind a path.
  `src/pictures.js`: the pictures and the bell, drawn from a seed.
- `src/frame-host.ts`, `src/frame-address.ts`: inside okfs's frame. okfs's page talks to its server with
  `fetch` and `EventSource`, and puts some addresses straight into `src`; here all of it goes to the page by
  messages, so the site works wherever it is put, even where each frame gets an origin of its own (a
  sandbox, okfs serving the file). okfs reads its own address with `location` and `history`; `build.ts`
  points those reads at the frame's virtual address bar. No other change is made to okfs's page.
- `src/landing.html`, `src/landing.js`, `src/runtime.js`: the page around okfs, with two designs, A "Aurora"
  and B "Signal", switched in the nav, paired with drip's site.
- `demo/files/`: the demo's files with real contents: the tidewater text files, a zip, a PDF (made with
  `typst compile demo/survey.typ`), a 10 s film (two of the page's landscapes, panned and faded with ffmpeg,
  VP9) and a page. `demo/templates/`: one file of each kind whose preview the others borrow.
- `demo/answers.json`: what a real okfs answered for those files (see below).

## Build

```sh
npm install
npm run build     # build.sh: dist/index.html
```

`build.sh` uses Rust with the `wasm32-wasip1` target, binaryen's `wasm-opt` and bun when they are on PATH at
the versions in `tools.sh`, and otherwise downloads them, pinned by checksum, into `.build/tools`. That is
what happens in Cloudflare's Workers Builds.

`demo/answers.json` holds okfs's own previews: Markdown and code as okfs's highlighter colors them, tables,
JSON, readmes and the zip listing. Recording them needs a native okfs, so they are committed. Record them again
when okfs changes how it draws a preview:

```sh
cargo build --release
node web/bake.mjs target/release/okfs
```

`build.ts` checks that every file in `demo/files/` has the size `src/tree.js` gives it.

## Deploy

The Worker is `okfs-web`, at okfs.jrnxf.co (`wrangler.jsonc`). Workers Builds runs `npm run build` in `/web` on
each push that touches `web/`, `src/`, `ui/` or `themes/`: `main` deploys with `wrangler deploy`, other branches
upload a version with `wrangler versions upload`.
