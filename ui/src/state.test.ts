// A small value kept for a page in this browser, by the page's path.

import { beforeEach, expect, test } from "bun:test";
import { LONGEST_STATE, keepState, loadState, readSet } from "./state";

const saved = new Map<string, string>();
let blocked = false;
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => {
      if (blocked) throw new DOMException("blocked", "SecurityError");
      return saved.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (blocked) throw new DOMException("full", "QuotaExceededError");
      saved.set(key, value);
    },
    removeItem: (key: string) => void saved.delete(key),
  },
});

beforeEach(() => {
  saved.clear();
  blocked = false;
});

test("only a message of this kind is read, and its state becomes JSON text", () => {
  expect(readSet({ type: "okfs:state-set", state: [true, false] })).toEqual({ text: "[true,false]" });
  expect(readSet({ type: "okfs:state-set", state: { a: "x" } })).toEqual({ text: '{"a":"x"}' });
  expect(readSet({ type: "okfs:state-set", state: 0 })).toEqual({ text: "0" });
  expect(readSet({ type: "okfs:state-set", state: null })).toEqual({ text: null });
  expect(readSet({ type: "okfs:state-set" })).toEqual({ text: null });
  expect(readSet({ type: "okfs:save", state: [] })).toBeNull();
  expect(readSet("okfs:state-set")).toBeNull();
  expect(readSet(null)).toBeNull();
});

test("a state that is not JSON, or is too large, is refused with the reason", () => {
  expect(readSet({ type: "okfs:state-set", state: 1n })).toEqual({ refused: "the page's state is not JSON" });
  expect(readSet({ type: "okfs:state-set", state: () => 1 })).toEqual({ refused: "the page's state is not JSON" });
  expect(readSet({ type: "okfs:state-set", state: "x".repeat(LONGEST_STATE) })).toEqual({ refused: "the page's state is larger than 100 KB" });
});

test("each page keeps its own value, and null forgets it", () => {
  expect(loadState("a/list.html")).toBeNull();
  expect(keepState("a/list.html", "[true]")).toBe(true);
  expect(keepState("b/list.html", '{"n":2}')).toBe(true);
  expect(loadState("a/list.html")).toEqual([true]);
  expect(loadState("b/list.html")).toEqual({ n: 2 });
  expect(keepState("a/list.html", null)).toBe(true);
  expect(loadState("a/list.html")).toBeNull();
  expect(loadState("b/list.html")).toEqual({ n: 2 });
});

test("blocked storage keeps nothing and loads nothing, and says so", () => {
  keepState("list.html", "[true]");
  blocked = true;
  expect(keepState("list.html", "[false]")).toBe(false);
  expect(loadState("list.html")).toBeNull();
});
