// Findings of the pre-launch review: an open file scrolls by key, and its page is held to the contrast rules.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./test";

const LONG = Array.from({ length: 4000 }, (_, i) => `line ${i}: some words to fill the line`).join("\n") + "\n";

test("PageDown, Space and Shift Space scroll an open file", async ({ page, okfs }) => {
  writeFileSync(join(okfs.root, "long.txt"), LONG);
  await page.goto(`${okfs.origin}/long.txt`);
  const scroller = page.locator(".pv-scroll");
  await expect(scroller).toContainText("line 0:");
  const top = () => scroller.evaluate((box) => box.scrollTop);
  expect(await top()).toBe(0);
  // The file is drawn in parts: wait until it is long enough that no press reaches its end.
  await expect.poll(() => scroller.evaluate((box) => box.scrollHeight)).toBeGreaterThan(20_000);
  await page.keyboard.press("PageDown");
  await expect.poll(top).toBeGreaterThan(300);
  const first = await top();
  await page.keyboard.press("Space");
  await expect.poll(top).toBeGreaterThan(first + 300);
  await page.keyboard.press("PageUp");
  await page.keyboard.press("Shift+Space");
  await expect.poll(top).toBeLessThan(first);
  // The file is still the one that was open.
  await expect(page).toHaveURL(`${okfs.origin}/long.txt`);
});

test("the scrolling parts of an open file and of a folder can take focus, and say so to a screen reader", async ({ page, okfs }) => {
  writeFileSync(join(okfs.root, "long.txt"), LONG);
  await page.goto(`${okfs.origin}/long.txt`);
  await expect(page.locator(".pv-scroll")).toContainText("line 0:");
  const rule = () => new AxeBuilder({ page }).withRules(["scrollable-region-focusable"]).analyze();
  expect((await rule()).violations.map((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);
  // The column of the folder under the cursor scrolls too.
  await page.goto(`${okfs.origin}/`);
  await expect(page.locator(".col-rows")).not.toHaveCount(0);
  expect((await rule()).violations.map((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);
});
