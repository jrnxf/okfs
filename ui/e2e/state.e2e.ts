// A page in the preview keeps a small value for the one who views it, in this browser, with no write flag on.
// The page uses the snippet from docs/usage.md, as a page someone writes would.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { type Served, serve } from "./serve";

const SNIPPET = `<script>
const boxes = [...document.querySelectorAll("input[type=checkbox]")];
addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.type !== "okfs:state") return;
  const ticks = event.data.state ?? [];
  boxes.forEach((box, i) => (box.checked = !!ticks[i]));
});
addEventListener("change", () => {
  parent.postMessage({ type: "okfs:state-set", state: boxes.map((box) => box.checked) }, "*");
});
</script>`;

const PAGE = `<!doctype html>
<title>list</title>
<label><input type="checkbox"> milk</label>
<label><input type="checkbox"> eggs</label>
${SNIPPET}
`;

let okfs: Served;
test.beforeAll(async () => {
  okfs = await serve([], { "list.html": PAGE, "other.html": PAGE });
});
test.afterAll(() => okfs.stop());

const shown = (page: Page) => page.frameLocator("iframe.pv-frame:not(.pv-ahead)");

test("a box ticked stays ticked after a reload, and the file does not change", async ({ page }) => {
  await page.goto(`${okfs.origin}/list.html`);
  await shown(page).getByLabel("eggs").check();
  // The value is kept at once: a reload straight after finds it.
  await expect.poll(() => page.evaluate(() => localStorage.getItem("okfs.state:list.html"))).toBe("[false,true]");

  await page.reload();
  await expect(shown(page).getByLabel("eggs")).toBeChecked();
  await expect(shown(page).getByLabel("milk")).not.toBeChecked();
  expect(readFileSync(join(okfs.root, "list.html"), "utf8")).toBe(PAGE);
});

test("each page keeps its own value", async ({ page }) => {
  await page.goto(`${okfs.origin}/list.html`);
  await shown(page).getByLabel("milk").check();
  await page.goto(`${okfs.origin}/other.html`);
  await expect(shown(page).getByText("milk")).toBeVisible();
  // The page has had its value by now: none, as it kept none.
  await page.waitForTimeout(300);
  await expect(shown(page).getByLabel("milk")).not.toBeChecked();
});

test("a page that went to another by a link is not given the first page's value", async ({ page }) => {
  await page.goto(`${okfs.origin}/list.html`);
  await shown(page).getByLabel("milk").check();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("okfs.state:list.html"))).toBe("[true,false]");
  // The same page, loaded again by itself: okfs can no longer say which file is in the frame.
  await shown(page).locator("body").evaluate(() => location.reload());
  await expect(shown(page).getByText("milk")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(shown(page).getByLabel("milk")).not.toBeChecked();
});
