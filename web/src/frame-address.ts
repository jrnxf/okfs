// okfs's page reads and writes its own address. In the demo its frame has no address of its own, so the demo
// build points okfs's reads of `location` and `history` at these two (see build.ts). Both scripts of the frame
// load this; the first makes them and the second finds them.

const ORIGIN = "http://okfs.demo";
type Demo = { start: string };
const demo: Demo = JSON.parse(document.getElementById("okfs-demo")?.textContent ?? "{}");
const listeners = new Set<(url: string) => void>();

class VirtualLocation {
  private url = new URL(demo.start || "/", ORIGIN);
  get href() {
    return this.url.href;
  }
  get pathname() {
    return this.url.pathname;
  }
  get search() {
    return this.url.search;
  }
  get hash() {
    return this.url.hash;
  }
  get host() {
    return this.url.host;
  }
  get origin() {
    return ORIGIN;
  }
  set(to: string) {
    this.url = new URL(to, this.url);
    for (const listener of listeners) listener(this.url.pathname + this.url.search);
  }
  /** okfs leaves its page only to download a whole folder as a zip, which the demo has none of. */
  assign(_to: string) {}
  replace(_to: string) {}
  reload() {}
  toString() {
    return this.href;
  }
}

class VirtualHistory {
  private entries: { state: unknown; url: string }[];
  private at = 0;
  constructor(private loc: VirtualLocation) {
    this.entries = [{ state: null, url: loc.href }];
  }
  get state() {
    return this.entries[this.at]?.state ?? null;
  }
  get length() {
    return this.entries.length;
  }
  pushState(state: unknown, _title: string, url?: string | URL | null) {
    if (url != null) this.loc.set(String(url));
    this.entries.splice(this.at + 1);
    this.entries.push({ state: structuredClone(state), url: this.loc.href });
    this.at = this.entries.length - 1;
  }
  replaceState(state: unknown, _title: string, url?: string | URL | null) {
    if (url != null) this.loc.set(String(url));
    this.entries[this.at] = { state: structuredClone(state), url: this.loc.href };
  }
  go(delta = 0) {
    const to = Math.max(0, Math.min(this.entries.length - 1, this.at + delta));
    if (to === this.at) return;
    this.at = to;
    const entry = this.entries[to]!;
    this.loc.set(entry.url);
    setTimeout(() => dispatchEvent(new PopStateEvent("popstate", { state: entry.state })), 0);
  }
  back() {
    this.go(-1);
  }
  forward() {
    this.go(1);
  }
}

type Address = {
  __vloc: VirtualLocation;
  __vhist: VirtualHistory;
  __vlisten: typeof listeners;
  /** The stylesheet for a theme, once the page around the frame has handed the themes over. */
  __vtheme: ((id: string) => string) | null;
};
const w = window as unknown as Partial<Address>;
if (!w.__vloc) {
  const loc = new VirtualLocation();
  Object.assign(window, { __vloc: loc, __vhist: new VirtualHistory(loc), __vlisten: listeners, __vtheme: null });

  // okfs swaps one stylesheet link to change theme. Its address is kept as okfs wrote it, and the link loads the
  // theme held in the frame, as soon as there is one.
  const setAttribute = Element.prototype.setAttribute;
  const getAttribute = Element.prototype.getAttribute;
  const themeOf = (href: string) => (href === "/theme.css" ? "default" : (href.match(/themes\/([\w-]+)\.css$/)?.[1] ?? "default"));
  Element.prototype.setAttribute = function (name: string, value: string) {
    if (this.id === "okfs-theme" && name === "href") {
      (this as HTMLElement).dataset.href = value;
      const sheet = (window as unknown as Address).__vtheme;
      if (sheet) setAttribute.call(this, name, sheet(themeOf(value)));
      return;
    }
    setAttribute.call(this, name, value);
  };
  Element.prototype.getAttribute = function (name: string) {
    if (this.id === "okfs-theme" && name === "href") return (this as HTMLElement).dataset.href ?? null;
    return getAttribute.call(this, name);
  };
}

export const address = window as unknown as Address;
