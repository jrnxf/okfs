// Records what a real okfs answers about the demo's files, for the page to replay: the page's config, the
// previews of the tidewater files and of one template per kind in each form, the folders' readmes and the zip
// listing. Run it again when okfs changes how it draws a preview, and commit demo/answers.json.
//
//   node web/bake.mjs path/to/okfs        # a release build: cargo build --release, then target/release/okfs
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const okfs = process.argv[2];
if (!okfs) {
  console.error("usage: node web/bake.mjs path/to/okfs");
  process.exit(2);
}
const here = new URL(".", import.meta.url).pathname;
const port = Number(process.env.PORT ?? 18790);
const base = `http://127.0.0.1:${port}`;

// The served folder: the tidewater files, the templates in _tpl/, and the readmes where their folders are.
const work = mkdtempSync(join(tmpdir(), "okfs-bake-"));
const top = join(work, "tidewater");
cpSync(join(here, "demo/files"), top, { recursive: true });
mkdirSync(join(top, "_tpl"));
const templates = join(here, "demo/templates");
for (const name of readdirSync(templates)) {
  const readme = name.match(/^readme-(\w+)\.md$/);
  if (!readme) {
    cpSync(join(templates, name), join(top, "_tpl", name));
    continue;
  }
  const dir = readme[1] === "package" ? "harbor/packages/PKGNAME" : readme[1];
  mkdirSync(join(top, dir), { recursive: true });
  cpSync(join(templates, name), join(top, dir, "README.md"));
}

const server = spawn(okfs, [top, "--port", String(port), "--no-open"], { stdio: ["ignore", "ignore", "inherit"] });
const stop = () => {
  server.kill();
  rmSync(work, { recursive: true, force: true });
};
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/`)).ok) break;
    } catch {}
    if (i > 100) throw new Error("okfs did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const get = async (url) => {
    const res = await fetch(base + url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res;
  };
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const at = join(dir, name);
      return statSync(at).isDirectory() ? walk(at) : [relative(top, at)];
    });
  const text = (path) => /\.(md|json|csv|txt|log|rs|py|toml|ts|tsx|js|css|sh|nix|lock|svg|html)$|LICENSE$/.test(path);

  const page = await (await get("/")).text();
  const config = JSON.parse(page.match(/<script type="application\/json" id="okfs-config">([\s\S]*?)<\/script>/)[1]);

  // Each distinct answer is kept once, in `pool`; a file's four forms name theirs by place.
  const pool = [];
  const seen = new Map();
  const keep = (value) => {
    const json = JSON.stringify(value);
    if (!seen.has(json)) {
      seen.set(json, pool.length);
      pool.push(json);
    }
    return seen.get(json);
  };
  const preview = {};
  const texts = {};
  for (const path of walk(top).filter(text).sort()) {
    const q = encodeURIComponent(path);
    preview[path] = {
      first: keep(await (await get(`/api/preview?path=${q}&lines=80`)).json()),
      whole: keep(await (await get(`/api/preview?path=${q}`)).json()),
      sourceFirst: keep(await (await get(`/api/preview?path=${q}&raw=1&lines=80`)).json()),
      sourceWhole: keep(await (await get(`/api/preview?path=${q}&raw=1`)).json()),
    };
    texts[path] = readFileSync(join(top, path), "utf8");
  }
  const readme = {};
  for (const dir of ["", "archive", "maps", "recordings", "scans", "harbor", "harbor/packages/PKGNAME"]) {
    readme[dir] = (await (await get(`/api/list?path=${encodeURIComponent(dir)}`)).json()).readme;
  }
  const archive = { "survey-2026.zip": await (await get("/api/archive?path=survey-2026.zip")).json() };
  // The page draws no first page of a PDF: say so, as an okfs built without that engine does.
  config.pdf = false;
  writeFileSync(join(here, "demo/answers.json"), `${JSON.stringify({ config, readme, archive, preview, pool, texts }, null, 1)}\n`);
  console.log(`baked ${Object.keys(preview).length} files, ${pool.length} distinct answers, okfs ${config.version}`);
} finally {
  stop();
}
