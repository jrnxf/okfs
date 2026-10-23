// What a drop or the picker hands over, planned as files to send and folders to make first.

import { expect, test } from "bun:test";
import { plan } from "./drop";

const file = (name: string) => new File(["x"], name);
const held = (...rels: string[]) => rels.map((rel) => ({ file: file(rel.slice(rel.lastIndexOf("/") + 1)), rel }));

test("files go into the folder they were dropped on, each into the folders it was in, made a level at a time first", () => {
  const { picked, folders, leftOut } = plan(held("a.txt", "photos/2025/boat.jpg", "photos/tide.png"), "notes", false);
  expect(picked.map(({ dir, name }) => [dir, name])).toEqual([
    ["notes", "a.txt"],
    ["notes/photos/2025", "boat.jpg"],
    ["notes/photos", "tide.png"],
  ]);
  expect(folders).toEqual(["notes/photos", "notes/photos/2025"]);
  expect(leftOut).toBe(0);
  // Into the served folder itself, there is no folder in front.
  expect(plan(held("photos/x.jpg"), "", false).folders).toEqual(["photos"]);
});

test("a folder that holds nothing is made too, after the folders above it", () => {
  const { picked, folders } = plan([], "", false, ["empty", "deep/er/est"]);
  expect(picked).toEqual([]);
  expect(folders).toEqual(["deep", "empty", "deep/er", "deep/er/est"]);
});

test("a dotfile and all in a hidden folder are left out unless dotfiles are served", () => {
  const dropped = held(".env", "site/.git/HEAD", "site/index.html", "site/.well-known/x");
  const without = plan(dropped, "", false, ["site/.cache"]);
  expect(without.picked.map((pick) => pick.name)).toEqual(["index.html"]);
  expect(without.folders).toEqual(["site"]);
  expect(without.leftOut).toBe(4);
  const shown = plan(dropped, "", true);
  expect(shown.picked.map((pick) => pick.name)).toEqual([".env", "HEAD", "index.html", "x"]);
  expect(shown.leftOut).toBe(0);
});
