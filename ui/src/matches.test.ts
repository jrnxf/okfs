// Every match of a search, listed in place of a folder: at an address of their own that back, forward and a reload
// follow, a page at a time, and always a way back to them from a folder or a file opened from them.

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Found, Hit, Item, Listing } from "./api";

/** A folder by its path, with its entries in name order. A name ending in `/` is a folder. */
const tree = new Map<string, string[]>([
  ["", ["backups/", "code/"]],
  ["backups", ["repos/"]],
  ["backups/repos", ["2026-01/", "2026-02/"]],
  ["backups/repos/2026-01", ["okfs.tar.zst"]],
  ["backups/repos/2026-02", ["okfs.tar.zst"]],
  ["code", ["okfs/", "notes.md"]],
  ["code/okfs", ["src/", "README.md"]],
  ["code/okfs/src", ["main.rs", "repo.rs"]],
]);
const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

function listing(path: string): Listing {
  const entries: Item[] = (tree.get(path) ?? []).map((name) => {
    const n = name.replace(/\/$/, "");
    return { n, d: name.endsWith("/"), s: 10, m: 1, c: tree.get(join(path, n))?.length };
  });
  return { path, m: 1, entries, total: entries.length, readme: null };
}

/** Every match of `repo`, best first: two that are in the tree, and more than a page of others. */
const MATCHES: Hit[] = [
  { path: "backups/repos", dir: true, idx: [0, 1, 2, 3], name: true, m: 0, s: 0, c: 2 },
  { path: "code/okfs/src/repo.rs", dir: false, idx: [0, 1, 2, 3], name: true, m: 5, s: 64 },
  ...Array.from({ length: 448 }, (_, at): Hit => ({ path: `pad/repo-${String(at).padStart(3, "0")}.txt`, dir: false, idx: [0, 1, 2, 3], name: true, m: 1, s: 1 })),
];

/** Every address asked for. */
const asked: string[] = [];

function search(url: URL): Found {
  const query = url.searchParams;
  const offset = Number(query.get("offset") ?? 0);
  const limit = Number(query.get("limit") ?? 60);
  const hits = query.get("q") === "repo" ? MATCHES : [];
  return { hits: hits.slice(offset, offset + limit), total: hits.length, indexed: 1000, ready: true, took: 0.4 };
}

/** The browser's history, as the page sees it: the address, the state, and back and forward. */
const stack: { url: string; state: unknown }[] = [{ url: "/code/", state: null }];
let place = 0;
const popped: (() => void)[] = [];
const local = (url: string): string => {
  const at = new URL(url, "http://localhost");
  return at.pathname + at.search;
};
function arrive(): void {
  const { url, state } = stack[place] ?? { url: "/", state: null };
  const at = new URL(url, "http://localhost");
  Object.assign(page.location, { pathname: at.pathname, search: at.search, href: at.href });
  page.history.state = state;
}
const page = {
  document: { getElementById: () => null, addEventListener: () => undefined, querySelector: () => null },
  localStorage: { getItem: () => null, setItem: () => undefined },
  innerWidth: 1495,
  location: { pathname: "/code/", search: "", href: "http://localhost/code/" },
  addEventListener: (type: string, listener: () => void) => type === "popstate" && popped.push(listener),
  history: {
    state: null as unknown,
    pushState(state: unknown, _: string, url: string) {
      stack.splice(place + 1);
      stack.push({ url: local(url), state });
      place++;
      arrive();
    },
    replaceState(state: unknown, _: string, url?: string) {
      stack[place] = { url: url === undefined ? (stack[place]?.url ?? "/") : local(url), state };
      arrive();
    },
    go(delta: number) {
      place = Math.max(0, Math.min(stack.length - 1, place + delta));
      arrive();
      setTimeout(() => popped.forEach((listener) => listener()), 0);
    },
    back() {
      this.go(-1);
    },
  },
  fetch: async (url: string) => {
    asked.push(url);
    const at = new URL(url, "http://localhost");
    const body = at.pathname === "/api/search" ? search(at) : listing(at.searchParams.get("path") ?? "");
    return { ok: true, status: 200, json: async () => body };
  },
};
const before = Object.fromEntries(Object.keys(page).map((key) => [key, (globalThis as Record<string, unknown>)[key]]));

let stores: typeof import("./store");
let keys: typeof import("./keys");
let config: typeof import("./config").config;
/** What the server told the page before this file, put back after it: every test file runs in the one page. */
let told: Partial<typeof config> = {};
beforeAll(async () => {
  Object.assign(globalThis, page);
  ({ config } = await import("./config"));
  told = { ...config };
  Object.assign(config, { root: "files", title: "okfs", themes: [], target: { path: "code", kind: "dir" }, delete: false, header: null });
  stores = await import("./store");
  keys = await import("./keys");
});
afterAll(() => {
  Object.assign(globalThis, before);
  for (const key of Object.keys(config)) delete config[key as keyof typeof config];
  Object.assign(config, told);
});

type Store = import("./store").Store;

/** Lets every answer asked for land, and what back or forward set off run. */
const settle = async () => {
  for (let at = 0; at < 6; at++) await new Promise((done) => setTimeout(done, 0));
};

/** A fresh store loaded at the folder address `url`, with a history of that one page. */
async function fresh(url = "/code/", state: unknown = null): Promise<Store> {
  stack.splice(0, stack.length, { url, state });
  place = 0;
  popped.length = 0;
  arrive();
  // What the server tells a page it serves at that address.
  config.target = { path: page.location.pathname.replace(/^\/|\/$/g, ""), kind: "dir" };
  const store = new stores.Store();
  await store.start();
  await settle();
  return store;
}

const host = { filter: () => undefined, closeMenu: () => undefined, flipScheme: () => undefined, page: () => 10, menu: () => undefined, copyPath: () => undefined };
/** A press of `key` on the list. */
async function press(store: Store, key: string): Promise<void> {
  keys.listKeys(store, host)[key]?.();
  await settle();
}
const address = () => page.location.pathname + page.location.search;
const at = (store: Store, path: string) => store.list().findIndex((entry) => entry.path === path);

test("the matches open over the folder at an address of their own, and back and forward leave and find them", async () => {
  const store = await fresh();
  store.find("repo");
  await settle();
  expect(address()).toBe("/code/?find=repo");
  expect(store.s.finding).toBe(true);
  // The first page, of a size the server sends at most.
  expect(store.list()).toHaveLength(stores.MATCH_PAGE);
  expect(store.s.matches?.total).toBe(MATCHES.length);
  expect(store.cur()?.path).toBe("backups/repos");

  store.moveTo(1);
  page.history.back();
  await settle();
  expect(address()).toBe("/code/");
  expect(store.s.finding).toBe(false);
  page.history.go(1);
  await settle();
  // Where they were left, with no new answer asked for.
  expect(store.s.finding).toBe(true);
  expect(store.cur()?.path).toBe("code/okfs/src/repo.rs");

  // Esc leaves them as back does.
  await press(store, "Escape");
  expect(address()).toBe("/code/");
  expect(store.s.finding).toBe(false);
});

test("a folder entered from the matches leads back to them however deep it is gone into", async () => {
  const store = await fresh();
  store.find("repo");
  await settle();
  await press(store, "ArrowRight");
  expect(address()).toBe("/backups/repos/");
  expect(store.s.finding).toBe(false);
  expect(store.trail()).toMatchObject({ q: "repo", root: "backups/repos", steps: 1 });

  // Deeper and up again, as usual.
  await press(store, "l");
  expect(address()).toBe("/backups/repos/2026-01/");
  await press(store, "h");
  expect(address()).toBe("/backups/repos/");
  // At the folder entered from them, left goes back to the matches, not to that folder's own folder.
  await press(store, "ArrowLeft");
  expect(address()).toBe("/code/?find=repo");
  expect(store.s.finding).toBe(true);
  expect(store.cur()?.path).toBe("backups/repos");

  // Esc goes back to them from anywhere below, and so does the button in the top bar.
  await press(store, "ArrowRight");
  await press(store, "l");
  await press(store, "Escape");
  expect(address()).toBe("/code/?find=repo");
  expect(store.cur()?.path).toBe("backups/repos");
  await press(store, "ArrowRight");
  await press(store, "l");
  store.toMatches();
  await settle();
  expect(address()).toBe("/code/?find=repo");

  // A folder gone to some other way has no way back to them.
  await press(store, "ArrowRight");
  await store.showDir("code");
  expect(store.trail()).toBeNull();
});

test("a file opened from the matches goes back to them with left, and to its folder's list from a folder", async () => {
  const store = await fresh();
  store.find("repo");
  await settle();
  store.moveTo(at(store, "code/okfs/src/repo.rs"));
  await press(store, "ArrowRight");
  expect(address()).toBe("/code/okfs/src/repo.rs");
  expect(store.s.open?.name).toBe("repo.rs");
  // Right on an open file is not taken; down steps to the next file in its folder, up back.
  expect(keys.listKeys(store, host).ArrowRight).toBeUndefined();
  await press(store, "k");
  expect(store.s.open?.name).toBe("main.rs");
  await press(store, "j");
  // Left goes back to the list it was opened from, with the cursor where it was.
  await press(store, "ArrowLeft");
  expect(address()).toBe("/code/?find=repo");
  expect(store.s.finding).toBe(true);
  expect(store.cur()?.path).toBe("code/okfs/src/repo.rs");
});

test("left on a file opened from its folder goes back to the list with the cursor kept, and does not step", async () => {
  const store = await fresh("/code/okfs/src/");
  store.moveTo(1);
  await press(store, "ArrowRight");
  expect(address()).toBe("/code/okfs/src/repo.rs");
  await press(store, "ArrowLeft");
  expect(address()).toBe("/code/okfs/src/");
  expect(store.s.open).toBeNull();
  expect(store.cur()?.name).toBe("repo.rs");
  // `h` is left too.
  await press(store, "l");
  await press(store, "h");
  expect(store.s.open).toBeNull();
  expect(store.cur()?.name).toBe("repo.rs");
});

test("more matches are asked for as the cursor nears the last loaded, and a new sort or query starts from the top", async () => {
  const store = await fresh();
  store.find("repo");
  await settle();
  asked.length = 0;
  store.moveTo(100);
  await settle();
  expect(asked.filter((url) => url.startsWith("/api/search"))).toEqual([]);
  store.moveTo(150);
  await settle();
  expect(asked.some((url) => url.includes("offset=200&limit=200"))).toBe(true);
  expect(store.list()).toHaveLength(400);
  store.moveTo(399);
  await settle();
  expect(store.list()).toHaveLength(MATCHES.length);
  expect(store.list().at(-1)?.path).toBe("pad/repo-447.txt");

  asked.length = 0;
  store.setMatchSort("size");
  await settle();
  expect(asked).toEqual(["/api/search?q=repo&offset=0&limit=200&sort=size"]);
  expect(store.at()).toBe(0);
  // The same head again turns the order around; `s` steps on to the next order.
  store.setMatchSort("size");
  expect(store.s.matches?.sort).toEqual({ key: "size", rev: true });
  store.setMatchSort();
  expect(store.s.matches?.sort).toEqual({ key: "time", rev: false });

  store.refine("nothing");
  await settle();
  expect(address()).toBe("/code/?find=nothing");
  expect(store.s.matches?.total).toBe(0);
  expect(store.list()).toHaveLength(0);
});

test("a reload of the matches' address opens them again, on the match the cursor was left on", async () => {
  const store = await fresh("/code/?find=repo", { at: 1, sort: { key: "rank", rev: false } });
  expect(store.s.finding).toBe(true);
  expect(store.s.path).toBe("code");
  expect(store.cur()?.path).toBe("code/okfs/src/repo.rs");
  // Opened by a reload, they have no page before them to go back to: leaving them shows their folder in place.
  await press(store, "Escape");
  expect(address()).toBe("/code/");
  expect(store.s.finding).toBe(false);
  expect(stack).toHaveLength(1);
});
