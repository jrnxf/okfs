// The slot rule: how many slots a window has, and what goes in them.

import { expect, test } from "bun:test";
import type { Listing } from "./api";
import { COLUMN_ROWS, columnsOf, pointedAt, slotsFor, standIn, startingAt, steppedOut } from "./slots";

/** A folder holding one folder under another, `depth` deep, the last one holding `last`. */
function nest(depth: number, last: Listing["entries"] = [], path = "top"): Listing {
  const under = depth > 1 ? nest(depth - 1, last, `${path}/in`) : undefined;
  const entries = under ? [{ n: "in", d: true, s: 0, m: 0 }] : last;
  return { path, m: 0, entries, total: entries.length, readme: null, under };
}

test("a window has four slots from 1,200 px, three from 900 px and two under that", () => {
  expect([3000, 1495, 1200].map(slotsFor)).toEqual([4, 4, 4]);
  expect([1199, 1100, 900].map(slotsFor)).toEqual([3, 3, 3]);
  expect([899, 800, 761, 320].map(slotsFor)).toEqual([2, 2, 2, 2]);
});

test("each folder down the first entries takes a slot, while there are slots", () => {
  const deep = nest(6);
  expect(columnsOf(deep, 4).levels.length).toBe(3);
  expect(columnsOf(deep, 3).levels.length).toBe(2);
  expect(columnsOf(deep, 2).levels.length).toBe(1);
  expect(columnsOf(nest(2), 4).levels.length).toBe(2);
});

test("the columns stop at a file, which is shown after them, at an empty folder and at a level that did not come", () => {
  const files = columnsOf(nest(1, [{ n: "a.txt", s: 1, m: 0 }, { n: "b.txt", s: 1, m: 0 }]), 4);
  expect(files.levels.length).toBe(1);
  expect(files.file?.item.n).toBe("a.txt");
  expect(files.led).toEqual(["a.txt"]);
  // A file the pointer picked is the one shown.
  expect(columnsOf(nest(1, [{ n: "a.txt", s: 1, m: 0 }, { n: "b.txt", s: 1, m: 0 }]), 4, ["b.txt"]).file?.item.n).toBe("b.txt");
  // With no slot left after the columns, no file is shown.
  expect(columnsOf(nest(3, [{ n: "a.txt", s: 1, m: 0 }]), 4).file).toBeNull();
  expect(columnsOf(nest(2, [{ n: "a.txt", s: 1, m: 0 }]), 4).file?.item.n).toBe("a.txt");
  const empty = columnsOf(nest(1), 4);
  expect([empty.levels.length, empty.file, empty.led]).toEqual([1, null, []]);
  const cut = nest(3);
  delete cut.under?.under;
  expect(columnsOf(cut, 4).levels.length).toBe(2);
  // A folder whose answer is on its way has its column already.
  expect(columnsOf(undefined, 4).levels).toEqual([undefined]);
});

test("a column leads on to the entry the pointer picked in it, and an answer for other picks stops at the pick", () => {
  const level = (path: string, names: string[], under?: Listing): Listing => ({
    path,
    m: 0,
    entries: names.map((n) => ({ n, d: !n.includes("."), s: 0, m: 0 })),
    total: names.length,
    readme: null,
    under,
  });
  const first = level("p", ["node_modules", "src", "a.json"], level("p/node_modules", ["@babel"], level("p/node_modules/@babel", ["core"])));
  expect(columnsOf(first, 4).levels.map((it) => it?.path)).toEqual(["p", "p/node_modules", "p/node_modules/@babel"]);
  expect(columnsOf(first, 4).led).toEqual(["node_modules", "@babel"]);
  // The answer on screen is still the one for the first entries: the columns stop at the pick until its own comes.
  const waiting = columnsOf(first, 4, ["src"]);
  expect([waiting.levels.length, waiting.led, waiting.file]).toEqual([1, [], null]);
  const picked = level("p", ["node_modules", "src", "a.json"], level("p/src", ["components", "index.tsx"], level("p/src/components", ["Button.tsx"])));
  const src = columnsOf(picked, 4, ["src"]);
  expect(src.levels.map((it) => it?.path)).toEqual(["p", "p/src", "p/src/components"]);
  expect(src.led).toEqual(["src", "components"]);
  // A file picked in the first column is shown after it, in place of the columns past it.
  const file = columnsOf(picked, 4, ["a.json"]);
  expect([file.levels.length, file.file?.item.n, file.file?.at]).toEqual([1, "a.json", 2]);
  // A name that is not there leads on to the first entry.
  expect(columnsOf(first, 4, ["gone"]).led).toEqual(["node_modules", "@babel"]);
});

test("a step into a folder starts its columns from the answer of the folder above, until its own comes", () => {
  const level = (path: string, under?: Listing): Listing => ({ path, m: 0, entries: [{ n: "in", d: true, s: 0, m: 0 }], total: 1, readme: null, under });
  const above = level("a", level("a/in", level("a/in/in")));
  expect(startingAt(above, "a/in")).toBe(above.under);
  expect(columnsOf(startingAt(above, "a/in"), 4).levels.map((it) => it?.path)).toEqual(["a/in", "a/in/in"]);
  // An answer that does not reach the folder has no part of it.
  expect(startingAt(above, "b")).toBeUndefined();
  expect(startingAt(undefined, "a")).toBeUndefined();
});

test("a folder's columns stand in on the answer for the folder beside it, and never on one for a folder above or below", () => {
  const level = (path: string, under?: Listing): Listing => ({ path, m: 0, entries: [{ n: "in", d: true, s: 0, m: 0 }], total: 1, readme: null, under });
  // Down the list: the last folder's answer stays on screen until this one's comes.
  const beside = level("p/a", level("p/a/in"));
  expect(standIn(beside, "p/b")).toBe(beside);
  // A step in: the part of the answer above that starts at the folder.
  expect(standIn(level("p", beside), "p/a")).toBe(beside);
  // A step out from `p/a/in`: the answer on screen is for the folder left, a level below. Drawn under `p/a`, its column
  // would show the rows of `p/a/in`, and the next column would sit in the slot of the one after it.
  expect(standIn(level("p/a/in", level("p/a/in/in")), "p/a")).toBeUndefined();
  expect(columnsOf(standIn(level("p/a/in"), "p/a"), 4).levels).toEqual([undefined]);
  expect(standIn(level("p"), "p/a/in")).toBeUndefined();
  expect(standIn(undefined, "p/a")).toBeUndefined();
});

test("on a step out, the folder left is drawn as it was on screen until its own answer comes", () => {
  const level = (path: string, entries: Listing["entries"], under?: Listing): Listing => ({ path, m: 0, entries, total: entries.length, readme: null, under });
  const file = { n: "page.html", s: 1, m: 0 };
  // On screen before the step: `p/a` in the main list, the cursor on its folder `in`, and beside it the answer for `in`.
  const shown = level("p/a", [{ n: "z.txt", s: 1, m: 0 }, { n: "in", d: true, s: 0, m: 0 }]);
  const beside = level("p/a/in", [file]);
  // After the step to `p` with no answer yet for `p/a`, every pane is still there: `p/a`, `in`, and the preview of the
  // file `in` leads on to. Before, the column of `p/a` had no rows, and `in` and the preview left the screen.
  const left = (path: string) => (path === "p/a" ? "in" : undefined);
  const chain = columnsOf(standIn(beside, "p/a", shown), 4, [], left);
  expect(chain.levels.map((it) => it?.path)).toEqual(["p/a", "p/a/in"]);
  expect([chain.led, chain.file?.item.n]).toEqual([["in", "page.html"], "page.html"]);
  // Without the folder's listing, as before the fix, the column is a header with nothing past it.
  expect(columnsOf(standIn(beside, "p/a"), 4, [], left).levels).toEqual([undefined]);
  // The answer for the folder itself, once it has come, is drawn over what was on screen.
  const own = level("p/a", [{ n: "in", d: true, s: 0, m: 0 }], beside);
  expect(standIn(own, "p/a", shown)).toBe(own);
  // Only the folder left stands in, and only for itself.
  expect(standIn(beside, "p/b", shown)).toBeUndefined();
});

test("the folder left is cut as the server cuts a column: its first entries, folders first, past a folder not inside it", () => {
  const entries = [...Array.from({ length: 50 }, (_, at) => ({ n: `f${at}`, s: 1, m: 0 })), { n: "d", d: true, s: 0, m: 0 }];
  const shown: Listing = { path: "p/a", m: 3, entries, total: entries.length, hidden: 2, readme: { name: "README.md", html: "" } };
  const drawn = steppedOut(shown, { path: "p/b/in", m: 0, entries: [], total: 0, readme: null });
  expect(drawn.entries.length).toBe(COLUMN_ROWS);
  expect(drawn.entries[0]?.n).toBe("d");
  expect([drawn.total, drawn.hidden, drawn.readme, drawn.under]).toEqual([51, 2, null, undefined]);
  // What the main list had is left as it was.
  expect(shown.entries.length).toBe(51);
});

/**
 * An element as the page draws it, as far as `closest` goes. It is found only by an attribute, `[data-level]` or
 * `[data-i]`: a class, as a column once was found by, goes when the look changes, and is not asked for here.
 */
interface Drawn {
  dataset: Record<string, string>;
  parent: Drawn | null;
  closest: (selector: string) => Drawn | null;
}
function drawn(dataset: Record<string, string> = {}, parent: Drawn | null = null): Drawn {
  const el: Drawn = {
    dataset,
    parent,
    closest(selector) {
      const name = /^\[data-([a-z]+)\]$/.exec(selector)?.[1];
      if (!name) throw new Error(`a column is found by its attributes, not by ${selector}`);
      for (let at: Drawn | null = el; at; at = at.parent) if (name in at.dataset) return at;
      return null;
    },
  };
  return el;
}

test("the pointer on a row of any column is on that column's entry, not only in the first", () => {
  const levels = [
    nest(1, [{ n: "a", d: true, s: 0, m: 0 }, { n: "b", d: true, s: 0, m: 0 }]),
    nest(1, [{ n: "c", d: true, s: 0, m: 0 }]),
    nest(1, [{ n: "x.txt", s: 1, m: 0 }, { n: "y.txt", s: 1, m: 0 }]),
  ];
  const strip = drawn();
  // A column, its rows, a row and the name in it, as `Column` draws them.
  const nameIn = (level: number, i: number) => drawn({}, drawn({ i: String(i) }, drawn({}, drawn({ level: String(level), pane: `p${level}` }, strip))));
  const on = (target: Drawn) => {
    const at = pointedAt(target as unknown as Element, levels);
    return at && [at.level, at.item.n];
  };
  expect(on(nameIn(0, 1))).toEqual([0, "b"]);
  expect(on(nameIn(1, 0))).toEqual([1, "c"]);
  expect(on(nameIn(2, 1))).toEqual([2, "y.txt"]);
  // The column it is on is the one whose box the aim is measured from.
  expect(pointedAt(nameIn(2, 0) as unknown as Element, levels)?.column.dataset.level).toBe("2");
});

test("the pointer is on no entry on a column's bar, past its rows, or on a column whose answer is on its way", () => {
  const levels = [undefined, nest(1, [{ n: "c", d: true, s: 0, m: 0 }])];
  const column = drawn({ level: "1" }, drawn());
  expect(pointedAt(drawn({}, column) as unknown as Element, levels)).toBeUndefined();
  expect(pointedAt(drawn({ i: "4" }, column) as unknown as Element, levels)).toBeUndefined();
  expect(pointedAt(drawn({ i: "0" }, drawn({ level: "0" })) as unknown as Element, levels)).toBeUndefined();
  // A row of the main list is in no column.
  expect(pointedAt(drawn({ i: "0" }, drawn()) as unknown as Element, levels)).toBeUndefined();
});
