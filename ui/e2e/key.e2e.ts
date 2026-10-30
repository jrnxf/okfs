import { expect, test } from "@playwright/test";
import { type Served, serve } from "./serve";

let okfs: Served;
test.beforeAll(async () => {
  okfs = await serve(["--key"]);
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
