// With --allow-edit, a page in the preview keeps what its controls show in its own file, and is not loaded again
// for it. The page uses the snippet from docs/writing.md, as a page someone writes would.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { type Served, serve } from "./serve";

const SNIPPET = `<script>
addEventListener("change", keep);
addEventListener("input", keep);
addEventListener("toggle", keep, true);
function keep() {
  const all = document.querySelectorAll("input[id]:not([type=password]):not([type=file]), textarea[id], select[id], details[id]");
  const controls = [...all].map((el) =>
    el.localName === "details" ? { id: el.id, open: el.open }
    : el.type === "checkbox" || el.type === "radio" ? { id: el.id, checked: el.checked }
    : { id: el.id, value: el.value });
  parent.postMessage({ type: "okfs:save", controls }, "*");
}
</script>`;

const PAGE = `<!doctype html>
<title>list</title>
<label><input type="checkbox" id="milk"> milk</label>
<label><input type="checkbox" id="eggs" checked> eggs</label>
<input id="note" value="">
<details id="more"><summary>More</summary>inside</details>
${SNIPPET}
`;

const COPY = `<!doctype html><button onclick="navigator.clipboard.writeText('copied text').then(() => (document.title = 'done'), (e) => (document.title = e.name))">Copy</button>`;

const PAGES = { "list.html": PAGE, "outside.html": PAGE, "copy.html": COPY };

let okfs: Served;
test.beforeAll(async () => {
  okfs = await serve(["--allow-edit"], PAGES);
});
test.afterAll(() => okfs.stop());

/** Opens a file's preview. okfs asks for its key with a write flag on: the link with it leaves a cookie. */
async function open(page: Page, served: Served, name: string): Promise<void> {
  await page.goto(served.link);
  await expect(page.getByRole("option", { name: /^notes\.md/ })).toBeVisible();
  await page.goto(`${served.origin}/${name}`);
}

test("a box ticked, a field typed in and a section opened are kept in the page's file", async ({ page }) => {
  const file = join(okfs.root, "list.html");
  await open(page, okfs, "list.html");
  const frame = page.frameLocator("iframe.pv-frame:not(.pv-ahead)");
  await expect(frame.getByText("milk")).toBeVisible();
  // A mark on the page's window: a page loaded again has none.
  await frame.locator("body").evaluate(() => ((window as unknown as { mark: number }).mark = 1));

  await frame.getByLabel("milk").check();
  await frame.getByLabel("eggs").uncheck();
  await frame.getByText("More").click();
  // Typed last: the field keeps the focus through the save.
  await frame.locator("#note").fill('buy "two"');

  await expect.poll(() => readFileSync(file, "utf8"), { timeout: 5000 }).toBe(
    PAGE.replace('id="milk">', 'id="milk" checked>')
      .replace('id="eggs" checked>', 'id="eggs">')
      .replace('id="note" value="">', 'id="note" value="buy &quot;two&quot;">')
      .replace('id="more">', 'id="more" open>'),
  );
  // The server has told the page the file changed by now: the page in the frame is still the one that was there.
  await page.waitForTimeout(1000);
  expect(await frame.locator("body").evaluate(() => (window as unknown as { mark?: number }).mark)).toBe(1);
  await expect(frame.locator("#note")).toBeFocused();
});

test("a write from outside okfs still loads the page again", async ({ page }) => {
  const file = join(okfs.root, "outside.html");
  await open(page, okfs, "outside.html");
  const frame = page.frameLocator("iframe.pv-frame:not(.pv-ahead)");
  await frame.getByLabel("milk").check();
  await expect.poll(() => readFileSync(file, "utf8")).toContain('id="milk" checked>');
  writeFileSync(file, PAGE.replace("> milk<", "> bread<"));
  await expect(frame.getByText("bread")).toBeVisible();
});

test("without --allow-edit nothing is written", async ({ page }) => {
  const reader = await serve([], PAGES);
  try {
    const file = join(reader.root, "list.html");
    await open(page, reader, "list.html");
    const frame = page.frameLocator("iframe.pv-frame:not(.pv-ahead)");
    await frame.getByLabel("milk").check();
    await page.waitForTimeout(1500);
    expect(readFileSync(file, "utf8")).toBe(PAGE);
  } finally {
    reader.stop();
  }
});

test("in a folder okfs may not write in, the page says why and nothing is sent", async ({ page }) => {
  const shut = join(okfs.root, "shut");
  mkdirSync(shut);
  writeFileSync(join(shut, "list.html"), PAGE);
  chmodSync(shut, 0o555);
  const puts: string[] = [];
  page.on("request", (request) => void (request.method() === "PUT" && puts.push(request.url())));
  try {
    await open(page, okfs, "shut/list.html");
    const frame = page.frameLocator("iframe.pv-frame:not(.pv-ahead)");
    await frame.getByLabel("milk").check();
    await expect(page.getByText("Not saved: the account okfs runs as cannot write in this folder")).toBeVisible();
    await frame.getByLabel("eggs").uncheck();
    await page.waitForTimeout(1000);
    expect(puts).toEqual([]);
    expect(readFileSync(join(shut, "list.html"), "utf8")).toBe(PAGE);
  } finally {
    chmodSync(shut, 0o755);
  }
});

test("a copy button in a page puts its text on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: okfs.origin });
  await open(page, okfs, "copy.html");
  const frame = page.frameLocator("iframe.pv-frame:not(.pv-ahead)");
  await frame.getByRole("button", { name: "Copy" }).click();
  await expect.poll(() => frame.locator("html").evaluate(() => document.title)).toBe("done");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("copied text");
});
