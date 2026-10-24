// How clicks and keys select rows: the anchor model of Finder, Explorer and Gmail. See pick.ts.

import { expect, test } from "bun:test";
import { NONE, type Picked, check, everything, extend, only, toggle, within } from "./pick";

const ROWS = ["drafts", "photos", "reports", "src", "tides", "archive.zip", "notes.md", "README.md", "survey.json", "tides.csv"];
const sel = (picked: Picked) => [...picked.sel].sort((a, b) => ROWS.indexOf(a) - ROWS.indexOf(b));

test("a click selects one row and a Shift click selects from it to the row clicked", () => {
  let now = only("notes.md");
  expect(sel(now)).toEqual(["notes.md"]);
  now = extend(now, ROWS, "tides.csv", "notes.md");
  expect(sel(now)).toEqual(["notes.md", "README.md", "survey.json", "tides.csv"]);
});

test("a second Shift click replaces the range from the same anchor, so going back shrinks it", () => {
  let now = extend(only("notes.md"), ROWS, "tides.csv", "notes.md");
  now = extend(now, ROWS, "README.md", "tides.csv");
  expect(sel(now)).toEqual(["notes.md", "README.md"]);
  // Past the anchor the other way: the range flips over it.
  now = extend(now, ROWS, "tides", "README.md");
  expect(sel(now)).toEqual(["tides", "archive.zip", "notes.md"]);
});

test("rows picked with Ctrl survive a Shift click, as in Finder", () => {
  let now = only("notes.md");
  now = toggle(now, "drafts");
  expect(sel(now)).toEqual(["drafts", "notes.md"]);
  // The anchor is drafts now: Shift reaches from it, and notes.md stays.
  now = extend(now, ROWS, "photos", "drafts");
  expect(sel(now)).toEqual(["drafts", "photos", "notes.md"]);
  now = extend(now, ROWS, "reports", "photos");
  expect(sel(now)).toEqual(["drafts", "photos", "reports", "notes.md"]);
});

test("Ctrl with Shift adds a range to what is selected, as in Explorer", () => {
  let now = extend(only("notes.md"), ROWS, "README.md", "notes.md");
  now = toggle(now, "drafts");
  now = extend(now, ROWS, "src", "drafts", true);
  expect(sel(now)).toEqual(["drafts", "photos", "reports", "src", "notes.md", "README.md"]);
});

test("the first Ctrl click keeps the row the cursor is on, and a second one on a row unselects it", () => {
  let now = toggle(NONE, "tides", "notes.md");
  expect(sel(now)).toEqual(["tides", "notes.md"]);
  now = toggle(now, "tides");
  expect(sel(now)).toEqual(["notes.md"]);
});

test("Shift and the arrows grow and shrink the range from the cursor, as Shift clicks do", () => {
  // The cursor is on notes.md and nothing is selected: Shift and down twice, then up once.
  let now = extend(NONE, ROWS, "README.md", "notes.md");
  now = extend(now, ROWS, "survey.json", "README.md");
  expect(sel(now)).toEqual(["notes.md", "README.md", "survey.json"]);
  now = extend(now, ROWS, "README.md", "survey.json");
  expect(sel(now)).toEqual(["notes.md", "README.md"]);
});

test("in select mode a Shift tick gives the whole range the state the row takes", () => {
  let now = check(NONE, ROWS, "notes.md", false);
  now = check(now, ROWS, "survey.json", false);
  now = check(now, ROWS, "tides.csv", false);
  // From tides.csv up to archive.zip, all ticked.
  now = check(now, ROWS, "archive.zip", true);
  expect(sel(now)).toEqual(["archive.zip", "notes.md", "README.md", "survey.json", "tides.csv"]);
  // Untick notes.md, which is the anchor now; a Shift tick on survey.json unticks the range to it.
  now = check(now, ROWS, "notes.md", false);
  now = check(now, ROWS, "survey.json", true);
  expect(sel(now)).toEqual(["archive.zip", "tides.csv"]);
});

test("select all, and a list read again keeps only the rows still in it", () => {
  let now = everything(ROWS);
  expect(now.sel.size).toBe(ROWS.length);
  now = within(now, ROWS.filter((row) => row !== "notes.md" && row !== "drafts"));
  expect(now.sel.has("notes.md")).toBe(false);
  expect(now.anchor).toBe(null);
  const same = within(now, ROWS);
  expect(same).toBe(now);
});
