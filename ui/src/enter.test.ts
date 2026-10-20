// Going into a folder lands on the entry its column beside the list leads on to, and the columns of that entry
// are the ones that were shown past it: whatever the sort, the pointer and the folders visited before.

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Item, Listing } from "./api";

/** A folder by its path, with its entries in name order. A name ending in `/` is a folder. */
const tree = new Map<string, string[]>();
function folder(path: string, ...names: string[]): void {
  tree.set(path, names);
}
folder("", "code/", "notes/");
folder("code", "blip/", "devbox/", "dotfiles/", "homelab/", "okfs/", "notes.md");
for (const project of ["blip", "devbox", "dotfiles", "homelab", "okfs"]) folder(`code/${project}`, "docs/", "src/", "README.md");
for (const project of ["blip", "devbox", "dotfiles", "homelab", "okfs"]) {
  folder(`code/${project}/docs`, "a.md", "b.md");
  folder(`code/${project}/src`, "lib.rs", "main.rs");
}
// More folders than a column draws rows for.
folder("notes", ...Array.from({ length: 60 }, (_, at) => `d${String(at + 1).padStart(2, "0")}/`));
for (let at = 1; at <= 60; at++) folder(`notes/d${String(at).padStart(2, "0")}`, "x.md");
/** The newest last, so that a sort by time puts it first. */
const modified = (path: string): number => (path === "code/homelab" ? 9 : 1);

const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** Lists a folder the way the server does: see `list_folder`. */
function listing(path: string, limit: number | undefined, depth: number, follow: string[]): Listing {
  const items: Item[] = (tree.get(path) ?? []).map((name) => {
    const dir = name.endsWith("/");
    const n = name.replace(/\/$/, "");
    return { n, d: dir, s: dir ? 0 : 10, m: modified(join(path, n)), c: dir ? (tree.get(join(path, n))?.length ?? 0) : undefined };
  });
  if (limit !== undefined) items.sort((a, b) => Number(Boolean(b.d)) - Number(Boolean(a.d)));
  const [followed, ...rest] = follow;
  const into = items.find((item) => item.n === followed) ?? items[0];
  const under = limit !== undefined && depth > 0 && into?.d ? listing(join(path, into.n), limit, depth - 1, rest) : undefined;
  return { path, m: 1, entries: limit === undefined ? items : items.slice(0, limit), total: items.length, readme: null, under };
}

const saved = new Map<string, string>();
/** The addresses whose answers have been read, in the order they were. */
const answered: string[] = [];
/** What the page's modules find on `globalThis` while these tests run, and what was there before. */
const page = {
  document: { getElementById: () => null, addEventListener: () => undefined, querySelector: () => null },
  localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) },
  innerWidth: 1495,
  location: { pathname: "/", search: "", href: "http://localhost/" },
  history: { state: null, pushState: () => undefined, replaceState: () => undefined },
  fetch: async (url: string) => {
    const query = new URL(url, "http://localhost").searchParams;
    const limit = query.get("limit");
    const body = listing(query.get("path") ?? "", limit ? Number(limit) : undefined, Number(query.get("depth") ?? 0), (query.get("follow") ?? "").split("/").filter(Boolean));
    return {
      ok: true,
      status: 200,
      json: async () => {
        answered.push(url);
        return body;
      },
    };
  },
};
const before = Object.fromEntries(Object.keys(page).map((key) => [key, (globalThis as Record<string, unknown>)[key]]));

let stores: typeof import("./store");
let preview: typeof import("./preview");
let slots: typeof import("./slots");
let api: typeof import("./api");
beforeAll(async () => {
  Object.assign(globalThis, page);
  api = await import("./api");
  stores = await import("./store");
  preview = await import("./preview");
  slots = await import("./slots");
});
afterAll(() => {
  Object.assign(globalThis, before);
});

type Store = import("./store").Store;

/** The names the columns beside the list lead on to, a level after another, as the side draws them. */
async function shown(store: Store): Promise<string[]> {
  const root = store.columnsRoot();
  if (root === null) return [];
  const left = (path: string) => store.leftIn(path);
  const picks = store.picked(root);
  const answer = await api.getJson<Listing>(preview.columnsUrl(root, picks, left));
  return slots.columnsOf(slots.startingAt(answer, root), slots.slots(), picks, left).led;
}

/** Waits for the folder asked for to be shown. */
const settle = () => new Promise((done) => setTimeout(done, 0));

/** A press of the right arrow, or of the left: into the folder under the cursor, or up. */
async function right(store: Store): Promise<void> {
  store.activate();
  await settle();
}
async function left(store: Store): Promise<void> {
  store.up();
  await settle();
}

/** A fresh store showing `path`, with the cursor on `name`. */
async function at(path: string, name: string): Promise<Store> {
  const store = new stores.Store();
  await store.showDir(path, { select: name });
  return store;
}

/** Goes into the folder under the cursor and checks that the cursor lands where its column led, and that the columns past it are still the ones shown. */
async function goesIn(store: Store): Promise<void> {
  const [led, ...past] = await shown(store);
  await right(store);
  expect(store.cur()?.name).toBe(led);
  expect((await shown(store)).slice(0, past.length)).toEqual(past);
}

test("going into a folder visited before lands on the entry its column shows: where the cursor was when it was left", async () => {
  const store = await at("", "code");
  expect(await shown(store)).toEqual(["blip", "docs"]);
  await goesIn(store);
  store.moveTo(1);
  expect(store.cur()?.name).toBe("devbox");
  await goesIn(store);
  await left(store);
  await left(store);
  expect(store.cur()?.name).toBe("code");
  // The column of `code` leads on to `devbox`, where the cursor was, and on into it.
  expect(await shown(store)).toEqual(["devbox", "docs"]);
  await goesIn(store);
  expect(store.cur()?.name).toBe("devbox");
});

test("with the list sorted by time, going into a folder lands on the entry its column, in name order, shows", async () => {
  const store = await at("", "code");
  store.setSort("time");
  expect(store.s.sort).toEqual({ key: "time", dir: -1 });
  await goesIn(store);
  // The newest folder is first in the list, and the cursor is on the column's first all the same.
  expect(store.s.entries[0]?.name).toBe("homelab");
  expect(store.cur()?.name).toBe("blip");
  store.setSort("name");
});

test("going into a folder lands on the entry the pointer picked in its column, and keeps what it picked past it", async () => {
  const store = await at("", "code");
  store.pick("code", ["homelab"]);
  expect(await shown(store)).toEqual(["homelab", "docs"]);
  await goesIn(store);
  expect(store.cur()?.name).toBe("homelab");

  // A pick in the second column: the first leads on to the folder it is in, and the second column is the first after the step.
  await left(store);
  store.pick("code", ["okfs", "src"]);
  expect(await shown(store)).toEqual(["okfs", "src"]);
  await goesIn(store);
  expect([store.cur()?.name, (await shown(store))[0]]).toEqual(["okfs", "src"]);
  await goesIn(store);
  expect(store.cur()?.name).toBe("src");

  // A move of the cursor drops the picks.
  store.pick(store.columnsRoot() ?? "", ["main.rs"]);
  store.move(1);
  store.move(-1);
  expect(store.picked(store.columnsRoot())).toEqual([]);
});

test("a folder left on an entry its column does not draw is gone into at its first, as the column shows", async () => {
  const store = await at("", "notes");
  await goesIn(store);
  store.moveTo(50);
  expect(store.cur()?.name).toBe("d51");
  await left(store);
  expect(await shown(store)).toEqual(["d01", "x.md"]);
  await goesIn(store);
  expect(store.cur()?.name).toBe("d01");
  // One it draws is the one gone into.
  store.moveTo(4);
  await left(store);
  expect(await shown(store)).toEqual(["d05", "x.md"]);
  await goesIn(store);
  expect(store.cur()?.name).toBe("d05");
});

test("the columns asked for ahead of the cursor are the ones the side asks for, after the folders visited", async () => {
  const store = await at("code", "blip");
  await right(store);
  store.moveTo(1);
  await left(store);
  // `blip` was left on `src`: the columns of `blip` are asked for into it, by the side and ahead of the cursor alike.
  const wasAt = (path: string) => store.leftIn(path);
  expect(preview.columnsUrl("code/blip", [], wasAt)).toContain(`&follow=src`);
  expect(preview.columnsUrl("code/devbox", [], wasAt)).not.toContain("follow");
});

test("a step out draws the folder with the columns beside it: their answer has come by then, so every pane is there to slide", async () => {
  const store = await at("code/dotfiles", "src");
  await right(store);
  expect(store.s.path).toBe("code/dotfiles/src");
  // What the side asks for once the folder is drawn, and whether its answer had come when it was.
  let asked = "";
  let had = false;
  const stop = store.subscribe(() => {
    const root = store.columnsRoot();
    if (store.s.path !== "code/dotfiles" || root === null || asked) return;
    asked = preview.columnsUrl(root, store.picked(root), (path) => store.leftIn(path));
    had = answered.includes(asked);
  });
  await left(store);
  stop();
  expect(store.cur()?.name).toBe("src");
  expect(asked).toContain("follow=lib.rs");
  expect(had).toBe(true);
});

test("a folder's remembered spot holds only while the cursor stays on it: back in at once keeps it, moved off and back starts at the top", async () => {
  const store = await at("code", "okfs");
  await right(store);
  store.moveTo(1);
  expect(store.cur()?.name).toBe("src");
  // ← then → with no move between: the same entry, and the folder's column leads on to it.
  await left(store);
  expect(store.cur()?.name).toBe("okfs");
  expect(await shown(store)).toEqual(["src", "lib.rs"]);
  await goesIn(store);
  expect(store.cur()?.name).toBe("src");

  // The cursor leaves the folder and comes back: the spot is forgotten, in the column too.
  await left(store);
  store.move(-1);
  expect(store.cur()?.name).toBe("homelab");
  store.move(1);
  expect(store.cur()?.name).toBe("okfs");
  expect(store.leftIn("code/okfs")).toBeUndefined();
  expect(await shown(store)).toEqual(["docs", "a.md"]);
  await goesIn(store);
  expect(store.cur()?.name).toBe("docs");
});

test("moving off a folder also forgets the spots in the folders inside it", async () => {
  const store = await at("code", "okfs");
  await right(store);
  store.moveTo(1);
  await right(store);
  store.moveTo(1);
  expect(store.cur()?.name).toBe("main.rs");
  await left(store);
  await left(store);
  expect(store.leftIn("code/okfs/src")).toBe("main.rs");
  store.move(1);
  store.move(-1);
  expect(store.leftIn("code/okfs")).toBeUndefined();
  expect(store.leftIn("code/okfs/src")).toBeUndefined();
});
