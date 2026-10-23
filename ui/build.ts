// Builds the page into dist/: two scripts and the editor's chunk, one stylesheet, the fonts, the third-party notices
// and the HTML shell.
// The Rust build embeds everything in dist/ into the binary.
import { cp, mkdir, rm } from "node:fs/promises";
import { buildCss, uiSources } from "./css";

const out = "dist";
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/fonts`, { recursive: true });

const scripts = [
  // The app, loaded as a module. What it imports only when it is needed, the editor, is a chunk of its own beside it.
  { entry: "src/main.tsx", format: "esm", splitting: true },
  // Runs before first paint to apply the saved theme, so it must not be deferred.
  { entry: "src/boot.ts", format: "iife", splitting: false },
] as const;
for (const { entry, format, splitting } of scripts) {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: out,
    format,
    splitting,
    target: "browser",
    minify: true,
    naming: { entry: "[name].js", chunk: "[name]-[hash].js" },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

// The stylesheet, with the utilities the page's markup uses: see css.ts.
await Bun.write(`${out}/app.css`, await buildCss("src/styles/app.css", uiSources()));

// Geist, Geist Mono and Newsreader are under the SIL Open Font License 1.1, which allows bundling.
const fonts = [
  "geist/files/geist-latin-wght-normal.woff2",
  "geist/files/geist-latin-ext-wght-normal.woff2",
  "geist-mono/files/geist-mono-latin-wght-normal.woff2",
  "geist-mono/files/geist-mono-latin-ext-wght-normal.woff2",
  "newsreader/files/newsreader-latin-opsz-normal.woff2",
  "newsreader/files/newsreader-latin-ext-opsz-normal.woff2",
  "newsreader/files/newsreader-latin-opsz-italic.woff2",
];
for (const font of fonts) {
  await cp(`node_modules/@fontsource-variable/${font}`, `${out}/fonts/${font.split("/").pop()}`);
}

// The fonts' licenses, and the other notices for what the binary bundles, travel with it.
await cp("../THIRD_PARTY.md", `${out}/THIRD_PARTY.md`);

await cp("index.html", `${out}/index.html`);
await cp("src/favicon.svg", `${out}/favicon.svg`);
