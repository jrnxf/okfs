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
  location: { pathname: "/", search: "" },
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

const host: KeyHost = { across: 1, filter: () => undefined, closeMenu: () => undefined, flipScheme: () => undefined };

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

test("with the preview closed nothing is asked about a file, under the cursor or ahead of it", () => {
  const store = showing("photo.jpg", "notes.md", "main.rs", "data.json", "inner/", "page.html", "paper.pdf", "pack.zip");
  const stamp = (entry: import("./store").Entry) => store.stamp(entry);
  expect(store.s.peek).toBe(false);
  // No file is on show, so the pane draws none: see `Side`.
  expect(store.shown()).toBeNull();
  preview.lookAhead(store.s.entries, 0, 1, stamp, false);
  // The columns of the folder ahead are still had: they hold names and no file.
  expect(asked).toEqual([preview.columnsUrl("inner")]);

  asked.length = 0;
  store.setPeek(true);
  expect(store.shown()?.name).toBe("photo.jpg");
  preview.lookAhead(store.s.entries, 0, 1, stamp, true);
  expect(asked.some((url) => url.startsWith("/api/previews?"))).toBe(true);
  expect(asked.some((url) => url.startsWith("/api/archive?"))).toBe(true);
  // Open, a folder ahead is not added up before the cursor stops on it.
  expect(asked.some((url) => url.includes("inner"))).toBe(false);
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
  expect(keys.keyFor(store, host, press("g", "input"))).toBeUndefined();
  expect(keys.keyFor(store, host, press("g", "button"))).toBeDefined();
  expect(store.s.peek).toBe(false);

  // A file at full width keeps space, and Esc closes one thing at a time.
  store.setPeek(true);
  store.activate();
  expect(keys.keyFor(store, host, press(" "))).toBeUndefined();
  store.s.open = null;
  keys.keyFor(store, host, press("Escape"))?.();
  expect(store.s.peek).toBe(false);
});

test("r flips only a file that has two forms, and only while it is on show", () => {
  const twoForms = ["page.html", "page.htm", "notes.md", "shape.svg", "table.csv", "table.tsv", "data.json"];
  const oneForm = ["main.rs", "photo.jpg", "clip.mp4", "paper.pdf", "pack.zip", "blob.bin", "notes.txt", "inner/"];
  for (const name of [...twoForms, ...oneForm]) {
    const store = showing(name, "other.md");
    // Closed, there is nothing on show to flip.
    expect(keys.keyFor(store, host, press("r"))).toBeUndefined();
    store.setPeek(true);
    const flip = keys.keyFor(store, host, press("r"));
    expect(flip !== undefined).toBe(twoForms.includes(name));
    flip?.();
    expect(store.s.raw).toBe(twoForms.includes(name) ? name : "");
    // The source is of that file: the next one is shown as what is made from it.
    store.move(1);
    expect(store.s.raw).toBe("");
  }
  const store = showing("notes.md");
  store.activate();
  keys.keyFor(store, host, press("r"))?.();
  expect(store.s.raw).toBe("notes.md");
  keys.keyFor(store, host, press("r"))?.();
  expect(store.s.raw).toBe("");
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
