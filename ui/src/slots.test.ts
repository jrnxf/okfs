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

test("each folder down the first entries takes a slot, while there are slots", () => {
  const deep = nest(6);
  expect(chainOf(deep, 4).length).toBe(3);
  expect(chainOf(deep, 3).length).toBe(2);
  expect(chainOf(deep, 2).length).toBe(1);
  expect(chainOf(nest(2), 4).length).toBe(2);
});

test("the columns stop at an empty folder, at a file, and at a level that did not come", () => {
  expect(chainOf(nest(1), 4).length).toBe(1);
  expect(chainOf(nest(2, [{ n: "a.txt", s: 1, m: 0 }]), 4).length).toBe(2);
  const cut = nest(3);
  delete cut.under?.under;
  expect(chainOf(cut, 4).length).toBe(2);
  // A folder whose answer is on its way has its column already.
  expect(chainOf(undefined, 4)).toEqual([undefined]);
});
