// What is asked of the server ahead of the cursor, which presses the list takes, which files have a source to flip
// to, the choices that are no longer kept, and the key that shows hidden entries.

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
let api: typeof import("./api");
beforeAll(async () => {
  api = await import("./api");
  keys = await import("./keys");
  stores = await import("./store");
  preview = await import("./preview");
});
beforeEach(() => {
  saved.clear();
  asked.length = 0;
});

const host: KeyHost = { filter: () => undefined, closeMenu: () => undefined, flipScheme: () => undefined, page: () => 4 };

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

test("a file under the cursor is shown, and asked for ahead, with the columns of a folder ahead", () => {
  const store = showing("photo.jpg", "notes.md", "main.rs", "data.json", "inner/", "page.html", "paper.pdf", "pack.zip");
  const stamp = (entry: import("./store").Entry) => store.stamp(entry);
  const source = (entry: import("./store").Entry) => store.isRaw(entry);
  expect(store.shown()?.name).toBe("photo.jpg");
  preview.lookAhead(store.s.entries, 0, 1, stamp, (path) => store.leftIn(path), source);
  expect(asked.some((url) => url === preview.columnsUrl("inner"))).toBe(true);
  expect(asked.some((url) => url.startsWith("/api/previews?"))).toBe(true);
  expect(asked.some((url) => url.startsWith("/api/archive?"))).toBe(true);

  // With a file at full width, no column is shown, and none is asked for.
  asked.length = 0;
  preview.forgetAnswers();
  preview.lookAhead(store.s.entries, 0, 1, stamp, null, source);
  expect(asked.some((url) => url.startsWith("/api/previews?"))).toBe(true);
  expect(asked.some((url) => url.includes("inner"))).toBe(false);
});

test("Markdown, a drawing and JSON open as their source, and the flip holds for their kind", () => {
  const store = showing("a.md", "b.md", "page.html", "shape.svg", "t.csv", "d.json", "main.rs");
  const [a, b, page, shape, csv, json, rs] = store.s.entries;
  for (const file of [a, b, shape, json]) expect(store.isRaw(file!)).toBe(true);
  // A page and a table open as what is made from them, and code has no second form.
  for (const file of [page, csv, rs]) expect(store.isRaw(file!)).toBe(false);

  // The source is the form asked for ahead, and the flip is the page's: its request is the rendered one.
  asked.length = 0;
  preview.forgetAnswers();
  preview.lookAhead(store.s.entries, 0, 1, (entry) => store.stamp(entry), null, (entry) => store.isRaw(entry));
  expect(asked.some((url) => url.startsWith("/api/previews?") && url.includes("raw=1"))).toBe(true);

  keys.keyFor(store, host, press("r"))?.();
  expect(store.isRaw(a!)).toBe(false);
  expect(store.isRaw(b!)).toBe(false);
  // Another kind is left as it was.
  expect(store.isRaw(page!)).toBe(false);
  keys.keyFor(store, host, press("r"))?.();
  expect(store.isRaw(a!)).toBe(true);

  // A table flips to its source, and holds it for the tables that follow.
  store.moveTo(4);
  keys.keyFor(store, host, press("r"))?.();
  expect(store.isRaw(csv!)).toBe(true);
  expect(store.isRaw(json!)).toBe(true);
  // JSON flips to its tree.
  store.moveTo(5);
  keys.keyFor(store, host, press("r"))?.();
  expect(store.isRaw(json!)).toBe(false);
});

test("space does nothing on the list, and is left alone where it types or presses", () => {
  const store = showing("notes.md", "inner/");
  expect(keys.keyFor(store, host, press(" "))).toBeUndefined();
  store.moveTo(1);
  expect(keys.keyFor(store, host, press(" "))).toBeUndefined();

  // In the filter, the palette or any text box it is a space; on a button or a player it presses that.
  for (const focused of ["input", "textarea", "select", "[contenteditable]", "button", "summary", "video", "audio", "a[href]"]) {
    expect(keys.keyFor(store, host, press(" ", focused))).toBeUndefined();
  }
  // Letters are typed too, and are the list's again on a button.
  expect(keys.keyFor(store, host, press("s", "input"))).toBeUndefined();
  expect(keys.keyFor(store, host, press("s", "button"))).toBeDefined();

  // Esc closes one thing at a time: the file at full width, then the filter.
  store.moveTo(0);
  store.activate();
  store.setFilter("no");
  keys.keyFor(store, host, press("Escape"))?.();
  expect(store.s.open).toBeNull();
  expect(store.s.filter).toBe("no");
  keys.keyFor(store, host, press("Escape"))?.();
  expect(store.s.filter).toBe("");
});

test("the dot key shows hidden entries and hides them again, remembered, and the lists asked for say so", () => {
  const store = showing("notes.md");
  expect(store.s.hidden).toBe(false);
  expect(api.urls.list("inner")).toBe("/api/list?path=inner");
  keys.keyFor(store, host, press("."))?.();
  expect(store.s.hidden).toBe(true);
  expect(saved.get("okfs.hidden")).toBe("1");
  expect(api.urls.list("inner")).toBe("/api/list?path=inner&all=1");
  expect(preview.columnsUrl("inner", ["src"])).toContain("&follow=src&all=1");
  keys.keyFor(store, host, press("."))?.();
  expect(store.s.hidden).toBe(false);
  expect(saved.get("okfs.hidden")).toBe("0");
  expect(preview.columnsUrl("inner")).not.toContain("all=1");
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

test("a page opens rendered, Markdown, a drawing and JSON open as their source, and r flips each", () => {
  const opens = { "page.html": false, "page.htm": false, "table.csv": false, "notes.md": true, "shape.svg": true, "data.json": true };
  for (const [name, raw] of Object.entries(opens)) {
    const store = showing(name, "other.md");
    const file = store.s.entries.find((entry) => entry.name === name)!;
    expect(store.isRaw(file)).toBe(raw);
    keys.keyFor(store, host, press("r"))?.();
    expect(store.isRaw(file)).toBe(!raw);
  }
});

test("the grid key is gone", () => {
  expect(keys.keyFor(showing("notes.md"), host, press("g"))).toBeUndefined();
});

test("the choice the one-folder view kept is ignored, and its key does nothing", () => {
  for (const kept of ["off", "on", "nonsense"]) {
    saved.set("okfs.pane", kept);
    const store = showing("notes.md");
    expect(keys.keyFor(store, host, press("p"))).toBeUndefined();
    // Nothing is written back.
    expect([...saved]).toEqual([["okfs.pane", kept]]);
  }
});

test("page down and page up move a page of rows in a folder, and stop at its ends", () => {
  const store = showing(...Array.from({ length: 10 }, (_, i) => `file-${i}.txt`));
  keys.keyFor(store, host, press("PageDown"))?.();
  expect(store.s.cursor).toBe(4);
  keys.keyFor(store, host, press("PageDown"))?.();
  keys.keyFor(store, host, press("PageDown"))?.();
  expect(store.s.cursor).toBe(9);
  keys.keyFor(store, host, press("PageUp"))?.();
  expect(store.s.cursor).toBe(5);
  keys.keyFor(store, host, press("PageUp"))?.();
  keys.keyFor(store, host, press("PageUp"))?.();
  expect(store.s.cursor).toBe(0);
  // A page is what the list has on screen: a taller list moves further.
  keys.keyFor(store, { ...host, page: () => 7 }, press("PageDown"))?.();
  expect(store.s.cursor).toBe(7);

  // An open file keeps them, to scroll a page of itself.
  store.activate();
  expect(store.s.open?.name).toBe("file-7.txt");
  expect(keys.keyFor(store, host, press("PageDown"))).toBeUndefined();
  expect(keys.keyFor(store, host, press("PageUp"))).toBeUndefined();
});

test("page down and page up move a page of rows over the matches too", () => {
  const store = showing("notes.md");
  const list = Array.from({ length: 10 }, (_, i) => {
    const hit = { path: `deep/file-${i}.txt`, dir: false, idx: [], name: true, m: 1, s: 10 };
    return { entry: stores.matchEntry(hit, i), hit };
  });
  store.s.matches = { q: "file", list, total: list.length, took: 1, sort: { key: "rank", rev: false }, cursor: 0, ready: true };
  store.s.finding = true;
  keys.keyFor(store, host, press("PageDown"))?.();
  expect(store.s.matches.cursor).toBe(4);
  keys.keyFor(store, host, press("PageUp"))?.();
  expect(store.s.matches.cursor).toBe(0);
});

test("y copies the page's own address for what is under the cursor, in a folder and over the matches", async () => {
  const store = showing("inner/", "notes.md");
  const copied: (string | undefined)[] = [];
  store.copyLink = async (entry = store.s.open ?? store.cur()) => void copied.push(entry?.path);
  keys.keyFor(store, host, press("y"))?.();
  store.moveTo(1);
  keys.keyFor(store, host, press("y"))?.();
  expect(copied).toEqual(["inner", "notes.md"]);

  // A file's address, a folder's with its slash, and one behind `/-/` where its name is the server's own.
  expect(store.linkTo({ path: "notes.md", dir: false })).toBe("http://localhost/notes.md");
  expect(store.linkTo({ path: "inner", dir: true })).toBe("http://localhost/inner/");
  expect(store.linkTo({ path: "api/a b.txt", dir: false })).toBe("http://localhost/-/api/a%20b.txt");
  // With the key okfs asks for, which whoever is sent the link does not hold in a cookie.
  const { config } = await import("./config");
  config.key = "Zm9vYmFy-_";
  expect(store.linkTo({ path: "notes.md", dir: false })).toBe("http://localhost/notes.md?key=Zm9vYmFy-_");
  expect(store.linkTo({ path: "inner", dir: true })).toBe("http://localhost/inner/?key=Zm9vYmFy-_");
  delete config.key;

  store.s.matches = { q: "x", list: [], total: 0, took: 1, sort: { key: "rank", rev: false }, cursor: 0, ready: true };
  store.s.finding = true;
  expect(keys.keyFor(store, host, press("y"))).toBeDefined();
});
