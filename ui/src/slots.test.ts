// The slot rule: how many slots a window has, and what goes in them.

import { expect, test } from "bun:test";
import type { Listing } from "./api";
import { chainOf, slotsFor } from "./slots";

/** A folder holding one folder under another, `depth` deep, the last one holding `last`. */
function nest(depth: number, last: Listing["entries"] = []): Listing {
  const under = depth > 1 ? nest(depth - 1, last) : undefined;
  const entries = under ? [{ n: "in", d: true, s: 0, m: 0 }] : last;
  return { path: "", entries, total: entries.length, readme: null, under };
}

test("a window has four slots from 1,200 px, three from 900 px and two under that", () => {
  expect([3000, 1495, 1200].map(slotsFor)).toEqual([4, 4, 4]);
  expect([1199, 1100, 900].map(slotsFor)).toEqual([3, 3, 3]);
  expect([899, 800, 761, 320].map(slotsFor)).toEqual([2, 2, 2, 2]);
});

const file = { n: "a.txt", s: 1, m: 0 };
/** How many columns, and whether a file is previewed after them. */
const shape = (listing: Listing | undefined, slots: number): [number, boolean] => {
  const { levels, file } = chainOf(listing, slots);
  return [levels.length, file !== null];
};

test("each folder down the first entries takes a slot, while there are slots", () => {
  const deep = nest(6);
  expect(shape(deep, 4)).toEqual([3, false]);
  expect(shape(deep, 3)).toEqual([2, false]);
  expect(shape(deep, 2)).toEqual([1, false]);
  expect(shape(nest(2), 4)).toEqual([2, false]);
});

test("the file the path ends on is previewed only when a slot is left for it", () => {
  expect(shape(nest(1, [file]), 4)).toEqual([1, true]);
  expect(shape(nest(2, [file]), 4)).toEqual([2, true]);
  expect(shape(nest(3, [file]), 4)).toEqual([3, false]);
  expect(shape(nest(1, [file]), 3)).toEqual([1, true]);
  expect(shape(nest(2, [file]), 3)).toEqual([2, false]);
  expect(shape(nest(1, [file]), 2)).toEqual([1, false]);
  expect(chainOf({ ...nest(1, [file]), path: "top" }, 4).file).toEqual({ dir: "top", item: file });
});

test("the columns stop at an empty folder and at a level that did not come", () => {
  expect(shape(nest(1), 4)).toEqual([1, false]);
  const cut = nest(3);
  delete cut.under?.under;
  expect(shape(cut, 4)).toEqual([2, false]);
  // A folder whose answer is on its way has its column already.
  expect(chainOf(undefined, 4)).toEqual({ levels: [undefined], file: null });
});
