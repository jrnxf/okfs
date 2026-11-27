// A small value kept for a page in this browser, by the page's path.

import { beforeEach, expect, test } from "bun:test";
import { LONGEST_STATE, holds, keepState, loadState, readAsk, tokenOf } from "./state";

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

test("only a get or a set with a token is read, and a set's state becomes JSON text", () => {
  expect(readAsk({ type: "okfs:state-get", token: "t" })).toEqual({ token: "t", get: true });
  expect(readAsk({ type: "okfs:state-set", token: "t", state: [true, false] })).toEqual({ token: "t", text: "[true,false]" });
  expect(readAsk({ type: "okfs:state-set", token: "t", state: { a: "x" } })).toEqual({ token: "t", text: '{"a":"x"}' });
  expect(readAsk({ type: "okfs:state-set", token: "t", state: 0 })).toEqual({ token: "t", text: "0" });
  expect(readAsk({ type: "okfs:state-set", token: "t", state: null })).toEqual({ token: "t", text: null });
  expect(readAsk({ type: "okfs:state-set", token: "t" })).toEqual({ token: "t", text: null });
  expect(readAsk({ type: "okfs:state", token: "t", state: [] })).toBeNull();
  expect(readAsk({ type: "okfs:save", token: "t", state: [] })).toBeNull();
  expect(readAsk("okfs:state-set")).toBeNull();
  expect(readAsk(null)).toBeNull();
});

test("a message without a token, or with one that is not text, is no message", () => {
  for (const type of ["okfs:state-get", "okfs:state-set"]) {
    expect(readAsk({ type, state: [true] })).toBeNull();
    expect(readAsk({ type, token: null, state: null })).toBeNull();
    expect(readAsk({ type, token: "", state: [true] })).toBeNull();
    expect(readAsk({ type, token: 7, state: [true] })).toBeNull();
  }
});

test("a state that is not JSON, or is too large, is refused with the reason", () => {
  expect(readAsk({ type: "okfs:state-set", token: "t", state: 1n })).toEqual({ token: "t", refused: "the page's state is not JSON" });
  expect(readAsk({ type: "okfs:state-set", token: "t", state: () => 1 })).toEqual({ token: "t", refused: "the page's state is not JSON" });
  expect(readAsk({ type: "okfs:state-set", token: "t", state: "x".repeat(LONGEST_STATE) })).toEqual({
    token: "t",
    refused: "the page's state is larger than 100 KB",
  });
});

test("each page has one token while okfs is open, and holds no other page's", () => {
  expect(holds("never/framed.html", "")).toBe(false);
  const a = tokenOf("a/list.html");
  const b = tokenOf("b/list.html");
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(b).not.toBe(a);
  expect(tokenOf("a/list.html")).toBe(a);
  expect(holds("a/list.html", a)).toBe(true);
  expect(holds("a/list.html", b)).toBe(false);
  expect(holds("b/list.html", a)).toBe(false);
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
