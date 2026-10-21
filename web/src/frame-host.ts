// okfs's frame and the page around it, by messages only: the frame may be another origin (a sandboxed page has
// opaque ones), so nothing is shared but what is posted. okfs talks to its server with `fetch` and `EventSource`;
// here both go to the page. What okfs puts straight into `src` (pictures, players, frames) is made here, from the
// bytes the page handed over when the frame started.
import { urls } from "../../ui/src/api";
import { sourceOf } from "./media.js";
import { address } from "./frame-address";

type Bytes = { type: string; bytes: ArrayBuffer };
type Assets = {
  files: Record<string, Bytes>;
  pool: Record<string, Bytes[]>;
  pdfFirst: Record<string, Bytes>;
  themes: Record<string, string>;
  texts: Record<string, string>;
  keys: string[];
};
type Change = { event: string; dir?: string; files?: string[] };

const page = window.parent;
const post = (message: unknown) => page.postMessage({ okfs: true, ...(message as object) }, "*");

let assets: Assets | null = null;
let resolveHost: () => void;
export const hostReady = new Promise<void>((resolve) => (resolveHost = resolve));

const waiting = new Map<number, (answer: { status: number; body: string; headers: Record<string, string> }) => void>();
let nextId = 1;
const sources = new Set<DemoEventSource>();

addEventListener("message", (event: MessageEvent) => {
  if (event.source !== page) return;
  const data = event.data;
  if (!data?.okfs) return;
  if (data.t === "assets") {
    assets = data.assets as Assets;
    const themes = assets.themes;
    address.__vtheme = (id) => blobUrl(`theme:${id}`, () => themes[id] ?? themes.default ?? "", "text/css");
    // The early script chose the theme before the stylesheets were here: load it now.
    const link = document.getElementById("okfs-theme");
    const href = link?.getAttribute("href");
    if (link && href) link.setAttribute("href", href);
    resolveHost();
  } else if (data.t === "res") {
    waiting.get(data.id)?.(data);
    waiting.delete(data.id);
  } else if (data.t === "change") {
    for (const source of sources) source.deliver(data.change as Change);
  } else if (data.t === "drive") {
    void drive(data.op, data.args ?? []).then((value) => post({ t: "done", id: data.id, value }));
  }
});
post({ t: "hello" });

// ---- the server ----

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (init?.signal?.aborted) throw new DOMException("The request was dropped", "AbortError");
  const id = nextId++;
  const answer = await new Promise<{ status: number; body: string; headers: Record<string, string> }>((resolve) => {
    waiting.set(id, resolve);
    post({ t: "req", id, url });
  });
  if (init?.signal?.aborted) throw new DOMException("The request was dropped", "AbortError");
  return new Response(answer.status === 204 ? null : answer.body, { status: answer.status, headers: answer.headers });
};

class DemoEventSource extends EventTarget {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly url: string) {
    super();
    sources.add(this);
    setTimeout(() => {
      if (this.readyState === 2) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    }, 0);
  }
  deliver(change: Change) {
    const data = change.event === "change" ? JSON.stringify({ dir: change.dir, files: change.files }) : "{}";
    this.dispatchEvent(new MessageEvent(change.event, { data }));
  }
  close() {
    this.readyState = 2;
    sources.delete(this);
  }
}
Object.assign(window, { EventSource: DemoEventSource });

// ---- the addresses okfs puts in `src` ----

const made = new Map<string, string>();
const blobUrl = (key: string, make: () => BlobPart, type: string) => {
  let url = made.get(key);
  if (!url) {
    url = URL.createObjectURL(new Blob([make()], { type }));
    made.set(key, url);
  }
  return url;
};

function rawUrl(path: string): string {
  const a = assets!;
  const has = (key: string) => a.keys.includes(key);
  const source = sourceOf(path, { files: a.files, pool: a.pool, has, texts: a.texts }) as
    | { file: string }
    | { pool: string; at: number }
    | { text: string; key: string }
    | { empty: true };
  if ("file" in source) return blobUrl(`file:${source.file}`, () => a.files[source.file]!.bytes, a.files[source.file]!.type);
  if ("pool" in source) {
    const picture = a.pool[source.pool]![source.at]!;
    return blobUrl(`pool:${source.pool}:${source.at}`, () => picture.bytes, picture.type);
  }
  if ("text" in source) return blobUrl(`text:${source.key}`, () => source.text, "text/plain");
  return blobUrl("empty", () => "", "application/octet-stream");
}

const isPdf = (path: string) => /\.pdf$/i.test(path);
// okfs adds `?v=` to some of these addresses. After a `#` it names nothing and changes nothing.
urls.raw = (path: string) => (isPdf(path) ? rawUrl(path) : `${rawUrl(path)}#`);
urls.picture = (path: string) => `${rawUrl(path)}#`;
urls.thumb = (path: string, width: number) => {
  if (!isPdf(path)) return `${rawUrl(path)}#`;
  const w = width > 640 ? "1280" : "640";
  const sheet = assets!.pdfFirst[w];
  // The demo draws no first pages (its config says so), so okfs does not ask; answer with the file if it does.
  if (!sheet) return rawUrl(path);
  return blobUrl(`pdf:${w}`, () => sheet.bytes, sheet.type);
};
urls.zip = () => "#okfs-zip";

// ---- links: an address okfs drew for itself is only ever followed in place ----

addEventListener(
  "click",
  (event) => {
    const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!link) return;
    const href = link.getAttribute("href") ?? "";
    if (href === "#okfs-zip") {
      event.preventDefault();
      post({ t: "toast", text: "Zips of folders come from okfs on your own machine." });
    } else if (!event.defaultPrevented && !link.hasAttribute("download") && (href.startsWith("/") || href.startsWith("http://okfs.demo"))) {
      event.preventDefault();
    }
  },
  true,
);

// ---- telling the page what happens here ----

address.__vlisten.add((url) => post({ t: "nav", url }));
for (const type of ["pointerdown", "wheel", "touchstart"]) addEventListener(type, () => post({ t: "touch" }), { passive: true, capture: true });
addEventListener("keydown", (event) => event.isTrusted && post({ t: "key", key: event.key, repeat: event.repeat }), true);

/** okfs's page has drawn: the page around it can drive it now. */
export function started(): void {
  post({ t: "ready", path: address.__vloc.pathname + address.__vloc.search });
}

// ---- being driven: keys, a held key, typing, and going to an address ----

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const target = (): Element => (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body);
const press = (key: string, { ctrl = false, repeat = false, type = "keydown" } = {}) =>
  target().dispatchEvent(new KeyboardEvent(type, { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ctrlKey: ctrl, repeat, bubbles: true, cancelable: true }));
const paletteOpen = () => Boolean(document.querySelector('[role="dialog"] input'));

async function drive(op: string, args: unknown[]): Promise<unknown> {
  switch (op) {
    case "key": {
      const [key, opts] = args as [string, { ctrl?: boolean }];
      press(key, opts);
      press(key, { ...opts, type: "keyup" });
      return;
    }
    case "hold": {
      const [key, ms, every] = args as [string, number, number];
      press(key);
      const end = performance.now() + ms;
      while (performance.now() < end) {
        await sleep(every);
        press(key, { repeat: true });
      }
      press(key, { type: "keyup" });
      return;
    }
    case "down":
      press(args[0] as string, { repeat: Boolean(args[1]) });
      return;
    case "up":
      press(args[0] as string, { type: "keyup" });
      return;
    case "type": {
      const [text, delay] = args as [string, number];
      for (const ch of text) {
        const input = target() as HTMLInputElement;
        if (!("value" in input)) return;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, input.value + ch);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(delay);
      }
      return;
    }
    case "go": {
      address.__vhist.pushState(null, "", args[0] as string);
      dispatchEvent(new PopStateEvent("popstate", { state: null }));
      return;
    }
    case "palette":
      if (!paletteOpen()) press("k", { ctrl: true });
      return;
    case "closeAll":
      if (paletteOpen()) press("Escape");
      return;
    case "scheme": {
      const want = args[0] as string;
      if (document.documentElement.dataset.scheme !== want) press("t");
      return;
    }
    case "selected":
      return document.querySelector("[data-i][aria-selected=true]")?.textContent?.trim() ?? "";
  }
}
