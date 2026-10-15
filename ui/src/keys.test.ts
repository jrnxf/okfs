// The preview that space opens: what is asked of the server while it is closed, which presses the list
// takes, which files have a source to flip to, and the choice that is no longer kept.

import { beforeAll, beforeEach, expect, test } from "bun:test";
import type { KeyHost, Press } from "./keys";

// The page's modules read these as they load, so they are stood in for first and the modules loaded after.
const saved = new Map<string, string>();
/** Every address asked for, by `fetch` or as a picture. */
const asked: string[] = [];
Object.assign(globalThis, {
  document: { getElementById: () => null, addEventListener: () => undefined, querySelector: () => null },
  localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) },
  innerWidth: 1495,
  location: { pathname: "/", search: "", href: "http://localhost/" },
  history: { state: null, pushState: () => undefined, replaceState: () => undefined },
  fetch: (url: string) => {
    asked.push(url);
    return new Promise(() => undefined);
  },
  Image: class {
    set src(url: string) {
      asked.push(url);
    }
    addEventListener(): void {}
  },
});

let keys: typeof import("./keys");
let stores: typeof import("./store");
let preview: typeof import("./preview");
beforeAll(async () => {
  keys = await import("./keys");
  stores = await import("./store");
  preview = await import("./preview");
});
beforeEach(() => {
  saved.clear();
  asked.length = 0;
});

const host: KeyHost = { filter: () => undefined, closeMenu: () => undefined, flipScheme: () => undefined };

/** A store showing a folder that holds `names`, in that order, with the cursor on the first. A name ending in `/` is a folder. */
function showing(...names: string[]) {
  const store = new stores.Store();
  const entries = names.map((name, rank) => stores.toEntry({ n: name.replace(/\/$/, ""), d: name.endsWith("/"), s: 10, m: 1 }, "", rank));
  Object.assign(store.s, { status: "ready", all: entries, entries, cursor: 0 });
  return store;
}

/** A press of `key` with the focus on an element that matches the selectors `matching` names. */
function press(key: string, ...matching: string[]): Press {
  const closest = (selector: string) => (selector.split(", ").some((one) => matching.includes(one)) ? {} : null);
  return keys.pressOf({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: { closest } as unknown as EventTarget });
}

test("a file under the cursor is shown, and asked for ahead, with the preview closed or open", () => {
  const store = showing("photo.jpg", "notes.md", "main.rs", "data.json", "inner/", "page.html", "paper.pdf", "pack.zip");
  const stamp = (entry: import("./store").Entry) => store.stamp(entry);
  const source = (entry: import("./store").Entry) => store.isRaw(entry);
  expect(store.s.peek).toBe(false);
  expect(store.shown()?.name).toBe("photo.jpg");
  preview.lookAhead(store.s.entries, 0, 1, stamp, true, source);
  // Closed, the columns of the folder ahead are had as well.
  expect(asked.some((url) => url === preview.columnsUrl("inner"))).toBe(true);
  expect(asked.some((url) => url.startsWith("/api/previews?"))).toBe(true);
  expect(asked.some((url) => url.startsWith("/api/archive?"))).toBe(true);

  asked.length = 0;
  preview.forgetAnswers();
  store.setPeek(true);
  expect(store.shown()?.name).toBe("photo.jpg");
  preview.lookAhead(store.s.entries, 0, 1, stamp, false, source);
  expect(asked.some((url) => url.startsWith("/api/previews?"))).toBe(true);
  // Open, a folder ahead is not added up before the cursor stops on it.
  expect(asked.some((url) => url.includes("inner"))).toBe(false);
});

test("a page, Markdown and a drawing open as their source, and the flip holds for their kind", () => {
  const store = showing("a.md", "b.md", "page.html", "shape.svg", "t.csv", "d.json", "main.rs");
  const [a, b, page, shape, csv, json, rs] = store.s.entries;
  for (const file of [a, b, page, shape]) expect(store.isRaw(file!)).toBe(true);
  // A table and JSON open as what is made from them, and code has no second form.
  for (const file of [csv, json, rs]) expect(store.isRaw(file!)).toBe(false);

  // The source is the form asked for ahead, and the flip is the page's: its request is the rendered one.
  asked.length = 0;
  preview.forgetAnswers();
  preview.lookAhead(store.s.entries, 0, 1, (entry) => store.stamp(entry), false, (entry) => store.isRaw(entry));
  expect(asked.some((url) => url.startsWith("/api/previews?") && url.includes("raw=1"))).toBe(true);

  keys.keyFor(store, host, press("r"))?.();
  expect(store.isRaw(a!)).toBe(false);
  expect(store.isRaw(b!)).toBe(false);
  // Another kind is left as it was.
  expect(store.isRaw(page!)).toBe(true);
  keys.keyFor(store, host, press("r"))?.();
  expect(store.isRaw(a!)).toBe(true);

  // A table flips to its source, and holds it for the tables that follow.
  store.moveTo(4);
  keys.keyFor(store, host, press("r"))?.();
  expect(store.isRaw(csv!)).toBe(true);
  expect(store.isRaw(json!)).toBe(false);
});

test("space opens and closes the preview, and is left alone where it types or presses", () => {
  const store = showing("notes.md");
  keys.keyFor(store, host, press(" "))?.();
  expect(store.s.peek).toBe(true);
  keys.keyFor(store, host, press(" "))?.();
  expect(store.s.peek).toBe(false);

  // In the filter, the palette or any text box it is a space; on a button or a player it presses that.
  for (const focused of ["input", "textarea", "select", "[contenteditable]", "button", "summary", "video", "audio", "a[href]"]) {
    expect(keys.keyFor(store, host, press(" ", focused))).toBeUndefined();
  }
  // Letters are typed too, and are the list's again on a button.
  expect(keys.keyFor(store, host, press("s", "input"))).toBeUndefined();
  expect(keys.keyFor(store, host, press("s", "button"))).toBeDefined();
  expect(store.s.peek).toBe(false);

  // A file at full width keeps space, and Esc closes one thing at a time.
  store.setPeek(true);
  store.activate();
  expect(keys.keyFor(store, host, press(" "))).toBeUndefined();
  store.s.open = null;
  keys.keyFor(store, host, press("Escape"))?.();
  expect(store.s.peek).toBe(false);
});

test("r flips only a file that has two forms", () => {
  const twoForms = ["page.html", "page.htm", "notes.md", "shape.svg", "table.csv", "table.tsv", "data.json"];
  const oneForm = ["main.rs", "photo.jpg", "clip.mp4", "paper.pdf", "pack.zip", "blob.bin", "notes.txt", "inner/"];
  for (const name of [...twoForms, ...oneForm]) {
    const store = showing(name, "other.md");
    const flip = keys.keyFor(store, host, press("r"));
    expect(flip !== undefined).toBe(twoForms.includes(name));
    flip?.();
    expect(store.s.flipped.length).toBe(twoForms.includes(name) ? 1 : 0);
  }
});

test("the grid key is gone", () => {
  expect(keys.keyFor(showing("notes.md"), host, press("g"))).toBeUndefined();
});

test("the choice the one-folder view kept is ignored, and its key does nothing", () => {
  for (const kept of ["off", "on", "nonsense"]) {
    saved.set("okfs.pane", kept);
    const store = showing("notes.md");
    // Every visit starts with the list and the columns, and the preview closed.
    expect(store.s.peek).toBe(false);
    expect(keys.keyFor(store, host, press("p"))).toBeUndefined();
    keys.keyFor(store, host, press(" "))?.();
    expect(store.s.peek).toBe(true);
    // Nothing is written back, and opening the preview is not kept either.
    expect([...saved]).toEqual([["okfs.pane", kept]]);
    expect(showing("notes.md").s.peek).toBe(false);
  }
});
