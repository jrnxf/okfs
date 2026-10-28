// Moving to the Trash and back, renaming in place and moving, as the page asks the server for them, and the Undo of
// each. A server in the page holds one folder and the Trash, as okfs does on disk.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

/** The entries of the served folder, by path: `true` for a folder. */
let disk = new Map<string, boolean>();
/** What the Trash holds, by id. */
let trash = new Map<string, { path: string; dir: boolean }>();
/** The changes that were asked for, as method and address. */
let sent: string[] = [];
let ids = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const listing = (dir: string) => ({
  path: dir,
  m: 1,
  total: 0,
  readme: null,
  entries: [...disk]
    .filter(([path]) => path.slice(0, Math.max(0, path.lastIndexOf("/"))) === dir)
    // In name order, as okfs lists.
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, isDir]) => ({ n: path.slice(path.lastIndexOf("/") + 1), d: isDir || undefined, s: 1, m: 1 })),
});

Object.assign(globalThis, {
  document: { getElementById: () => null, addEventListener: () => undefined, querySelector: () => null },
  localStorage: { getItem: () => null, setItem: () => undefined },
  innerWidth: 1495,
  location: { pathname: "/", search: "", href: "http://localhost/" },
  history: { state: null, pushState: () => undefined, replaceState: () => undefined },
  Image: class {
    addEventListener(): void {}
  },
  fetch: async (url: string, init: RequestInit = {}) => {
    const at = new URL(url, "http://localhost/");
    const q = (name: string) => at.searchParams.get(name) ?? "";
    const method = init.method ?? "GET";
    if (method !== "GET") sent.push(`${method} ${at.pathname}${at.search}`);
    switch (`${method} ${at.pathname}`) {
      case "GET /api/list":
        return json(listing(q("path")));
      case "GET /api/trash":
        return json({ days: 30, items: [...trash].map(([id, item]) => ({ id, ...item, deleted: 1, gone: 2, link: false, size: 1, count: 0 })) });
      case "DELETE /api/entry": {
        const path = q("path");
        const id = `0000000000${++ids}-beef`;
        trash.set(id, { path, dir: disk.get(path) === true });
        disk.delete(path);
        return json({ trash: { id, path, deleted: 1, gone: 2, dir: false, link: false, size: 1, count: 0 } });
      }
      case "POST /api/trash/restore": {
        const item = trash.get(q("id"));
        if (!item) return json({ error: "there is no such entry in the Trash" }, 404);
        trash.delete(q("id"));
        disk.set(item.path, item.dir);
        return json({ path: item.path, made: null });
      }
      case "POST /api/move": {
        const [from] = [q("from")];
        let to = q("to");
        // With keep, a taken name gives way to the next free one, as on the server.
        for (let copy = 1; disk.has(to) && q("keep"); copy++) to = q("to").replace(/(\.[^.]*)?$/, (ext) => ` (${copy})${ext}`);
        if (disk.has(to)) return json({ error: `there is already an entry named ${to}` }, 412);
        const isDir = disk.get(from) === true;
        disk.delete(from);
        disk.set(to, isDir);
        return json({ path: to });
      }
      default:
        return json({});
    }
  },
});

let stores: typeof import("./store");
let config: typeof import("./config").config;
/** What the server told the page before this file, put back after it: every test file runs in the one page. */
let told: Partial<typeof config> = {};
beforeAll(async () => {
  config = (await import("./config")).config;
  told = { ...config };
  stores = await import("./store");
});
afterAll(() => {
  for (const key of Object.keys(config)) delete config[key as keyof typeof config];
  Object.assign(config, told);
});

beforeEach(() => {
  disk = new Map([
    ["docs", true],
    ["a.txt", false],
    ["b.txt", false],
    ["c.txt", false],
  ]);
  trash = new Map();
  sent = [];
  Object.assign(config, { delete: true, trash: 30, edit: true, upload: true, root: "top" });
});

/** A store showing the top folder as the server lists it now. */
async function showing() {
  const store = new stores.Store();
  store.s.trash = { days: 30, items: [], loaded: false };
  await store.showDir("", { listing: true, history: "none" });
  return store;
}

const names = (store: InstanceType<typeof stores.Store>) => store.s.entries.map((entry) => entry.name);
const entry = (store: InstanceType<typeof stores.Store>, name: string) => store.s.entries.find((one) => one.name === name) ?? null;

/** Waits for what an undo started to finish: it reads the folder again last. */
const settle = () => new Promise((done) => setTimeout(done, 20));

test("a delete goes to the Trash without asking, and Undo puts it back", async () => {
  const store = await showing();
  store.askDelete(entry(store, "b.txt"));
  await settle();
  expect(sent).toEqual(["DELETE /api/entry?path=b.txt"]);
  expect(store.s.doomed).toBe(null);
  expect(names(store)).toEqual(["docs", "a.txt", "c.txt"]);
  expect(store.s.toast?.text).toBe("Moved “b.txt” to the Trash");
  // The cursor stays where the entry was, on what came after it.
  expect(store.cur()?.name).toBe("c.txt");

  expect(store.undo()).toBe(true);
  await settle();
  expect(sent.at(-1)).toMatch(/^POST \/api\/trash\/restore\?id=/);
  expect(disk.has("b.txt")).toBe(true);
  expect(names(store)).toEqual(["docs", "a.txt", "b.txt", "c.txt"]);
  expect(store.undo()).toBe(false);
});

test("without a Trash a delete asks first", async () => {
  const store = await showing();
  store.s.trash = null;
  store.askDelete(entry(store, "b.txt"));
  expect(store.s.doomed?.name).toBe("b.txt");
  expect(sent).toEqual([]);
});

test("the selected rows go to the Trash together, and come back together", async () => {
  const store = await showing();
  // The cursor on a.txt, then a Shift click on c.txt.
  store.moveTo(1);
  store.pickClick(3, { shift: true, add: false });
  expect([...store.s.picked.sel].sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
  store.askDelete(store.cur());
  await settle();
  expect(sent.length).toBe(3);
  expect(names(store)).toEqual(["docs"]);
  expect(store.s.toast?.text).toBe("Moved 3 items to the Trash");
  expect(store.s.picked.sel.size).toBe(0);
  store.undo();
  await settle();
  expect(names(store)).toEqual(["docs", "a.txt", "b.txt", "c.txt"]);
});

test("a rename in place is sent as a move, refused before it is sent when the name is taken, and undone", async () => {
  const store = await showing();
  store.startRename(entry(store, "a.txt"));
  expect(store.s.renaming?.path).toBe("a.txt");
  await store.rename("C.TXT");
  expect(sent).toEqual([]);
  expect(store.s.renaming?.error).toBe("“C.TXT” is already in this folder");

  await store.rename("notes.txt");
  expect(sent).toEqual(["POST /api/move?from=a.txt&to=notes.txt"]);
  expect(store.s.renaming).toBe(null);
  expect(store.cur()?.name).toBe("notes.txt");
  expect(store.s.toast?.text).toBe("Renamed to “notes.txt”");
  store.undo();
  await settle();
  expect(sent.at(-1)).toBe("POST /api/move?from=notes.txt&to=a.txt");
  expect(names(store)).toContain("a.txt");

  // Esc, or the same name, sends nothing.
  store.startRename(entry(store, "b.txt"));
  await store.rename(null);
  store.startRename(entry(store, "b.txt"));
  await store.rename("b.txt");
  expect(sent.length).toBe(2);
});

test("a move of the selection keeps a taken name beside it, and Undo moves each back", async () => {
  const store = await showing();
  disk.set("docs/a.txt", false);
  await store.transfer("move", ["a.txt", "b.txt"], "docs");
  expect(sent).toEqual(["POST /api/move?from=a.txt&to=docs%2Fa.txt&keep=1", "POST /api/move?from=b.txt&to=docs%2Fb.txt&keep=1"]);
  expect(store.s.toast?.text?.startsWith("Moved 2 items to “docs”")).toBe(true);
  store.undo();
  await settle();
  expect(store.s.toast).toBe(null);
  // a.txt went in as “a (1).txt”, beside the one there: that is the one that comes back.
  expect(sent.slice(2)).toEqual(["POST /api/move?from=docs%2Fb.txt&to=b.txt&keep=1", "POST /api/move?from=docs%2Fa%20(1).txt&to=a.txt&keep=1"]);
  expect(disk.get("docs/a.txt")).toBe(false);
});

test("names are refused as okfs would refuse them", () => {
  const siblings = [{ name: "Notes.md" }, { name: "a.txt" }];
  const refused = (name: string, own = "a.txt") => stores.refusedName(name, siblings, own);
  expect(refused("b.txt")).toBe(null);
  expect(refused("A.TXT")).toBe(null);
  expect(refused("notes.md")).toBe("“notes.md” is already in this folder");
  expect(refused("  ")).toBe("A name cannot be empty");
  expect(refused("x/y")).toBe("A name cannot hold a /");
  expect(refused(".env")).toBe("A name starting with a dot would be hidden");
  expect(refused("a\nb")).toBe("A name cannot hold a line break or a control character");
  expect(refused("..")).toBe("That name is not a name");
  expect(stores.freeName("untitled.txt", new Set(["untitled.txt", "untitled (1).txt"]))).toBe("untitled (2).txt");
  expect(stores.freeName("New folder", new Set())).toBe("New folder");
});
