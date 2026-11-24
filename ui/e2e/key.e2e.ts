import { expect, test } from "@playwright/test";
import { type Served, serve } from "./serve";

let okfs: Served;
test.beforeAll(async () => {
  okfs = await serve(["--require-key"]);
});
test.afterAll(() => okfs.stop());

test("a request without the key is refused", async ({ request }) => {
  const page = await request.get(`${okfs.origin}/`);
  expect(page.status()).toBe(401);
  const listing = await request.get(`${okfs.origin}/notes.md`);
  expect(listing.status()).toBe(401);
  const raw = await request.get(`${okfs.origin}/raw/notes.md`);
  expect(raw.status()).toBe(401);
  const zip = await request.get(`${okfs.origin}/zip/`);
  expect(zip.status()).toBe(401);
});

test("a wrong key is refused", async ({ request }) => {
  const page = await request.get(`${okfs.origin}/?key=not-the-key`);
  expect(page.status()).toBe(401);
});

test("the link with the key gets in and the browser keeps it", async ({ page }) => {
  expect(new URL(okfs.link).searchParams.get("key")).toBeTruthy();
  await page.goto(okfs.link);
  await expect(page.getByRole("option", { name: /^notes\.md/ })).toBeVisible();
  // The cookie it was given lets the next page in without the key in its address.
  await page.goto(`${okfs.origin}/notes.md`);
  await expect(page.getByRole("heading", { level: 1, name: "Field notes" })).toBeVisible();
});

test("an open page whose server started again with a new key becomes the full page for a link without the key", async ({ page }) => {
  const first = await serve(["--require-key"]);
  let second: Served | undefined;
  try {
    await page.goto(first.link);
    await expect(page.getByRole("option", { name: /^notes\.md/ })).toBeVisible();
    // The same folder and port, a new key: the cookie the page holds is refused from now on.
    first.stop(true);
    second = await serve(["--require-key"], {}, { root: first.root, port: Number(new URL(first.origin).port) });
    expect(second.link).not.toBe(first.link);
    // The stream of changes drops, the page asks what the matter is, and the server says it wants the key.
    await expect(page.getByRole("heading", { level: 1, name: "This link needs its key" })).toBeVisible({ timeout: 15_000 });
    expect(await page.getByRole("option").count()).toBe(0);
    // The new link gets in.
    await page.goto(second.link);
    await expect(page.getByRole("option", { name: /^notes\.md/ })).toBeVisible();
  } finally {
    (second ?? first).stop();
  }
});
