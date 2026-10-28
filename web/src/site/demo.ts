import { boot, type Demo, type Mounted } from "../runtime";
import { getScheme, onScheme } from "./scheme";

/** The demo's data, from the file the build names in the page: the same blocks the demo page carries inline. */
async function start(): Promise<Demo> {
  const blocks: Record<string, { type: string; text: string }> = await (await fetch(document.documentElement.dataset.okfsData!)).json();
  for (const [id, { type, text }] of Object.entries(blocks)) {
    const el = document.createElement("script");
    el.type = type;
    el.id = id;
    el.textContent = text;
    document.head.append(el);
  }
  return boot();
}

let demo: Promise<Demo> | undefined;
/** okfs's runtime, started the first time it is asked for. */
export const loadDemo = () => (demo ??= start());

function driver(handle: Mounted) {
  return {
    key: (key: string, opts = {}) => handle.call("key", key, opts),
    go: (url: string) => handle.call("go", url),
    scheme: (value: string) => handle.call("scheme", value),
  };
}

/** okfs's frames fade in once okfs is ready in them: see `mountIn`. */
const FADE = "border-0 opacity-0 transition-opacity duration-350 ease-[ease] [&.on]:opacity-100";

/**
 * okfs in `container` at `at`, in the page's scheme. A second mount replaces the first once it is ready. The frame
 * follows the page's scheme until `stop` is called.
 */
export async function mountIn(container: Element, at: string, title: string, look: string, follows = true) {
  const { mount } = await loadDemo();
  const old = container.querySelector("iframe.okfs-frame");
  const sep = at.includes("?") ? "&" : "?";
  const handle = mount(container, { start: `${at}${sep}scheme=${getScheme()}`, title, class: `${look} ${FADE}` });
  const drive = driver(handle);
  const stop = follows ? onScheme((next) => void drive.scheme(next)) : () => {};
  void handle.whenReady().then(() => {
    requestAnimationFrame(() => handle.frame.classList.add("on"));
    if (old) setTimeout(() => old.remove(), 400);
  });
  return { handle, drive, stop };
}
