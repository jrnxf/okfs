// Starts the demo: unpacks what the page carries, starts okfs's engine, and puts okfs's page in frames.
// A frame and this page talk by messages only (see frame-host.ts), so the demo works wherever the page is put:
// a file on disk, a server, or a sandbox that gives every frame an origin of its own.
import { createBackend } from "./backend.js";
import { drawAll } from "./pictures.js";

const b64 = (text) => {
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};
const gunzip = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const textOf = (id) => document.getElementById(id)?.textContent ?? "";
/** A script block the build packed as gzip in base64. */
const unpack = async (id) => new TextDecoder().decode(await gunzip(b64(textOf(id))));
const inline = (js) => js.replace(/<\/script/gi, "<\\/script");

/** Draws the pictures in a worker, or here when the browser has no canvas for workers. */
function drawPictures(workerJs) {
  const here = () =>
    drawAll(
      (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h }),
      (canvas, type, quality) => new Promise((resolve) => canvas.toBlob((blob) => blob.arrayBuffer().then((b) => resolve(new Uint8Array(b))), type, quality)),
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

export async function boot() {
  const t0 = performance.now();
  const data = JSON.parse(textOf("okfs-data"));
  const wasmBytes = await gunzip(b64(textOf("okfs-wasm")));
  const t1 = performance.now();
  const module = await WebAssembly.compile(wasmBytes);
  const t2 = performance.now();
  const answers = JSON.parse(new TextDecoder().decode(await gunzip(b64(textOf("okfs-answers")))));
  // Each preview form names its answer in the pool; parse it the first time it is asked for.
  const parsed = new Map();
  const preview = {};
  for (const [path, forms] of Object.entries(answers.preview)) {
    preview[path] = {};
    for (const [form, at] of Object.entries(forms)) {
      Object.defineProperty(preview[path], form, {
        enumerable: true,
        get: () => {
          if (!parsed.has(at)) parsed.set(at, JSON.parse(answers.pool[at]));
          return parsed.get(at);
        },
      });
    }
  }
  const [workerJs, picturesJs, frameBootJs, frameMainJs] = await Promise.all(
    ["okfs-worker", "okfs-pictures", "okfs-frame-boot", "okfs-frame-main"].map(unpack),
  );

  // The pictures are drawn here, in a worker when the browser can draw off its page's thread.
  const pictures = drawPictures(picturesJs);

  // What a frame needs to draw files: real files, the pictures, themes and templates.
  const bytesOf = (p) => ({ type: p.type, bytes: b64(p.data).buffer });
  const assets = pictures.then(({ pool, named }) => ({
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
  const frames = new Map();
  let nextCall = 1;
  addEventListener("message", async (event) => {
    const msg = event.data;
    if (!msg?.okfs) return;
    const entry = frames.get(event.source);
    if (!entry) return;
    const reply = (m) => event.source.postMessage({ okfs: true, ...m }, "*");
    switch (msg.t) {
      case "hello":
        reply({ t: "assets", assets: await assets });
        break;
      case "req": {
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
    deliver: (change) => {
      for (const [win] of frames) win.postMessage({ okfs: true, t: "change", change }, "*");
    },
  });

  /**
   * okfs's page in a frame inside `container`, opening at `start` (an address such as "/photos/"). Returns a
   * handle that drives it: `call(op, ...args)` runs one of frame-host.ts's `drive` operations.
   */
  function mount(container, { start = "/", title = "okfs, live", on = {} } = {}) {
    const frame = document.createElement("iframe");
    frame.title = title;
    frame.className = "okfs-frame";
    const path = decodeURIComponent(new URL(start, "http://okfs.demo").pathname).replace(/^\/|\/$/g, "");
    const node = path ? backend.lookup(path) : { isDir: true };
    const config = { ...answers.config, target: { path, kind: !node ? "missing" : node.isDir ? "dir" : "file" } };
    const json = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
    frame.srcdoc = data.frameHtml
      .replace("{{css}}", () => css)
      .replace("{{config}}", () => json(config))
      .replace("{{demo}}", () => json({ start }))
      .replace("{{boot}}", () => bootJs)
      .replace("{{main}}", () => mainJs);
    const entry = { frame, ready: false, onReady: [], calls: new Map(), on };
    container.append(frame);
    frames.set(frame.contentWindow, entry);
    const handle = {
      frame,
      on,
      whenReady: () => (entry.ready ? Promise.resolve() : new Promise((resolve) => entry.onReady.push(resolve))),
      call(op, ...args) {
        if (!entry.ready) return handle.whenReady().then(() => handle.call(op, ...args));
        const id = nextCall++;
        return new Promise((resolve) => {
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
