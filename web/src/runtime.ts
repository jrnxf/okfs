// Starts the demo: unpacks what the page carries, starts okfs's engine, and puts okfs's page in frames.
// A frame and this page talk by messages only (see frame-host.ts), so the demo works wherever the page is put:
// a file on disk, a server, or a sandbox that gives every frame an origin of its own.
import { createBackend, type Backend } from "./backend";
import { drawAll, type Drawn } from "./pictures";

interface Pictures {
  pool: Record<string, Drawn[]>;
  named: Record<string, Drawn>;
}
/** The files a frame is handed to draw: type and raw bytes. */
interface Blob_ {
  type: string;
  bytes: ArrayBufferLike;
}
/** What the build packed into the page. */
interface PageData {
  version: string;
  wasmBytes: number;
  css: string;
  fonts: Record<string, string>;
  frameHtml: string;
  themes: unknown;
  files: Record<string, { type: string; data: string }>;
}

/** Each frame's state: what to tell when it says something, and the replies it owes. */
interface FrameEntry {
  frame: HTMLIFrameElement;
  ready: boolean;
  onReady: (() => void)[];
  calls: Map<number, (value: any) => void>;
  on: Record<string, (msg: any) => void>;
}

/** A mounted frame: drive it with `call`. */
export interface Mounted {
  frame: HTMLIFrameElement;
  on: Record<string, (msg: any) => void>;
  whenReady(): Promise<void>;
  call(op: string, ...args: unknown[]): Promise<any>;
  remove(): void;
}
export interface MountOptions {
  start?: string;
  title?: string;
  on?: Record<string, (msg: any) => void>;
  class?: string;
}
/** The demo `boot` returns. */
export interface Demo {
  backend: Backend;
  mount(container: Element, options?: MountOptions): Mounted;
  stats: {
    version: string;
    wasmBytes: number;
    unpackMs: number;
    compileMs: number;
    startMs: number;
  };
}

const b64 = (text: string) => {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};
const gunzip = async (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const textOf = (id: string) => document.getElementById(id)?.textContent ?? "";
/** A script block the build packed as gzip in base64. */
const unpack = async (id: string) => new TextDecoder().decode(await gunzip(b64(textOf(id))));
const inline = (js: string) => js.replace(/<\/script/gi, "<\\/script");

/** Draws the pictures in a worker, or here when the browser has no canvas for workers. */
function drawPictures(workerJs: string): Promise<Pictures> {
  const here = () =>
    drawAll(
      (w: number, h: number) => Object.assign(document.createElement("canvas"), { width: w, height: h }),
      (canvas: HTMLCanvasElement, type: string, quality?: number) =>
        new Promise<Uint8Array>((resolve) => canvas.toBlob((blob) => blob!.arrayBuffer().then((b) => resolve(new Uint8Array(b))), type, quality)),
    );
  if (typeof OffscreenCanvas === "undefined" || typeof Worker === "undefined") return here();
  return new Promise((resolve) => {
    try {
      const worker = new Worker(URL.createObjectURL(new Blob([workerJs], { type: "text/javascript" })));
      worker.onmessage = ({ data }) => {
        resolve(data);
        worker.terminate();
      };
      worker.onerror = () => resolve(here());
      worker.postMessage("draw");
    } catch {
      resolve(here());
    }
  });
}

export async function boot(): Promise<Demo> {
  const t0 = performance.now();
  const data: PageData = JSON.parse(textOf("okfs-data"));
  const wasmBytes = await gunzip(b64(textOf("okfs-wasm")));
  const t1 = performance.now();
  const module = await WebAssembly.compile(wasmBytes);
  const t2 = performance.now();
  const answers: any = JSON.parse(new TextDecoder().decode(await gunzip(b64(textOf("okfs-answers")))));
  // Each preview form names its answer in the pool; parse it the first time it is asked for.
  const parsed = new Map<string, unknown>();
  const preview: Record<string, Record<string, unknown>> = {};
  for (const [path, forms] of Object.entries(answers.preview) as [string, Record<string, string>][]) {
    preview[path] = {};
    for (const [form, at] of Object.entries(forms)) {
      Object.defineProperty(preview[path]!, form, {
        enumerable: true,
        get: () => {
          if (!parsed.has(at)) parsed.set(at, JSON.parse(answers.pool[at]));
          return parsed.get(at);
        },
      });
    }
  }
  const [workerJs, picturesJs, frameBootJs, frameMainJs] = (await Promise.all(
    ["okfs-worker", "okfs-pictures", "okfs-frame-boot", "okfs-frame-main"].map(unpack),
  )) as [string, string, string, string];

  // The pictures are drawn here, in a worker when the browser can draw off its page's thread.
  const pictures = drawPictures(picturesJs);

  // What a frame needs to draw files: real files, the pictures, themes and templates.
  const bytesOf = (p: { type: string; data: string }): Blob_ => ({ type: p.type, bytes: b64(p.data).buffer });
  const assets = pictures.then(({ pool, named }: Pictures) => ({
    files: {
      ...Object.fromEntries(Object.entries(data.files).map(([path, p]) => [path, bytesOf(p)])),
      ...Object.fromEntries(Object.entries(named).map(([path, p]) => [path, { type: p.type, bytes: p.bytes.buffer }])),
    },
    pool: Object.fromEntries(Object.entries(pool).map(([group, list]) => [group, list.map((p) => ({ type: p.type, bytes: p.bytes.buffer }))])),
    pdfFirst: {},
    themes: data.themes,
    texts: answers.texts,
    keys: Object.keys(answers.preview),
  }));

  const workerUrl = URL.createObjectURL(new Blob([workerJs], { type: "text/javascript" }));
  const backend = await createBackend({
    wasm: module,
    worker: workerUrl,
    baked: { config: answers.config, readme: answers.readme, archive: answers.archive, preview },
    now: Math.floor(Date.now() / 1000),
  });
  const t3 = performance.now();

  // okfs's stylesheet, with its fonts written in: a frame may not load an address this page made.
  let css = data.css;
  for (const [name, font] of Object.entries(data.fonts)) css = css.replaceAll(`{{font:${name}}}`, `data:font/woff2;base64,${font}`);
  const bootJs = inline(frameBootJs);
  const mainJs = inline(frameMainJs);

  /** Each frame, by its window: what to tell when it says something, and the replies it owes. */
  const frames = new Map<MessageEventSource | null, FrameEntry>();
  let nextCall = 1;
  addEventListener("message", async (event: MessageEvent) => {
    const msg = event.data;
    if (!msg?.okfs) return;
    const entry = frames.get(event.source);
    if (!entry) return;
    const reply = (m: Record<string, unknown>) => (event.source as Window).postMessage({ okfs: true, ...m }, "*");
    switch (msg.t) {
      case "hello":
        reply({ t: "assets", assets: await assets });
        break;
      case "req": {
        entry.on.req?.(msg);
        const answer = await backend.answer(msg.url);
        reply({ t: "res", id: msg.id, ...answer });
        break;
      }
      case "done":
        entry.calls.get(msg.id)?.(msg.value);
        entry.calls.delete(msg.id);
        break;
      case "ready":
        entry.ready = true;
        entry.onReady.forEach((fn) => fn());
        entry.onReady = [];
        entry.on.nav?.(msg.path);
        break;
      default:
        entry.on[msg.t]?.(msg);
    }
  });
  backend.events.add({
    deliver: (change: unknown) => {
      for (const [win] of frames) (win as Window).postMessage({ okfs: true, t: "change", change }, "*");
    },
  });

  /**
   * okfs's page in a frame inside `container`, opening at `start` (an address such as "/photos/"). Returns a
   * handle that drives it: `call(op, ...args)` runs one of frame-host.ts's `drive` operations. `class` is the
   * frame's look, as the page around it wants it.
   */
  function mount(container: Element, { start = "/", title = "okfs, live", on = {}, class: look = "" }: MountOptions = {}): Mounted {
    const frame = document.createElement("iframe");
    frame.title = title;
    frame.className = look ? `okfs-frame ${look}` : "okfs-frame";
    const path = decodeURIComponent(new URL(start, "http://okfs.demo").pathname).replace(/^\/|\/$/g, "");
    const node = path ? backend.lookup(path) : { isDir: true };
    const config = { ...answers.config, target: { path, kind: !node ? "missing" : node.isDir ? "dir" : "file" } };
    const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
    frame.srcdoc = data.frameHtml
      .replace("{{css}}", () => css)
      .replace("{{config}}", () => json(config))
      .replace("{{demo}}", () => json({ start }))
      .replace("{{boot}}", () => bootJs)
      .replace("{{main}}", () => mainJs);
    const entry: FrameEntry = { frame, ready: false, onReady: [], calls: new Map(), on };
    container.append(frame);
    frames.set(frame.contentWindow, entry);
    const handle: Mounted = {
      frame,
      on,
      whenReady: () => (entry.ready ? Promise.resolve() : new Promise<void>((resolve) => entry.onReady.push(resolve))),
      call(op: string, ...args: unknown[]): Promise<any> {
        if (!entry.ready) return handle.whenReady().then(() => handle.call(op, ...args));
        const id = nextCall++;
        return new Promise<any>((resolve) => {
          entry.calls.set(id, resolve);
          frame.contentWindow?.postMessage({ okfs: true, t: "drive", id, op, args }, "*");
        });
      },
      remove() {
        frames.delete(frame.contentWindow);
        frame.remove();
      },
    };
    return handle;
  }

  return {
    backend,
    mount,
    stats: {
      version: data.version,
      wasmBytes: data.wasmBytes,
      unpackMs: t1 - t0,
      compileMs: t2 - t1,
      startMs: t3 - t2,
    },
  };
}
