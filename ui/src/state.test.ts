// A small value kept for a page in this browser, by the page's path.

import { beforeEach, expect, test } from "bun:test";
import { LONGEST_STATE, keepState, loadState, newToken, readSet } from "./state";

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

test("only a message of this kind with a token is read, and its state becomes JSON text", () => {
  expect(readSet({ type: "okfs:state-set", token: "t", state: [true, false] })).toEqual({ token: "t", text: "[true,false]" });
  expect(readSet({ type: "okfs:state-set", token: "t", state: { a: "x" } })).toEqual({ token: "t", text: '{"a":"x"}' });
  expect(readSet({ type: "okfs:state-set", token: "t", state: 0 })).toEqual({ token: "t", text: "0" });
  expect(readSet({ type: "okfs:state-set", token: "t", state: null })).toEqual({ token: "t", text: null });
  expect(readSet({ type: "okfs:state-set", token: "t" })).toEqual({ token: "t", text: null });
  expect(readSet({ type: "okfs:save", token: "t", state: [] })).toBeNull();
  expect(readSet("okfs:state-set")).toBeNull();
  expect(readSet(null)).toBeNull();
});

test("a message without a token, or with one that is not text, is no message", () => {
  expect(readSet({ type: "okfs:state-set", state: [true] })).toBeNull();
  expect(readSet({ type: "okfs:state-set", state: null })).toBeNull();
  expect(readSet({ type: "okfs:state-set", token: "", state: [true] })).toBeNull();
  expect(readSet({ type: "okfs:state-set", token: 7, state: [true] })).toBeNull();
});

test("a state that is not JSON, or is too large, is refused with the reason", () => {
  expect(readSet({ type: "okfs:state-set", token: "t", state: 1n })).toEqual({ token: "t", refused: "the page's state is not JSON" });
  expect(readSet({ type: "okfs:state-set", token: "t", state: () => 1 })).toEqual({ token: "t", refused: "the page's state is not JSON" });
  expect(readSet({ type: "okfs:state-set", token: "t", state: "x".repeat(LONGEST_STATE) })).toEqual({
    token: "t",
    refused: "the page's state is larger than 100 KB",
  });
});

test("each token is new", () => {
  const tokens = new Set(Array.from({ length: 100 }, newToken));
  expect(tokens.size).toBe(100);
  for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{32}$/);
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
