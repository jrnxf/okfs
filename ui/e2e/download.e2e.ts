import { readFileSync } from "node:fs";
import { expect, test } from "./test";

test("the zip link downloads the folder as a zip", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/deep/`);
  const link = page.locator('a[href="/zip/deep"]');
  await expect(link).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toBe("deep.zip");
  const bytes = readFileSync(await download.path());
  // A zip starts with "PK", and keeps each name in the clear.
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  expect(bytes.toString("latin1")).toContain("deeper/needle-in-haystack.txt");
  expect(bytes.toString("latin1")).toContain("readme.txt");
});
