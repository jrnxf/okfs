// What says that okfs is not answering: a request that gets nothing back, or a proxy's word that okfs is not there.

import { afterEach, expect, test } from "bun:test";
import { NoAnswer, call, isDown, onReach, setDown } from "./reach";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
  setDown(false);
});

/** Stands `fetch` in by one that answers with `status`, or fails as it does when nothing answers. */
function answering(status: number | "nothing"): void {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("given up", "AbortError");
    if (status === "nothing") throw new TypeError("Failed to fetch");
    return new Response("{}", { status });
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
    setDown(false);
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
