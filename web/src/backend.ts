// okfs's server, as far as its page can tell, inside this page. Every answer about the tree (listings,
// search, recent files, counts, left-out folders) comes from okfs's own index compiled to WebAssembly.
// What a file holds comes from answers a real okfs gave for the real tidewater files and for one file of
// each kind (see bake.mjs), and the pictures, sound and video are embedded.
import { fill, packageOf, templateOf } from "./media";
import { startEngine } from "./engine";
import { hash, makeTree, rng, type Node } from "./tree";

const ORIGIN = "http://okfs.demo";
/** A reply to a request from a frame. */
export interface Reply {
  status: number;
  body: string;
  headers: Record<string, string>;
}
/** What bake.mjs recorded: the answers a real okfs gave. */
export interface Baked {
  config: Record<string, unknown>;
  readme: Record<string, any>;
  archive: Record<string, any>;
  preview: Record<string, Record<string, any>>;
}
export interface BackendStatus {
  seen: number;
  indexed: number;
  ready: boolean;
  walkMs: number;
  inWorker: boolean;
  startedAt: number;
}
/** Something that is told of each change a write made. */
export interface ChangeSource {
  deliver(change: unknown): void;
}
interface Listing {
  path: string;
  entries: { d?: boolean; n: string }[];
  readme?: unknown;
  [key: string]: unknown;
}
const json = (body: string, status = 200): Reply => ({ status, body, headers: { "content-type": "application/json" } });
const missing = (): Reply => ({ status: 404, body: "not found", headers: {} });

type Engine = Awaited<ReturnType<typeof startEngine>>;
export type Backend = Awaited<ReturnType<typeof createBackend>>;

/** `wasm`: the engine module, compiled. `worker`: the address of the index worker's script. `baked`: what bake.mjs recorded. */
export async function createBackend({ wasm, worker: workerUrl, baked, now }: { wasm: WebAssembly.Module; worker: string; baked: Baked; now: number }) {
  const listeners = new Set<(status: BackendStatus) => void>();
  const status: BackendStatus = { seen: 0, indexed: 0, ready: false, walkMs: 0, inWorker: false, startedAt: performance.now() };
  const tell = () => listeners.forEach((fn) => fn(status));

  // Listings come from an engine on this thread over a tree of its own, which fills only where the page looks.
  const tree = makeTree(now);
  const lister = await startEngine(wasm, tree, { log: (line) => console.debug("[okfs]", line) });

  // The index walks the whole tree in a worker, so the page stays smooth while it reads 300,000 names.
  let pending = new Map<number, (reply: { text: string }) => void>();
  let nextId = 1;
  let worker: Worker | null = null;
  let local: Engine | null = null;
  let readyWaiters: (() => void)[] = [];
  const whenReady = () => (status.ready ? Promise.resolve() : new Promise<void>((resolve) => readyWaiters.push(resolve)));
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
    local = await startEngine(wasm, own, { onRead: (_dir: unknown, n: number) => (seen += n) });
    const began = performance.now();
    local.build();
    status.walkMs = performance.now() - began;
    status.seen = seen;
    status.indexed = local.len();
    localTree = own;
    becameReady();
  }
  // @ts-expect-error written and never read, as before
  let localTree: unknown = null;

  const ask = (op: "search" | "recent" | "write", arg: unknown): Promise<{ text: string }> =>
    whenReady().then(() => {
      if (local) return { text: (local[op] as (arg: unknown) => string)(arg) };
      const id = nextId++;
      return new Promise<{ text: string }>((resolve) => {
        pending.set(id, resolve);
        worker!.postMessage({ op, id, arg });
      });
    });

  // ---- previews: what a real okfs answered, for this file or one like it ----

  const has = (key: string) => Boolean(baked.preview[key]);

  /** A day of ten-minute readings for an archive file, the same every time for the same path. */
  function dayTable(path: string, source: boolean, first: boolean) {
    const r = rng(hash(path));
    const station = path.split("/")[1] ?? "";
    const offset = (hash(station) % 40) - 20;
    const phase = r() * 12.42;
    const amp = 120 + r() * 40;
    const head = ["time", "raw_cm", "height_m", "battery", "water_c"];
    const rows: string[][] = [];
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
    const line = (cells: string[]) => `<span class="ln">${cells.map((c, i) => (cls[i] ? `<span class="${cls[i]}">${c}</span>` : c)).join(",")}</span>`;
    const all = [head, ...rows];
    const shown = first ? all.slice(0, 80) : all;
    return { kind: "code", html: shown.map(line).join(""), lines: all.length, highlighted: true, ...(first ? { more: true } : {}) };
  }

  function previewOf(path: string, { source, first }: { source: boolean; first: boolean }) {
    const node = lookup(path);
    if (!node || node.isDir) return null;
    const template = templateOf(path, has) ;
    if (!template) return { kind: "none", reason: "binary" };
    if (template.day) return dayTable(path, source, first);
    const forms = baked.preview[template.key]!;
    const answer = forms[source ? (first ? "sourceFirst" : "sourceWhole") : first ? "first" : "whole"];
    if (!Object.keys(template.subs).length) return answer;
    return JSON.parse(fill(JSON.stringify(answer), template));
  }

  function lookup(path: string) {
    let node: Node | null | undefined = tree.child("tidewater");
    for (const part of path.split("/").filter(Boolean)) {
      node = node?.isDir ? node.child(part) : null;
      if (!node) return null;
    }
    return node;
  }

  function readmeOf(listing: Listing) {
    if (!listing.entries.some((e: { d?: boolean; n: string }) => !e.d && /^readme\.(md|markdown)$/i.test(e.n))) return null;
    const path = listing.path;
    if (baked.readme[path]) return baked.readme[path];
    const pkg = path.split("/").length >= 3 ? packageOf(path) : null;
    if (pkg && (path.endsWith(`/${pkg}`))) return JSON.parse(JSON.stringify(baked.readme["harbor/packages/PKGNAME"]).split("PKGNAME").join(pkg));
    return null;
  }

  const withReadme = (listing: Listing) => {
    listing.readme = readmeOf(listing);
    return listing;
  };

  // ---- the routes ----

  const events = new Set<ChangeSource>();

  async function answer(input: string): Promise<Reply> {
    const url = new URL(input, `${ORIGIN}/`);
    const q = url.searchParams;
    // A yes or no, as okfs reads one: 1 or true.
    const flag = (name: string) => (["1", "true"].includes(q.get(name) ?? "") ? 1 : undefined);
    const num = (name: string) => (q.has(name) ? Number(q.get(name)) : undefined);
    switch (url.pathname) {
      case "/api/list": {
        const listing = lister.list({ path: q.get("path") ?? "", limit: num("limit"), depth: num("depth") ?? 0, follow: q.get("follow") ?? "", all: flag("all") });
        if (!listing) return missing();
        if (q.has("limit")) listing.readme = null;
        else withReadme(listing);
        return json(JSON.stringify(listing));
      }
      case "/api/previews": {
        const out: Record<string, unknown> = {};
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

  function pageHtml(pathname: string) {
    const path = decodeURIComponent(pathname.replace(/^\/-(\/|$)/, "/")).replace(/^\/|\/$/g, "");
    const node = path ? lookup(path) : tree.child("tidewater");
    const target = { path, kind: !node ? "missing" : node.isDir ? "dir" : "file" };
    return `<script type="application/json" id="okfs-config">${JSON.stringify({ ...baked.config, target }).replace(/</g, "\\u003c")}</script>`;
  }

  // ---- the page following the folder: a file written here is read by the index and told to the page ----

  async function write(dir: string, name: string, text: string) {
    if (!lookup(dir)?.isDir) return;
    const mtime = Math.floor(Date.now() / 1000);
    const size = new TextEncoder().encode(text).length;
    lister.write({ dir, name, size, mtime });
    const { text: told } = await ask("write", { dir, name, size, mtime });
    for (const change of JSON.parse(told)) for (const source of events) source.deliver(change);
  }

  return {
    status,
    onStatus(fn: (status: BackendStatus) => void) {
      listeners.add(fn);
      fn(status);
      return () => listeners.delete(fn);
    },
    answer,
    events: {
      add: (source: ChangeSource) => events.add(source),
      delete: (source: ChangeSource) => events.delete(source),
    },
    write,
    lookup,
    search: (query: unknown) => ask("search", query).then(({ text }) => JSON.parse(text)),
  };
}

