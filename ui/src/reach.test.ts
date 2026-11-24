// What says that okfs is not answering: a request that gets nothing back, or a proxy's word that okfs is not there. And
// what says that it answers but refuses the page's key.

import { afterEach, expect, test } from "bun:test";
import { NEEDS_KEY, NOT_ANSWERING, NoAnswer, call, isDown, onReach, setDown, whyDown } from "./reach";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
  setDown(null);
});

/** Stands `fetch` in by one that answers with `status` and `headers`, or fails as it does when nothing answers. */
function answering(status: number | "nothing", headers: Record<string, string> = {}): void {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("given up", "AbortError");
    if (status === "nothing") throw new TypeError("Failed to fetch");
    return new Response("{}", { status, headers });
  }) as typeof fetch;
}

test("a request nothing answers says okfs is down, and the next answer, an error too, that it is back", async () => {
  const heard: boolean[] = [];
  const stop = onReach(() => heard.push(isDown()));
  answering("nothing");
  await expect(call("/api/list?path=")).rejects.toBeInstanceOf(NoAnswer);
  expect(isDown()).toBe(true);
  // An error of okfs's own is an answer: the file may be gone, but okfs is there.
  answering(404);
  expect((await call("/api/list?path=gone")).status).toBe(404);
  expect(isDown()).toBe(false);
  expect(heard).toEqual([true, false]);
  stop();
});

test("a proxy in front of okfs that cannot reach it is not an answer of okfs's", async () => {
  for (const status of [502, 503, 504]) {
    setDown(null);
    answering(status);
    await expect(call("/api/previews?p=a.txt")).rejects.toBeInstanceOf(NoAnswer);
    expect(isDown()).toBe(true);
  }
});

test("a request given up on purpose says nothing about okfs", async () => {
  answering("nothing");
  const abort = new AbortController();
  abort.abort();
  const failed = await call("/api/previews?p=a.txt", { signal: abort.signal }).catch((error: unknown) => error);
  expect(failed).not.toBeInstanceOf(NoAnswer);
  expect(isDown()).toBe(false);
});

test("okfs refusing the key says the link needs it, not that okfs is down, until a request gets in again", async () => {
  answering(401, { "www-authenticate": "okfs-key" });
  const refused = await call("/api/list?path=").catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(NoAnswer);
  expect((refused as NoAnswer).why).toBe(NEEDS_KEY);
  expect(whyDown()).toBe(NEEDS_KEY);
  // Gone altogether, it is not answering at all.
  answering("nothing");
  await expect(call("/api/list?path=")).rejects.toMatchObject({ why: NOT_ANSWERING });
  expect(whyDown()).toBe(NOT_ANSWERING);
  answering(200);
  await call("/api/list?path=");
  expect(whyDown()).toBe(null);
});

test("a proxy in front that signs people in refuses in its own words, which are not okfs's", async () => {
  const refusals: Record<string, string>[] = [{}, { "www-authenticate": 'Basic realm="files"' }];
  for (const headers of refusals) {
    answering(401, headers);
    expect((await call("/api/list?path=")).status).toBe(401);
    expect(isDown()).toBe(false);
  }
});

test("a refused key reloads the page once, and an answer that lets it in lets it reload again", async () => {
  const kept = new Map<string, string>();
  let reloads = 0;
  const stand = globalThis as Record<string, unknown>;
  stand.sessionStorage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  };
  stand.location = { reload: () => void reloads++ };
  try {
    answering(401, { "www-authenticate": "okfs-key" });
    await call("/api/list?path=").catch(() => undefined);
    await call("/api/list?path=").catch(() => undefined);
    // The second refusal does not reload again: a server that keeps refusing cannot loop the page.
    expect(reloads).toBe(1);
    answering(200);
    await call("/api/list?path=");
    answering(401, { "www-authenticate": "okfs-key" });
    await call("/api/list?path=").catch(() => undefined);
    expect(reloads).toBe(2);
  } finally {
    delete stand.sessionStorage;
    delete stand.location;
  }
});

test("a refused key does not reload a page that cannot keep the guard", async () => {
  let reloads = 0;
  const stand = globalThis as Record<string, unknown>;
  stand.location = { reload: () => void reloads++ };
  try {
    answering(401, { "www-authenticate": "okfs-key" });
    await call("/api/list?path=").catch(() => undefined);
    expect(reloads).toBe(0);
  } finally {
    delete stand.location;
  }
});
