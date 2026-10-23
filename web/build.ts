// Builds the site into dist: the front page, dist/index.html, and the demo, dist/demo/index.html. The demo is one
// page holding okfs's page from ui/src, okfs's index from src/ compiled to WebAssembly (build.sh builds it first),
// what bake.mjs recorded from a real okfs, the demo's own files, and the page around them. The front page runs the
// same okfs from the same data, which it fetches as one file beside it. Run through build.sh, which puts the tools
// in place.
//
//   bun run build.ts <engine.wasm> <out-dir>
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { BunPlugin } from "bun";
import { buildCss, uiSources } from "../ui/css";

const web = import.meta.dir;
const repo = join(web, "..");
const ui = join(repo, "ui");
const [wasmPath, outDir] = process.argv.slice(2);
if (!wasmPath || !outDir) throw new Error("usage: bun run build.ts <engine.wasm> <out-dir>");

// okfs's page reads its own address and history. Its frame has no address of its own to give, so the demo
// build points those reads at the frame's virtual address bar (src/frame-address.ts). Nothing else changes.
const virtualAddress: BunPlugin = {
  name: "virtual-address",
  setup(build) {
    build.onLoad({ filter: /\/ui\/src\/.*\.tsx?$/ }, async ({ path }) => {
      const text = await Bun.file(path).text();
      const contents = text.replace(/(?<![\w$.?])location\./g, "__vloc.").replace(/(?<![\w$.?])history\./g, "__vhist.");
      return { contents, loader: path.endsWith("x") ? "tsx" : "ts" };
    });
  },
};

async function bundle(entry: string, plugins: BunPlugin[] = [], format: "iife" | "esm" = "iife"): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(web, entry)],
    format,
    target: "browser",
    minify: true,
    plugins,
    tsconfig: join(ui, "tsconfig.json"),
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  return await result.outputs[0]!.text();
}

const frameBoot = await bundle("src/demo-boot.ts", [virtualAddress]);
// A module: it waits, at its top level, for the page around the frame to hand over the files (wait-for-host.ts).
const frameMain = await bundle("src/demo-main.tsx", [virtualAddress], "esm");
const worker = await bundle("src/worker.js");
const pictures = await bundle("src/pictures-worker.js");
const landing = await bundle("src/landing.js");
const site = await bundle("src/site.js");

// okfs's stylesheet, as ui/build.ts makes it, with the latin fonts only (the demo folder is plain latin).
const FONTS = ["geist-latin-wght-normal", "geist-mono-latin-wght-normal", "newsreader-latin-opsz-normal", "newsreader-latin-opsz-italic"];
let css = await buildCss(join(ui, "src/styles/app.css"), uiSources());
css = css.replace(/@font-face\s*{[^}]*latin-ext[^}]*}/g, "");
const fontFiles: Record<string, string> = {
  "geist-latin-wght-normal": "geist/files/geist-latin-wght-normal.woff2",
  "geist-mono-latin-wght-normal": "geist-mono/files/geist-mono-latin-wght-normal.woff2",
  "newsreader-latin-opsz-normal": "newsreader/files/newsreader-latin-opsz-normal.woff2",
  "newsreader-latin-opsz-italic": "newsreader/files/newsreader-latin-opsz-italic.woff2",
};
const fonts: Record<string, string> = {};
for (const name of FONTS) {
  fonts[name] = readFileSync(join(ui, "node_modules/@fontsource-variable", fontFiles[name]!)).toString("base64");
  css = css.replaceAll(`/assets/fonts/${name}.woff2`, `{{font:${name}}}`);
}

const themes: Record<string, string> = {};
for (const file of readdirSync(join(repo, "themes"))) themes[file.replace(/\.css$/, "")] = readFileSync(join(repo, "themes", file), "utf8");

const answers = JSON.parse(readFileSync(join(web, "demo/answers.json"), "utf8"));
const answersGz = gzipSync(JSON.stringify(answers), { level: 9 }).toString("base64");

// The demo's real files, embedded. The tree states each one's size: it has to be the size of the file.
const TYPES: Record<string, string> = {
  svg: "image/svg+xml", webm: "video/webm", pdf: "application/pdf", html: "text/html", zip: "application/zip",
  md: "text/markdown", json: "application/json", csv: "text/csv", txt: "text/plain",
};
const filesDir = join(web, "demo/files");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const { SHOWCASE, EXTRAS } = await import("./src/tree.js");
const sizes = new Map<string, number>([...SHOWCASE, ...EXTRAS].map(([path, size]: [string, number]) => [path, size]));
const files: Record<string, { type: string; data: string }> = {};
for (const file of walk(filesDir)) {
  const path = relative(filesDir, file);
  const bytes = readFileSync(file);
  if (sizes.get(path) !== bytes.length) throw new Error(`src/tree.js says ${path} is ${sizes.get(path)} bytes; it is ${bytes.length}`);
  files[path] = { type: TYPES[path.split(".").pop()!] ?? "text/plain", data: bytes.toString("base64") };
}

const wasm = readFileSync(wasmPath);
const wasmGz = gzipSync(wasm, { level: 9 }).toString("base64");

const data = {
  css,
  fonts,
  themes,
  files,
  frameHtml: readFileSync(join(web, "src/frame.html"), "utf8"),
  version: answers.config.version,
  wasmBytes: wasm.length,
};

// Inside a script element only "</script" and "<!--" could end it early. A host that wraps the page (a
// review tool, a proxy) may also look for "<body>" or "</head>" in the text: the embedded blocks hold no "<".
const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
const packed = (text: string) => gzipSync(text, { level: 9 }).toString("base64");
const safe = (text: string) => text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
if (/<(body|head)\b|<\/(body|head)>/i.test(landing)) throw new Error("the landing script holds a <body> or <head> tag");

let page = readFileSync(join(web, "src/landing.html"), "utf8");
for (const marker of ["<!--okfs:data-->", "{{landing-css}}"]) if (!page.includes(marker)) throw new Error(`landing.html has no ${marker}`);
// Its stylesheet, with the utilities its markup and its script use.
const landingCss = await buildCss(join(web, "src/landing.css"), ["src/landing.html", "src/landing.js"].map((file) => join(web, file)));
page = page.replace("{{landing-css}}", () => landingCss);
// The page's own two faces, latin only, written into its stylesheet: the site is one file.
const pageFonts: Record<string, string> = {
  "mona-sans": "@fontsource-variable/mona-sans/files/mona-sans-latin-wdth-normal.woff2",
  "fragment-mono": "@fontsource/fragment-mono/files/fragment-mono-latin-400-normal.woff2",
};
for (const [name, file] of Object.entries(pageFonts)) {
  const marker = `{{page-font:${name}}}`;
  if (!page.includes(marker)) throw new Error(`landing.html has no ${marker}`);
  page = page.replaceAll(marker, `data:font/woff2;base64,${readFileSync(join(web, "node_modules", file)).toString("base64")}`);
}
// The blocks the demo carries inline. The front page fetches the same ones as one JSON file, named by its hash.
const dataBlocks: [string, string, string][] = [
  ["okfs-data", "application/json", json(data)],
  ["okfs-answers", "text/plain", answersGz],
  ["okfs-wasm", "text/plain", wasmGz],
  ["okfs-worker", "text/plain", packed(worker)],
  ["okfs-pictures", "text/plain", packed(pictures)],
  ["okfs-frame-boot", "text/plain", packed(frameBoot)],
  ["okfs-frame-main", "text/plain", packed(frameMain)],
];
const blocks = [
  ...dataBlocks.map(([id, type, text]) => `<script type="${type}" id="${id}">${text}</script>`),
  `<script>${safe(landing)}</script>`,
].join("\n");
page = page.replace("<!--okfs:data-->", () => blocks);

// The front page: its script, the data file's name, and its two faces as files beside it.
if (/<(body|head)\b|<\/(body|head)>/i.test(site)) throw new Error("the site script holds a <body> or <head> tag");
const dataJson = JSON.stringify(Object.fromEntries(dataBlocks.map(([id, type, text]) => [id, { type, text }])));
const dataFile = `okfs-demo.${createHash("sha256").update(dataJson).digest("hex").slice(0, 12)}.json`;
let front = readFileSync(join(web, "src/site.html"), "utf8");
for (const marker of ["{{okfs-data}}", "<!--okfs:site-->", "{{site-css}}"]) if (!front.includes(marker)) throw new Error(`site.html has no ${marker}`);
// Its stylesheet, with the utilities its markup and its script use.
const siteCss = await buildCss(join(web, "src/site.css"), ["src/site.html", "src/site.js"].map((file) => join(web, file)));
front = front
  .replaceAll("{{okfs-data}}", `/${dataFile}`)
  .replace("{{site-css}}", () => siteCss)
  .replace("<!--okfs:site-->", () => `<script>${safe(site)}</script>`);
const siteFonts: Record<string, string> = {
  "fraunces.woff2": "@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2",
  "ibm-plex-mono-400.woff2": "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
  "ibm-plex-mono-500.woff2": "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2",
  "ibm-plex-mono-600.woff2": "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2",
};
for (const name of Object.keys(siteFonts)) if (!front.includes(`/fonts/${name}`)) throw new Error(`site.html does not use /fonts/${name}`);

mkdirSync(join(outDir, "demo"), { recursive: true });
mkdirSync(join(outDir, "fonts"), { recursive: true });
writeFileSync(join(outDir, "demo/index.html"), page);
writeFileSync(join(outDir, "index.html"), front);
writeFileSync(join(outDir, dataFile), dataJson);
for (const [name, file] of Object.entries(siteFonts)) copyFileSync(join(web, "node_modules", file), join(outDir, "fonts", name));
console.log(`built ${join(outDir, "demo/index.html")}: ${(page.length / 1e6).toFixed(2)} MB (engine ${(wasm.length / 1e3).toFixed(0)} KB)`);
console.log(`built ${join(outDir, "index.html")}: ${(front.length / 1e3).toFixed(0)} KB, with ${dataFile}: ${(dataJson.length / 1e6).toFixed(2)} MB`);
