// okfs's server, as far as its page can tell, inside this page. Every answer about the tree (listings,
// search, recent files, counts, left-out folders) comes from okfs's own index compiled to WebAssembly.
// What a file holds comes from answers a real okfs gave for the real tidewater files and for one file of
// each kind (see bake.mjs), and the pictures, sound and video are embedded.
import { fill, packageOf, templateOf } from "./media.js";
import { startEngine } from "./engine.js";
import { hash, makeTree, rng } from "./tree.js";

const ORIGIN = "http://okfs.demo";
const json = (body, status = 200) => ({ status, body, headers: { "content-type": "application/json" } });
const missing = () => ({ status: 404, body: "not found", headers: {} });

/** `wasm`: the engine module, compiled. `worker`: the address of the index worker's script. `baked`: what bake.mjs recorded. */
export async function createBackend({ wasm, worker: workerUrl, baked, now }) {
  const listeners = new Set();
  const status = { seen: 0, indexed: 0, ready: false, walkMs: 0, inWorker: false, startedAt: performance.now() };
  const tell = () => listeners.forEach((fn) => fn(status));

  // Listings come from an engine on this thread over a tree of its own, which fills only where the page looks.
  const tree = makeTree(now);
  const lister = await startEngine(wasm, tree, { log: (line) => console.debug("[okfs]", line) });

  // The index walks the whole tree in a worker, so the page stays smooth while it reads 300,000 names.
  let pending = new Map();
  let nextId = 1;
  let worker = null;
  let local = null;
  let readyWaiters = [];
  const whenReady = () => (status.ready ? Promise.resolve() : new Promise((resolve) => readyWaiters.push(resolve)));
  const becameReady = () => {
    status.ready = true;
    tell();
    readyWaiters.forEach((resolve) => resolve());
    readyWaiters = [];
  };
  try {
    worker = new Worker(workerUrl);
    status.inWorker = true;
    worker.onmessage = ({ data }) => {
      if (data.op === "progress") {
        status.seen = data.seen;
        tell();
      } else if (data.op === "ready") {
        status.indexed = data.len;
        status.seen = data.seen;
        status.walkMs = data.ms;
        becameReady();
      } else if (data.id) {
        pending.get(data.id)?.(data);
        pending.delete(data.id);
      }
    };
    worker.onerror = (event) => {
      console.warn("okfs demo: the index worker failed, indexing on the page instead", event.message);
      worker = null;
      status.inWorker = false;
      void indexHere();
    };
    worker.postMessage({ op: "start", module: wasm, now });
  } catch (error) {
    console.warn("okfs demo: no worker here, indexing on the page instead", error);
    worker = null;
    setTimeout(() => void indexHere(), 50);
  }

  async function indexHere() {
    const own = makeTree(now);
    let seen = 0;
    local = await startEngine(wasm, own, { onRead: (_dir, n) => (seen += n) });
    const began = performance.now();
    local.build();
    status.walkMs = performance.now() - began;
    status.seen = seen;
    status.indexed = local.len();
    localTree = own;
    becameReady();
  }
  let localTree = null;

  const ask = (op, arg) =>
    whenReady().then(() => {
      if (local) return { text: local[op](arg) };
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        worker.postMessage({ op, id, arg });
      });
    });

  // ---- previews: what a real okfs answered, for this file or one like it ----

  const has = (key) => Boolean(baked.preview[key]);

  /** A day of ten-minute readings for an archive file, the same every time for the same path. */
  function dayTable(path, source, first) {
    const r = rng(hash(path));
    const station = path.split("/")[1] ?? "";
    const offset = (hash(station) % 40) - 20;
    const phase = r() * 12.42;
    const amp = 120 + r() * 40;
    const head = ["time", "raw_cm", "height_m", "battery", "water_c"];
    const rows = [];
    for (let i = 0; i < 144; i++) {
      const h = i / 6;
      const raw = 190 + offset + amp * Math.sin(((h - phase) / 12.42) * 2 * Math.PI) + (r() - 0.5) * 4;
      rows.push([
        `${String(Math.floor(h)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}`,
        raw.toFixed(1),
        ((raw - 12) / 100).toFixed(3),
        (0.83 - i * 0.0003).toFixed(3),
        (13.2 + 0.6 * Math.sin(((h - 9) / 24) * 2 * Math.PI)).toFixed(1),
      ]);
    }
    if (!source) return { kind: "table", head, rows, numeric: [false, true, true, true, true], total: 144 };
    const cls = ["", "tk-t", "tk-n", "", "tk-s"];
    const line = (cells) => `<span class="ln">${cells.map((c, i) => (cls[i] ? `<span class="${cls[i]}">${c}</span>` : c)).join(",")}</span>`;
    const all = [head, ...rows];
    const shown = first ? all.slice(0, 80) : all;
    return { kind: "code", html: shown.map(line).join(""), lines: all.length, highlighted: true, ...(first ? { more: true } : {}) };
  }

  function previewOf(path, { source, first }) {
    const node = lookup(path);
    if (!node || node.isDir) return null;
    const template = templateOf(path, has);
    if (!template) return { kind: "none", reason: "binary" };
    if (template.day) return dayTable(path, source, first);
    const forms = baked.preview[template.key];
    const answer = forms[source ? (first ? "sourceFirst" : "sourceWhole") : first ? "first" : "whole"];
    if (!Object.keys(template.subs).length) return answer;
    return JSON.parse(fill(JSON.stringify(answer), template));
  }

  function lookup(path) {
    let node = tree.child("tidewater");
    for (const part of path.split("/").filter(Boolean)) {
      node = node?.isDir ? node.child(part) : null;
      if (!node) return null;
    }
    return node;
  }

  function readmeOf(listing) {
    if (!listing.entries.some((e) => !e.d && /^readme\.(md|markdown)$/i.test(e.n))) return null;
    const path = listing.path;
    if (baked.readme[path]) return baked.readme[path];
    const pkg = path.split("/").length >= 3 ? packageOf(path) : null;
    if (pkg && (path.endsWith(`/${pkg}`))) return JSON.parse(JSON.stringify(baked.readme["harbor/packages/PKGNAME"]).split("PKGNAME").join(pkg));
    return null;
  }

  const withReadme = (listing) => {
    listing.readme = readmeOf(listing);
    return listing;
  };

  // ---- the routes ----

  const events = new Set();

  async function answer(input) {
    const url = new URL(input, `${ORIGIN}/`);
    const q = url.searchParams;
    // A yes or no, as okfs reads one: 1 or true.
    const flag = (name) => (["1", "true"].includes(q.get(name) ?? "") ? 1 : undefined);
    const num = (name) => (q.has(name) ? Number(q.get(name)) : undefined);
    switch (url.pathname) {
      case "/api/list": {
        const listing = lister.list({ path: q.get("path") ?? "", limit: num("limit"), depth: num("depth") ?? 0, follow: q.get("follow") ?? "", all: flag("all") });
        if (!listing) return missing();
        if (q.has("limit")) listing.readme = null;
        else withReadme(listing);
        return json(JSON.stringify(listing));
      }
      case "/api/previews": {
        const out = {};
        for (const path of q.getAll("p")) {
          const found = previewOf(path, { source: Boolean(flag("raw")), first: q.has("lines") });
          if (found) out[path] = found;
        }
        return json(JSON.stringify(out));
      }
      case "/api/search": {
        const query = { q: q.get("q") ?? "", limit: num("limit"), offset: num("offset"), sort: q.get("sort") ?? "rank", rev: flag("rev"), all: flag("all") };
        const { text } = await ask("search", query);
        return json(text);
      }
      case "/api/recent": {
        const { text } = await ask("recent", Boolean(flag("all")));
        return json(text);
      }
      case "/api/archive": {
        const found = baked.archive[q.get("path") ?? ""] ?? baked.archive["survey-2026.zip"];
        return json(JSON.stringify(found));
      }
      case "/api/picture":
        return { status: 200, body: "", headers: {} };
      default:
        return { status: 200, body: pageHtml(url.pathname), headers: { "content-type": "text/html" } };
    }
  }

  function pageHtml(pathname) {
    const path = decodeURIComponent(pathname.replace(/^\/-(\/|$)/, "/")).replace(/^\/|\/$/g, "");
    const node = path ? lookup(path) : tree.child("tidewater");
    const target = { path, kind: !node ? "missing" : node.isDir ? "dir" : "file" };
    return `<script type="application/json" id="okfs-config">${JSON.stringify({ ...baked.config, target }).replace(/</g, "\\u003c")}</script>`;
  }

  // ---- the page following the folder: a file written here is read by the index and told to the page ----

  async function write(dir, name, text) {
    if (!lookup(dir)?.isDir) return;
    const mtime = Math.floor(Date.now() / 1000);
    const size = new TextEncoder().encode(text).length;
    lister.write({ dir, name, size, mtime });
    const { text: told } = await ask("write", { dir, name, size, mtime });
    for (const change of JSON.parse(told)) for (const source of events) source.deliver(change);
  }

  return {
    status,
    onStatus(fn) {
      listeners.add(fn);
      fn(status);
      return () => listeners.delete(fn);
    },
    answer,
    events: {
      add: (source) => events.add(source),
      delete: (source) => events.delete(source),
    },
    write,
    lookup,
    search: (query) => ask("search", query).then(({ text }) => JSON.parse(text)),
  };
}

