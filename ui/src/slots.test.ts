// The slot rule: how many slots a window has, and what goes in them.

import { expect, test } from "bun:test";
import type { Listing } from "./api";
import { columnsOf, slotsFor, startingAt } from "./slots";

/** A folder holding one folder under another, `depth` deep, the last one holding `last`. */
function nest(depth: number, last: Listing["entries"] = []): Listing {
  const under = depth > 1 ? nest(depth - 1, last) : undefined;
  const entries = under ? [{ n: "in", d: true, s: 0, m: 0 }] : last;
  return { path: "", m: 0, entries, total: entries.length, readme: null, under };
}

test("a window has four slots from 1,200 px, three from 900 px and two under that", () => {
  expect([3000, 1495, 1200].map(slotsFor)).toEqual([4, 4, 4]);
  expect([1199, 1100, 900].map(slotsFor)).toEqual([3, 3, 3]);
  expect([899, 800, 761, 320].map(slotsFor)).toEqual([2, 2, 2, 2]);
});

test("each folder down the first entries takes a slot, while there are slots", () => {
  const deep = nest(6);
  expect(columnsOf(deep, 4).length).toBe(3);
  expect(columnsOf(deep, 3).length).toBe(2);
  expect(columnsOf(deep, 2).length).toBe(1);
  expect(columnsOf(nest(2), 4).length).toBe(2);
});

test("the columns stop at a file, at an empty folder and at a level that did not come", () => {
  expect(columnsOf(nest(1, [{ n: "a.txt", s: 1, m: 0 }]), 4).length).toBe(1);
  expect(columnsOf(nest(1), 4).length).toBe(1);
  const cut = nest(3);
  delete cut.under?.under;
  expect(columnsOf(cut, 4).length).toBe(2);
  // A folder whose answer is on its way has its column already.
  expect(columnsOf(undefined, 4)).toEqual([undefined]);
});

test("a step into a folder starts its columns from the answer of the folder above, until its own comes", () => {
  const level = (path: string, under?: Listing): Listing => ({ path, m: 0, entries: [{ n: "in", d: true, s: 0, m: 0 }], total: 1, readme: null, under });
  const above = level("a", level("a/in", level("a/in/in")));
  expect(startingAt(above, "a/in")).toBe(above.under);
  expect(columnsOf(startingAt(above, "a/in"), 4).map((it) => it?.path)).toEqual(["a/in", "a/in/in"]);
  // An answer that does not reach the folder stays on screen as it is, until the folder's own replaces it.
  expect(startingAt(above, "b")).toBe(above);
  expect(startingAt(undefined, "a")).toBeUndefined();
});
