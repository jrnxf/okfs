// Builds the site into one page, dist/index.html: okfs's page from ui/src, okfs's index from src/ compiled to
// WebAssembly (build.sh builds it first), what bake.mjs recorded from a real okfs, the demo's own files, and the
// landing page around them. Run through build.sh, which puts the tools in place.
//
//   bun run build.ts <engine.wasm> <out-dir>
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { BunPlugin } from "bun";

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

// okfs's stylesheet, as ui/build.ts makes it, with the latin fonts only (the demo folder is plain latin).
const FONTS = ["geist-latin-wght-normal", "geist-mono-latin-wght-normal", "newsreader-latin-opsz-normal", "newsreader-latin-opsz-italic"];
let css = (await Promise.all(["fonts", "tokens", "core", "app"].map((name) => Bun.file(join(ui, `src/styles/${name}.css`)).text()))).join("\n");
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
if (!page.includes("<!--okfs:data-->")) throw new Error("landing.html has no <!--okfs:data--> marker");
const blocks = [
  `<script type="application/json" id="okfs-data">${json(data)}</script>`,
  `<script type="text/plain" id="okfs-answers">${answersGz}</script>`,
  `<script type="text/plain" id="okfs-wasm">${wasmGz}</script>`,
  `<script type="text/plain" id="okfs-worker">${packed(worker)}</script>`,
  `<script type="text/plain" id="okfs-pictures">${packed(pictures)}</script>`,
  `<script type="text/plain" id="okfs-frame-boot">${packed(frameBoot)}</script>`,
  `<script type="text/plain" id="okfs-frame-main">${packed(frameMain)}</script>`,
  `<script>${safe(landing)}</script>`,
].join("\n");
page = page.replace("<!--okfs:data-->", () => blocks);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "index.html"), page);
console.log(`built ${join(outDir, "index.html")}: ${(page.length / 1e6).toFixed(2)} MB (engine ${(wasm.length / 1e3).toFixed(0)} KB)`);
