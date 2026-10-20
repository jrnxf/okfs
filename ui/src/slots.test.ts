// The slot rule: how many slots a window has, and what goes in them.

import { expect, test } from "bun:test";
import type { Listing } from "./api";
import { columnsOf, slotsFor, standIn, startingAt } from "./slots";

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
