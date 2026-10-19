// The palette says "Nothing matches" only for an answer to the query typed, and asks the server without a needless wait.

import { expect, test } from "bun:test";
import type { Found } from "./api";
import { holdBack, took, waiting } from "./find";

const found = (hits: number): Found => ({ hits: [], total: hits, indexed: 60000, ready: true, took: 1.2 });

test("the answer to an earlier query is not an answer to the one typed", () => {
  // The empty query is asked once for the count, and answers with no hits: typing "r" must not read that as "nothing matches".
  expect(waiting("r", { q: "", found: found(0) })).toBe(true);
  expect(waiting("re", { q: "r", found: found(40) })).toBe(true);
  expect(waiting("r", null)).toBe(true);
});

test("the answer to the query typed can say nothing matches", () => {
  expect(waiting("zzq", { q: "zzq", found: found(0) })).toBe(false);
});

test("the first key after a pause is asked at once, and a burst is spaced", () => {
  expect(holdBack(1000, 0, 40)).toBe(0);
  expect(holdBack(1010, 1000, 40)).toBe(30);
  expect(holdBack(1040, 1000, 40)).toBe(0);
});

test("the time the server took reads short", () => {
  expect(took(0.4)).toBe("0.4 ms");
  expect(took(12.3)).toBe("12 ms");
});
