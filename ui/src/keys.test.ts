// The one-folder view: its key, and the choice kept from one visit to the next.

import { beforeAll, beforeEach, expect, test } from "bun:test";
import type { KeyHost } from "./keys";

// The page's modules read these as they load, so they are stood in for first and the modules loaded after.
const saved = new Map<string, string>();
Object.assign(globalThis, {
  document: { getElementById: () => null, addEventListener: () => undefined },
  localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) },
});

let keys: typeof import("./keys");
let stores: typeof import("./store");
beforeAll(async () => {
  keys = await import("./keys");
  stores = await import("./store");
});
beforeEach(() => saved.clear());

const host: KeyHost = { across: 1, filter: () => undefined, closeMenu: () => undefined, flipScheme: () => undefined };

test("p switches between the two panes and the one-folder view", () => {
  const store = new stores.Store();
  expect(store.s.pane).toBe(true);
  keys.listKeys(store, host).p?.();
  expect(store.s.pane).toBe(false);
  keys.listKeys(store, host).p?.();
  expect(store.s.pane).toBe(true);
});

test("the view is kept for the next visit, and the two panes are the view until one is chosen", () => {
  expect(new stores.Store().s.pane).toBe(true);
  new stores.Store().setPane(false);
  expect(new stores.Store().s.pane).toBe(false);
  new stores.Store().setPane(true);
  expect(new stores.Store().s.pane).toBe(true);
});
