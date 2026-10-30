// A key that opens a field and the keys typed right after it: on a busy machine the next frame comes late, and no key
// may wait for it.
import type { Page } from "@playwright/test";
import { expect, test } from "./test";

/** Every animation frame runs this late, as on a loaded machine. */
const LATE_MS = 300;

/** Holds back every animation frame by `LATE_MS`, from before the page's first script. */
const busy = (page: Page) =>
  page.addInitScript((late) => {
    const frame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => frame((time) => window.setTimeout(() => callback(time), late));
  }, LATE_MS);

test("the keys typed right after / are the filter's, when frames come late", async ({ page, okfs }) => {
  await busy(page);
  await page.goto(`${okfs.origin}/photos/`);
  await expect(page.getByRole("option", { name: /^photo-00\.png/ })).toBeVisible();
  await page.keyboard.press("/");
  await page.keyboard.type("photo-3");
  await expect(page.getByRole("textbox", { name: "Filter this folder" })).toHaveValue("photo-3");
  await expect(page).toHaveURL(`${okfs.origin}/photos/`);
  await expect(page.getByRole("option", { name: /^photo-30\.png/ })).toBeVisible();
});

test("the keys typed right after Ctrl K are the palette's, when frames come late", async ({ page, okfs }) => {
  await busy(page);
  await page.goto(`${okfs.origin}/`);
  await expect(page.getByRole("option", { name: /^deep/ })).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.keyboard.type("needle");
  const palette = page.getByRole("dialog", { name: "Find anything" });
  await expect(palette.getByRole("combobox")).toHaveValue("needle");
  await expect(palette.getByText("needle-in-haystack.txt")).toBeVisible();
});
