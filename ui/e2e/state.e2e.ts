// A page in the preview keeps a small value for the one who views it, in this browser, with no write flag on.
// The page uses the snippet from docs/usage.md, as a page someone writes would.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { type Served, serve } from "./serve";

const SNIPPET = `<script>
const boxes = [...document.querySelectorAll("input[type=checkbox]")];
const token = new URLSearchParams(location.search).get("okfs-state");
addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.type !== "okfs:state") return;
  const ticks = event.data.state ?? [];
  boxes.forEach((box, i) => (box.checked = !!ticks[i]));
});
addEventListener("change", () => {
  parent.postMessage({ type: "okfs:state-set", token, state: boxes.map((box) => box.checked) }, "*");
});
parent.postMessage({ type: "okfs:state-get", token }, "*");
</script>`;

const PAGE = `<!doctype html>
<title>list</title>
<label><input type="checkbox"> milk</label>
<label><input type="checkbox"> eggs</label>
${SNIPPET}
`;

// A page reached by a link. It shows its own query, the address it came from, and any value it is given. It asks at
// once, before it has loaded, for a value and to change it: with the token in its address, with one in the address
// it came from, and with one it guessed.
const SPY = `<!doctype html>
<title>spy</title>
<p id="query"></p>
<p id="referrer"></p>
<p id="got">got: none</p>
<script>
document.getElementById("query").textContent = "query: " + (location.search || "none");
document.getElementById("referrer").textContent = "referrer: " + (document.referrer || "none");
const from = document.referrer ? new URL(document.referrer).searchParams.get("okfs-state") : null;
addEventListener("message", (event) => {
  if (event.data?.type === "okfs:state") document.getElementById("got").textContent = "got: " + JSON.stringify(event.data.state);
});
for (const token of [new URLSearchParams(location.search).get("okfs-state"), from, "guess"]) {
  parent.postMessage({ type: "okfs:state-get", token }, "*");
  parent.postMessage({ type: "okfs:state-set", token, state: [false, false] }, "*");
}
</script>
`;

// A page that goes to another before it has loaded: its picture never arrives.
const SLOW = `<!doctype html>
<title>slow</title>
<img src="never.png">
<script>location = "spy.html";</script>
`;

let okfs: Served;
test.beforeAll(async () => {
  okfs = await serve([], {
    "list.html": PAGE,
    "other.html": PAGE,
    "linked.html": `${PAGE}<a href="spy.html">jump</a>\n`,
    "spy.html": SPY,
    "slow.html": SLOW,
  });
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

const spied = async (page: Page) => {
  await expect(shown(page).getByText("query: none")).toBeVisible();
  await expect(shown(page).getByText("referrer: none")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(shown(page).getByText("got: none")).toBeVisible();
};

test("a page reached by a link after the first has loaded gets no token, no value, and cannot change it", async ({ page }) => {
  await page.goto(`${okfs.origin}/linked.html`);
  await shown(page).getByLabel("milk").check();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("okfs.state:linked.html"))).toBe("[true,false]");
  await shown(page).getByText("jump").click();
  await spied(page);
  expect(await page.evaluate(() => localStorage.getItem("okfs.state:linked.html"))).toBe("[true,false]");
});

test("a page reached before the first has loaded gets no token, no value, and cannot change it", async ({ page }) => {
  await page.goto(`${okfs.origin}/list.html`);
  await page.evaluate(() => localStorage.setItem("okfs.state:slow.html", "[true,false]"));
  await page.goto(`${okfs.origin}/slow.html`);
  await spied(page);
  expect(await page.evaluate(() => localStorage.getItem("okfs.state:slow.html"))).toBe("[true,false]");
});
