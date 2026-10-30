// The address of a folder's zip follows what the page shows: hidden entries are in it only while they are shown.

import { expect, test } from "bun:test";
import { urls } from "./api";
import { unreadable } from "./fmt";
import { setShowsHidden } from "./hidden";

test("a zip's address asks for hidden entries only while they are shown", () => {
  setShowsHidden(false);
  expect(urls.zip("proj")).toBe("/zip/proj");
  setShowsHidden(true);
  expect(urls.zip("proj")).toBe("/zip/proj?all=1");
  expect(urls.zip("")).toBe("/zip/?all=1");
  setShowsHidden(false);
});

test("the status line counts names okfs cannot show, one or more", () => {
  expect(unreadable(1)).toBe("1 name okfs cannot show");
  expect(unreadable(3)).toBe("3 names okfs cannot show");
  expect(unreadable(1200)).toBe("1,200 names okfs cannot show");
});
