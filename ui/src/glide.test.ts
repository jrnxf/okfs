// Where the cursor's highlight travels when the panes slide, in a window of four 375 px slots with 34 px rows.

import { expect, test } from "bun:test";
import { type Box, glideOf, rowOf, seen } from "./glide";

const ROW = 34;
/** A row of the main list, in the first slot, `at` rows down from the strip's top edge past the list's bars. */
const row = (at: number, x = 0, w = 375): Box => ({ x, y: 60 + at * ROW, w, h: ROW });

test("on a step the highlight goes from the row it was on to the row it lands on, moving only", () => {
  expect(glideOf(row(1), row(6))).toEqual([{ transform: "translate(0px, 94px)" }, { transform: "translate(0px, 264px)" }]);
  // Up as well as down.
  expect(glideOf(row(6), row(1))?.at(-1)).toEqual({ transform: "translate(0px, 94px)" });
});

test("a step interrupted part way takes the highlight on from where it had got to", () => {
  const between: Box = { ...row(3), y: row(3).y + 11.25 };
  expect(glideOf(between, row(0))?.[0]).toEqual({ transform: `translate(0px, ${between.y}px)` });
});

test("a highlight that lands where it was does not travel", () => {
  expect(glideOf(row(2), row(2))).toBeNull();
  // A fraction of a pixel is the same place.
  expect(glideOf(row(2), { ...row(2), y: row(2).y + 0.2 })).toBeNull();
});

test("rows of different sizes do not travel: a list of matches two slots wide, or a phone's taller matches", () => {
  expect(glideOf(row(2, 0, 750), row(4))).toBeNull();
  expect(glideOf({ ...row(2), h: 52 }, row(4))).toBeNull();
});

test("the row the cursor lands on is worked out from the list's rows, drawn or not", () => {
  // A list scrolled 200 rows down: its rows start far above the strip.
  const rows: Box = { x: 0, y: 60 - 200 * ROW, w: 375, h: 500 * ROW };
  expect(rowOf(rows, 203, ROW)).toEqual({ x: 0, y: 60 + 3 * ROW, w: 375, h: ROW });
});

test("a row is in view only when all of it is", () => {
  const view: Box = { x: 0, y: 60, w: 375, h: 10 * ROW };
  expect(seen(row(0), view)).toBe(true);
  expect(seen(row(9), view)).toBe(true);
  expect(seen(row(10), view)).toBe(false);
  expect(seen({ ...row(0), y: 50 }, view)).toBe(false);
});
