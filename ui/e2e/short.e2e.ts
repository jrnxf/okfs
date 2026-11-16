// A short window, or a high zoom: the list of keys and the theme menu stay inside the window and scroll.
import { expect, test } from "./test";

test.use({ viewport: { width: 1280, height: 450 } });

test("the list of keys scrolls to its last key in a short window", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await expect(page.getByRole("option", { name: /^deep/ })).toBeVisible();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  const last = help.getByText("This list");
  await expect(help).toBeFocused();
  await expect(last).not.toBeInViewport();
  await page.keyboard.press("End");
  await expect(last).toBeInViewport({ ratio: 1 });
  expect((await help.boundingBox())!.height).toBeLessThanOrEqual(450);
});

test("the theme menu reaches its last theme in a short window", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await page.getByRole("button", { name: "Theme" }).click();
  const menu = page.getByRole("dialog", { name: "Theme" });
  const box = (await menu.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(450);
  const last = menu.getByRole("button").last();
  await last.focus();
  await expect(last).toBeInViewport({ ratio: 1 });
});
