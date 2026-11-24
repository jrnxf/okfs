// What is asked of the server ahead of the cursor, which presses the list takes, which files have a source to flip
// to, the choices that are no longer kept, and the key that shows hidden entries.

import { beforeAll, beforeEach, expect, test } from "bun:test";
import type { KeyHost, Press } from "./keys";

// The page's modules read these as they load, so they are stood in for first and the modules loaded after.
const saved = new Map<string, string>();
/** Every address asked for, by `fetch` or as a picture. */
const asked: string[] = [];
Object.assign(globalThis, {
  document: { getElementById: () => null, addEventListener: () => undefined, querySelector: () => null, querySelectorAll: () => [] },
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

/** The store `showing` made last: the page's flip goes to it, as the page's goes to the one store. */
let latest: { flipCode(): void } | null = null;
let focusMode = false;

const host: KeyHost = {
  filter: () => undefined,
  closeMenu: () => undefined,
  flipScheme: () => undefined,
  page: () => 4,
  menu: () => undefined,
  copyPath: () => undefined,
  flip: () => latest?.flipCode(),
  focusMode: () => focusMode,
  setFocusMode: (on) => {
    focusMode = on;
  },
};

/** A store showing a folder that holds `names`, in that order, with the cursor on the first. A name ending in `/` is a folder. */
function showing(...names: string[]) {
  const store = new stores.Store();
  const entries = names.map((name, rank) => stores.toEntry({ n: name.replace(/\/$/, ""), d: name.endsWith("/"), s: 10, m: 1 }, "", rank));
  Object.assign(store.s, { status: "ready", all: entries, entries, cursor: 0 });
  latest = store;
  focusMode = false;
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
  const source = (entry: import("./store").Entry) => store.isCode(entry);
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

test("every file with code opens as what is made from it, and the flip holds for its kind", () => {
  const store = showing("a.md", "b.md", "page.html", "shape.svg", "t.csv", "d.json", "main.rs");
  const [a, b, page, shape, csv, json, rs] = store.s.entries;
  // Code has no second form, and the rest open as a page, a picture, a table or a tree.
  for (const file of [a, b, page, shape, csv, json, rs]) expect(store.isCode(file!)).toBe(false);

  // What is made from them is the form asked for ahead. A drawing is a picture, asked for as one.
  asked.length = 0;
  preview.forgetAnswers();
  preview.lookAhead(store.s.entries, 0, 1, (entry) => store.stamp(entry), null, (entry) => store.isCode(entry));
  expect(asked).toContain("/api/previews?lines=80&p=b.md&p=t.csv&p=d.json&p=main.rs");
  expect(asked.some((url) => url.includes("raw=1"))).toBe(false);

  // The flip is the page's: Markdown goes to its code, and the Markdown that follows with it.
  keys.keyFor(store, host, press("r"))?.();
  expect(store.isCode(a!)).toBe(true);
  expect(store.isCode(b!)).toBe(true);
  // Another kind is left as it was.
  expect(store.isCode(page!)).toBe(false);
  keys.keyFor(store, host, press("r"))?.();
  expect(store.isCode(a!)).toBe(false);

  // A table flips to its code, and JSON is left as its tree.
  store.moveTo(4);
  keys.keyFor(store, host, press("r"))?.();
  expect(store.isCode(csv!)).toBe(true);
  expect(store.isCode(json!)).toBe(false);
  // A drawing flips to its code too.
  store.moveTo(3);
  keys.keyFor(store, host, press("r"))?.();
  expect(store.isCode(shape!)).toBe(true);
});

test("space selects the row and steps down on the list, and is left alone where it types or presses", () => {
  const store = showing("notes.md", "inner/", "z.txt");
  keys.keyFor(store, host, press(" "))?.();
  expect([...store.s.picked.sel]).toEqual(["notes.md"]);
  expect(store.s.cursor).toBe(1);
  keys.keyFor(store, host, press(" "))?.();
  expect([...store.s.picked.sel].sort()).toEqual(["inner", "notes.md"]);
  // Escape lets the selection go before it does anything else.
  keys.keyFor(store, host, press("Escape"))?.();
  expect(store.s.picked.sel.size).toBe(0);

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

test("the dot key says so when the folder has nothing hidden to show, and what would show a dotfile", async () => {
  const { config } = await import("./config");
  const store = showing("notes.md");
  keys.keyFor(store, host, press("."))?.();
  expect(store.s.notice).toBe("Nothing hidden here. Dotfiles need okfs --hidden");
  // Hiding them again says nothing, and neither does a folder with hidden entries to show.
  store.s.notice = null;
  keys.keyFor(store, host, press("."))?.();
  expect(store.s.notice).toBeNull();
  store.s.unlisted = 2;
  keys.keyFor(store, host, press("."))?.();
  expect(store.s.notice).toBeNull();
  // With `--hidden` dotfiles are sent, so the flag is not named.
  store.setHidden(false);
  store.s.unlisted = 0;
  config.hidden = true;
  try {
    keys.keyFor(store, host, press("."))?.();
    expect(store.s.notice as string | null).toBe("Nothing hidden in this folder");
  } finally {
    config.hidden = false;
    store.setHidden(false);
  }
});

test("r flips only a file that has two forms", () => {
  const twoForms = ["page.html", "page.htm", "notes.md", "shape.svg", "table.csv", "table.tsv", "data.json"];
  const oneForm = ["main.rs", "photo.jpg", "clip.mp4", "paper.pdf", "pack.zip", "blob.bin", "notes.txt", "inner/"];
  for (const name of [...twoForms, ...oneForm]) {
    const store = showing(name, "other.md");
    const flip = keys.keyFor(store, host, press("r"));
    expect(flip !== undefined).toBe(twoForms.includes(name));
    flip?.();
    expect(store.s.asCode.length).toBe(twoForms.includes(name) ? 1 : 0);
  }
});

test("each file with code opens as what is made from it, and r always goes to its code first", () => {
  for (const name of ["page.html", "page.htm", "table.csv", "notes.md", "notes.markdown", "shape.svg", "data.json"]) {
    const store = showing(name, "other.md");
    const file = store.s.entries.find((entry) => entry.name === name)!;
    expect(store.isCode(file)).toBe(false);
    keys.keyFor(store, host, press("r"))?.();
    expect(store.isCode(file)).toBe(true);
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

  // An open file takes them to scroll a page of itself, and its cursor stays.
  store.activate();
  expect(store.s.open?.name).toBe("file-7.txt");
  const before = store.s.cursor;
  keys.keyFor(store, host, press("PageDown"))?.();
  keys.keyFor(store, host, press("PageUp"))?.();
  expect(keys.keyFor(store, host, press("PageDown"))).toBeDefined();
  expect(keys.keyFor(store, host, press(" "))).toBeDefined();
  expect(store.s.cursor).toBe(before);
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

test("u and n add to the folder on screen only while adding is on, and never over the matches or an open file", async () => {
  const { config } = await import("./config");
  const store = showing("a.txt", "sub/");
  const press = (key: string): Press => ({ key, shift: false, chord: false, typing: false, pressing: false });
  expect(keys.keyFor(store, host, press("n"))).toBeUndefined();
  expect(keys.keyFor(store, host, press("u"))).toBeUndefined();
  config.upload = true;
  try {
    keys.keyFor(store, host, press("n"))?.();
    expect(store.s.naming).toEqual({ kind: "file", dir: "" });
    store.setNaming(null);
    expect(keys.keyFor(store, host, press("u"))).toBeDefined();
    store.s.finding = true;
    expect(keys.keyFor(store, host, press("n"))).toBeUndefined();
    store.s.finding = false;
    store.s.open = store.s.entries[0] ?? null;
    expect(keys.keyFor(store, host, press("u"))).toBeUndefined();
  } finally {
    config.upload = false;
  }
});

test("the editor opens on a text file only while editing is on, and leaving unsaved changes asks first", async () => {
  const { config } = await import("./config");
  const store = showing("notes.md", "photo.jpg", "sub/");
  const [notes, photo, sub] = store.s.entries;
  const press = (key: string): Press => ({ key, shift: false, chord: false, typing: false, pressing: false });
  expect(store.editable(notes ?? null)).toBe(false);
  config.edit = true;
  try {
    expect([notes, photo, sub].map((entry) => store.editable(entry ?? null))).toEqual([true, false, false]);
    keys.keyFor(store, host, press("e"))?.();
    expect(store.s.editing?.path).toBe("notes.md");
    expect(store.s.open?.path).toBe("notes.md");
    // While a file is edited the list's keys do nothing, except Esc, which leaves.
    expect(keys.keyFor(store, host, press("j"))).toBeUndefined();

    let unsaved = true;
    const stop = store.watchUnsaved(() => unsaved);
    let left = false;
    store.leave(() => {
      left = true;
    });
    expect(left).toBe(false);
    expect(store.s.leaving).not.toBeNull();
    store.leaveAnyway(false);
    expect([left, store.s.editing?.path]).toEqual([false, "notes.md"]);
    store.leave(() => {
      left = true;
    });
    store.leaveAnyway(true);
    expect([left, store.s.editing]).toEqual([true, null]);

    // With nothing unsaved it leaves at once.
    store.edit(notes ?? null);
    unsaved = false;
    keys.keyFor(store, host, press("Escape"))?.();
    expect(store.s.editing).toBeNull();
    expect(store.s.leaving).toBeNull();
    stop();
  } finally {
    config.edit = false;
  }
});

test("nothing moves off a file with unsaved changes without asking, and a file deleted on disk stays in the editor", async () => {
  const { config } = await import("./config");
  const store = showing("notes.md", "other.md");
  const [notes] = store.s.entries;
  Object.assign(config, { edit: true, upload: true, delete: true });
  const fetching = globalThis.fetch;
  const stop = store.watchUnsaved(() => true);
  try {
    store.edit(notes ?? null);
    // A new file or folder leads away from the edited file: the question comes first, and the dialog after it.
    store.setNaming("file");
    expect([store.s.naming, store.s.editing?.path]).toEqual([null, "notes.md"]);
    expect(store.s.leaving).not.toBeNull();
    store.leaveAnyway(false);
    store.askDelete(notes ?? null);
    expect([store.s.doomed, store.s.editing?.path]).toEqual([null, "notes.md"]);
    store.leaveAnyway(true);
    expect([store.s.doomed?.path, store.s.editing, store.s.open?.path]).toEqual(["notes.md", null, "notes.md"]);
    store.cancelDelete();

    // The folder is read again without the edited file: the editor keeps it, and is told it changed.
    store.edit(notes ?? null);
    const stamp = notes ? store.stamp(notes) : "";
    const listing = { path: "", m: 1, entries: [{ n: "other.md", d: false, s: 10, m: 1 }], total: 1 };
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify(listing)))) as unknown as typeof fetch;
    store.changed("", []);
    for (let i = 0; i < 10 && store.s.caught === 0; i++) await new Promise((done) => setTimeout(done, 0));
    expect(store.s.caught).toBe(1);
    expect([store.s.open?.path, store.s.editing?.path]).toEqual(["notes.md", "notes.md"]);
    expect(notes && store.stamp(notes)).not.toBe(stamp);

    // Leaving the editor then closes the file that is gone, and its folder is shown again.
    store.leave(() => undefined);
    store.leaveAnyway(true);
    expect([store.s.open, store.s.editing]).toEqual([null, null]);
  } finally {
    stop();
    globalThis.fetch = fetching;
    Object.assign(config, { edit: false, upload: false, delete: false });
  }
});

/** A press with Shift held. */
function shifted(key: string): Press {
  return keys.pressOf({ key, shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, target: { closest: () => null } as unknown as EventTarget });
}

test("Shift and the arrows select from the anchor and shrink back toward it", () => {
  const store = showing("a.txt", "b.txt", "c.txt", "d.txt");
  store.moveTo(1);
  keys.keyFor(store, host, shifted("ArrowDown"))?.();
  keys.keyFor(store, host, shifted("ArrowDown"))?.();
  expect([...store.s.picked.sel].sort()).toEqual(["b.txt", "c.txt", "d.txt"]);
  keys.keyFor(store, host, shifted("ArrowUp"))?.();
  expect([...store.s.picked.sel].sort()).toEqual(["b.txt", "c.txt"]);
  expect(store.s.cursor).toBe(2);
});

test("a, the menu key and Shift F10 open the menu, and the changing keys need their flags", () => {
  const store = showing("notes.md", "inner/");
  let opened = 0;
  const counting = { ...host, menu: () => void opened++ };
  keys.keyFor(store, counting, press("a"))?.();
  keys.keyFor(store, counting, press("ContextMenu"))?.();
  keys.keyFor(store, counting, shifted("F10"))?.();
  expect(opened).toBe(3);
  // This page has no write flags on: renaming, moving and copying are not keys.
  for (const key of ["F2", "R", "m", "c", "N"]) expect(keys.keyFor(store, host, press(key))).toBeUndefined();
});

test("Delete and Cmd Backspace ask to delete as Shift D does, and Backspace alone still goes up", async () => {
  const { config } = await import("./config");
  const store = showing("a.txt", "b.txt");
  const cmd = (key: string, ...matching: string[]): Press => {
    const closest = (selector: string) => (selector.split(", ").some((one) => matching.includes(one)) ? {} : null);
    return keys.pressOf({ key, shiftKey: false, ctrlKey: false, metaKey: true, altKey: false, target: { closest } as unknown as EventTarget });
  };
  const trash = config.trash;
  Object.assign(config, { delete: true, trash: undefined });
  try {
    for (const each of [shifted("D"), press("Delete"), cmd("Backspace")]) {
      keys.keyFor(store, host, each)?.();
      expect(store.s.doomed?.path).toBe("a.txt");
      store.cancelDelete();
    }
    // Backspace alone is the way up, and Cmd Backspace in a text field is the field's.
    expect(keys.keyFor(store, host, press("Backspace"))).toBeDefined();
    expect(keys.keyFor(store, host, cmd("Backspace", "input"))).toBeUndefined();
    expect(store.s.doomed).toBeNull();
  } finally {
    Object.assign(config, { delete: false, trash });
  }
});

test("f shows only the open file, and Esc brings okfs back before it closes the file", () => {
  const store = showing("notes.md", "other.md");
  // On the list there is no file to focus on.
  expect(keys.keyFor(store, host, press("f"))).toBeUndefined();
  store.s.open = store.s.entries[0] ?? null;
  keys.keyFor(store, host, press("f"))?.();
  expect(focusMode).toBe(true);
  keys.keyFor(store, host, press("Escape"))?.();
  expect(focusMode).toBe(false);
  expect(store.s.open?.name).toBe("notes.md");
  keys.keyFor(store, host, press("f"))?.();
  keys.keyFor(store, host, press("f"))?.();
  expect(focusMode).toBe(false);
});

test("a folder okfs may not write in changes nothing, says why, and keeps no page's controls", async () => {
  const { config } = await import("./config");
  const { saveControls } = await import("./saves");
  Object.assign(config, { edit: true, upload: true, delete: true });
  const store = showing("notes.md", "sub/");
  const [notes] = store.s.entries;
  try {
    store.s.locked = true;
    store.askDelete(notes ?? null);
    store.startRename(notes ?? null);
    store.startPicking("move", notes ? [notes] : []);
    await store.newHere("file");
    if (notes) await store.duplicate(notes);
    expect([store.s.doomed, store.s.renaming, store.s.picking, store.s.naming]).toEqual([null, null, null, null]);
    expect(store.s.notice).toBe(stores.LOCKED);
    expect(store.editable(notes ?? null)).toBe(false);
    // A copy goes elsewhere, so it is still offered.
    store.startPicking("copy", notes ? [notes] : []);
    expect(store.s.picking?.mode).toBe("copy");

    // The page on screen is told once that its controls are not kept, and nothing is read or written.
    Object.assign(stores.store.s, { status: "ready", path: "", locked: true });
    saveControls("page.html", [{ id: "a", checked: true }]);
    saveControls("page.html", [{ id: "a", checked: false }]);
    await new Promise((done) => setTimeout(done, 450));
    expect(stores.store.s.notice).toBe(`Not saved: ${stores.CANNOT_WRITE}`);
    expect(asked.filter((url) => url.includes("page.html"))).toEqual([]);

    // A folder okfs may write in changes as before.
    store.s.picking = null;
    store.s.locked = false;
    expect(store.editable(notes ?? null)).toBe(true);
    store.startRename(notes ?? null);
    expect(store.s.renaming?.path).toBe("notes.md");
  } finally {
    Object.assign(stores.store.s, { locked: false });
    Object.assign(config, { edit: false, upload: false, delete: false });
  }
});
