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

const COMMENTED = '// A comment on top.\nfn main() {\n    // And one inside.\n    println!("hello"); /* and one at the end */\n}\n';

test("a code file in the default theme has no contrast violation, light and dark, comments and the VIEW pill included", async ({ page, okfs }) => {
  writeFileSync(join(okfs.root, "commented.rs"), COMMENTED);
  for (const scheme of ["light", "dark"]) {
    await page.goto(`${okfs.origin}/commented.rs?theme=default&scheme=${scheme}`);
    await expect(page.locator("html")).toHaveAttribute("data-scheme", scheme);
    await expect(page.locator(".code")).toContainText("A comment on top");
    await expect(page.getByText("view", { exact: true })).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
    const found = violations.flatMap((v) => v.nodes.map((n) => `${scheme}: ${n.target.join(" ")} ${JSON.stringify(n.any[0]?.data)}`));
    expect(found).toEqual([]);
  }
});

test("a table larger than the server reads whole is shown as its code, and the tab says so", async ({ page, okfs }) => {
  // 100,000 rows, over 2 MiB: the server shows the start of it as code.
  const rows = Array.from({ length: 100_000 }, (_, i) => `${i},name number ${i},${(i * 7) % 1000}`);
  const csv = `id,name,score\n${rows.join("\n")}\n`;
  expect(csv.length).toBeGreaterThan(2 * 1024 * 1024);
  writeFileSync(join(okfs.root, "big.csv"), csv);
  await page.goto(`${okfs.origin}/big.csv`);
  const shown = page.getByRole("group", { name: "Show as" });
  // What the pane draws is code, and the tab that is selected is the one for code.
  await expect(page.locator(".pv-scroll")).toContainText("id,name,score");
  await expect(page.locator(".pv-scroll table")).toHaveCount(0);
  await expect(shown.getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "true");
  const table = shown.getByRole("button", { name: "Table" });
  await expect(table).toHaveAttribute("aria-pressed", "false");
  await expect(table).toBeDisabled();
  await expect(table).toHaveAttribute("title", /Too large to show as a table/);
  // `r` has no other form to go to: the pane stays as it was.
  await page.keyboard.press("r");
  await expect(shown.getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "true");
  // A small table beside it still opens as a table, and keeps both tabs.
  await page.goto(`${okfs.origin}/table.csv`);
  await expect(page.locator(".pv-scroll table")).toHaveCount(1);
  await expect(shown.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
  await expect(shown.getByRole("button", { name: "Table" })).toBeEnabled();
});

test("the tab's title says what was searched for while the matches are shown", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  const title = await page.title();
  await page.keyboard.press("Control+k");
  await page.keyboard.type("needle");
  await page.getByRole("option", { name: /^Show all/ }).click();
  await expect(page).toHaveTitle(`Find “needle” - ${title}`);
  // Back from the matches, it is the folder's again.
  await page.keyboard.press("Escape");
  await expect(page).toHaveTitle(title);
});
