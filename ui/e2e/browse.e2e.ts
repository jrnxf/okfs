// Moving through a folder and opening what is in it, as a visitor does with the keyboard.
import type { Page } from "@playwright/test";
import { expect, test } from "./test";

const cursor = (page: Page) => page.locator('[role="listbox"] [data-cursor] b').last();

test("j, k and the arrows move the cursor and the preview follows", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/photos/`);
  await expect(cursor(page)).toHaveText("photo-00.png");
  await expect(page.getByRole("img", { name: "photo-00.png" })).toBeVisible();

  const steps: [string, string][] = [
    ["j", "photo-01.png"],
    ["ArrowDown", "photo-02.png"],
    ["k", "photo-01.png"],
    ["ArrowUp", "photo-00.png"],
  ];
  for (const [key, name] of steps) {
    await page.keyboard.press(key);
    await expect(cursor(page)).toHaveText(name);
    await expect(page.getByRole("img", { name })).toBeVisible();
    await expect.poll(() => page.getByRole("img", { name }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  }
});

test("Enter opens a file and Esc closes it", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await page.getByRole("option", { name: /^main\.rs/ }).click();
  await expect(cursor(page)).toHaveText("main.rs");
  await expect(page.getByText("hello from the fixture")).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${okfs.origin}/main.rs`);
  await expect(page.getByText("hello from the fixture")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(`${okfs.origin}/`);
  await expect(cursor(page)).toHaveText("main.rs");
});

test("Enter on a folder goes in and Backspace comes out", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await expect(cursor(page)).toHaveText("deep");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${okfs.origin}/deep/`);
  await expect(page.getByRole("option", { name: /^readme\.txt/ })).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(page).toHaveURL(`${okfs.origin}/`);
});

test("the palette finds a file in a nested folder", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Find anything" });
  await expect(palette).toBeVisible();
  await page.keyboard.type("needle");
  await expect(palette.getByText("needle-in-haystack.txt")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${okfs.origin}/deep/deeper/needle-in-haystack.txt`);
  await expect(page.getByText("found me")).toBeVisible();
});

test("Markdown opens rendered and r flips it to source", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/notes.md`);
  await expect(page.getByRole("heading", { level: 1, name: "Field notes" })).toBeVisible();
  await expect(page.locator("pre.code")).toHaveCount(0);

  await page.keyboard.press("r");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
  await expect(page.locator("pre.code")).toContainText("# Field notes");
  await expect(page.locator("pre.code")).toContainText("**bold**");

  await page.keyboard.press("r");
  await expect(page.getByRole("heading", { level: 1, name: "Field notes" })).toBeVisible();
});

const loaded = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;

test("a PDF previews as its first page", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await page.getByRole("option", { name: /^paper\.pdf/ }).click();
  await expect(cursor(page)).toHaveText("paper.pdf");
  const first = page.locator('img[src*="paper.pdf"]');
  await expect(first).toBeVisible();
  await expect.poll(() => first.evaluate(loaded)).toBe(true);
});

test("a CSV previews as a table", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await page.getByRole("option", { name: /^table\.csv/ }).click();
  await expect(cursor(page)).toHaveText("table.csv");
  const table = page.locator("table");
  await expect(table.getByRole("columnheader", { name: "count" })).toBeVisible();
  await expect(table.getByRole("cell", { name: "apples" })).toBeVisible();
  await expect(table.getByRole("cell", { name: "pears" })).toBeVisible();
});

test("a picture at the top of the tree previews", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await page.getByRole("option", { name: /^poster\.png/ }).click();
  const picture = page.getByRole("img", { name: "poster.png" });
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate(loaded)).toBe(true);
});
