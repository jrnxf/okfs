// The okfs in the page: boots it once, mounts frames of it in containers, and tells the page's parts what it says.
import { boot, type Demo, type Mounted } from "../runtime";
import { onScheme, scheme } from "./scheme";
import { createState, fmt } from "./store";
import { toast } from "./notice";

declare global {
  interface Window {
    __demo?: unknown;
  }
}

/** What the page shows of okfs's numbers and of its start. Begins as the page was built. */
export const ui = createState({
  bootText: "Starting okfs",
  bootSub: "in this tab, from this page alone",
  count: "0",
  walk: "-",
  search: "-",
  fCount: "302,523",
  fMs: "~20 ms",
  version: "0.1.0",
});
/** The demo, once it is up. */
export const session = createState<{ demo: Demo | null }>({ demo: null });

/** Presses, holds and types into okfs's page in a frame, the way a person would, by messages to it. */
interface Handle {
  call(op: string, ...args: unknown[]): Promise<any>;
}
function driver(handle: Handle) {
  return {
    key: (key: string, opts: Record<string, unknown> = {}) => handle.call("key", key, opts),
    hold: (key: string, ms: number, every = 50) => handle.call("hold", key, ms, every),
    down: (key: string, repeat: boolean) => handle.call("down", key, repeat),
    up: (key: string) => handle.call("up", key),
    type: (text: string, delay = 90) => handle.call("type", text, delay),
    /** Goes to an address in okfs's page, as the browser's back and forward do. */
    go: (url: string) => handle.call("go", url),
    palette: () => handle.call("palette"),
    closeAll: () => handle.call("closeAll"),
    scheme: (value: string) => handle.call("scheme", value),
  };
}
export type Driver = ReturnType<typeof driver>;

export const prettyPath = (url: string) => {
  const u = new URL(url, "http://okfs.demo");
  const find = u.searchParams.get("find");
  return decodeURIComponent(u.pathname) + (find !== null ? `?find=${find}` : "");
};

export interface Msg {
  url: string;
  key: string;
  repeat?: boolean;
  scheme: string;
  text: string;
}
interface MountOpts {
  onPath?: (path: string) => void;
  title?: string;
  onKey?: (key: string, m: Msg) => unknown;
  onNav?: (path: string) => void;
  onReq?: (url: string) => void;
  onScheme?: (value: string) => unknown;
}
export interface Entry {
  handle: Mounted;
  drive: Driver;
  path: () => string;
}
const frames = new Map<Element, Entry>();

/** Mounts okfs in a container, opening at `start` with the page's scheme. A second mount replaces the first. */
export function mountIn(demo: Demo, container: HTMLElement, start: string, { onPath, title, onKey, onNav, onReq, onScheme }: MountOpts = {}): Entry {
  const old = frames.get(container);
  const sep = start.includes("?") ? "&" : "?";
  const at = start.includes("scheme=") ? start : `${start}${sep}scheme=${scheme()}`;
  let path = prettyPath(at);
  const handle = demo.mount(container, {
    start: at,
    title: title ?? "okfs, running in this page",
    class: "absolute inset-0 block size-full border-0 opacity-0 transition-opacity duration-400 ease-page [&.on]:opacity-100",
    on: {
      nav: (m: string | Msg) => {
        path = prettyPath(typeof m === "string" ? m : m.url);
        onPath?.(path);
        onNav?.(path);
      },
      key: (m: Msg) => !m.repeat && onKey?.(m.key, m),
      req: (m: Msg) => onReq?.(m.url),
      scheme: (m: Msg) => onScheme?.(m.scheme),
      toast: (m: Msg) => toast(m.text),
    },
  });
  void handle.whenReady().then(() => {
    requestAnimationFrame(() => handle.frame.classList.add("on"));
    if (old) setTimeout(() => old.handle.remove(), 400);
  });
  onPath?.(path);
  const entry = { handle, drive: driver(handle), path: () => path };
  frames.set(container, entry);
  return entry;
}

/** The first screen's okfs, for the parts of the page that send it somewhere. */
export const hero: { entry?: Entry } = {};

let started: Promise<Demo> | undefined;
/** Boots okfs once. */
export function startDemo() {
  return (started ??= (async () => {
    ui.set({ bootText: "Unpacking okfs's engine" });
    const demo = await boot();
    window.__demo = demo;
    const { backend } = demo;
    ui.set({ version: demo.stats.version });

    // Each frame follows the page's scheme: okfs's own `t` flips it.
    onScheme((next, from) => {
      for (const { handle, drive } of frames.values()) if (handle !== from) void drive.scheme(next);
    });

    // The numbers in the status line.
    backend.onStatus((s: { ready: boolean; indexed: number; seen: number; walkMs: number }) => {
      const n = s.ready ? s.indexed : s.seen;
      ui.set({ count: fmt(n) });
      if (!s.ready) ui.set({ bootText: "Walking the folder", bootSub: `${fmt(s.seen)} entries so far` });
      if (s.ready) ui.set({ walk: `${(s.walkMs / 1000).toFixed(2)} s`, fCount: fmt(s.indexed) });
    });
    // Every search okfs's page makes is a search in the engine: show its time.
    const answer = backend.answer;
    backend.answer = async (url) => {
      const out = await answer(url);
      if (url.startsWith("/api/search") && out.status === 200) {
        try {
          const q = new URL(url, "http://okfs.demo").searchParams.get("q") ?? "";
          if (q.trim()) ui.set({ search: `${JSON.parse(out.body).took.toFixed(1)} ms` });
        } catch {}
      }
      return out;
    };
    session.set({ demo });
    return demo;
  })());
}
