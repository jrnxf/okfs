// The promise okfs is built on: flipping fast. Hold a key across a folder and every preview must show, each soon.
import type { Page } from "@playwright/test";
import { PHOTOS } from "./fixture";
import { expect, test } from "./test";

/** The longest the slowest 5% of previews may take from the key press to a painted picture. */
const P95_MS = 150;
/** No preview may take longer than this, however slow the machine. */
const WORST_MS = 400;
/** A held key repeats about every 30 ms on desktops. */
const REPEAT_MS = 30;

/** Remembers when each key went down, and when each picture first painted after it loaded. */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = window as unknown as { downs: number[]; painted: Record<string, number> };
    seen.downs = [];
    seen.painted = {};
    addEventListener("keydown", () => seen.downs.push(performance.now()), true);
    const paint = (img: HTMLImageElement) =>
      requestAnimationFrame(() => {
        if (img.complete && img.naturalWidth > 0) seen.painted[img.alt] ??= performance.now();
      });
    document.addEventListener("load", (event) => event.target instanceof HTMLImageElement && paint(event.target), true);
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLImageElement) paint(node);
    }).observe(document.body, { childList: true, subtree: true });
  });
}

test("holding the arrow key across a folder paints every preview in time", async ({ page, okfs }, info) => {
  await page.goto(`${okfs.origin}/photos/`);
  await expect(page.locator('[role="listbox"] [data-cursor] b')).toHaveText("photo-00.png");
  await expect(page.getByRole("img", { name: "photo-00.png" })).toBeVisible();
  await watch(page);

  for (let i = 1; i < PHOTOS; i++) {
    await page.keyboard.down("ArrowDown");
    await page.waitForTimeout(REPEAT_MS);
  }
  await page.keyboard.up("ArrowDown");
  await expect(page.getByRole("img", { name: `photo-${PHOTOS - 1}.png` })).toBeVisible();

  const { downs, painted } = await page.evaluate(() => {
    const { downs, painted } = window as unknown as { downs: number[]; painted: Record<string, number> };
    return { downs, painted };
  });
  expect(downs).toHaveLength(PHOTOS - 1);
  const names = Array.from({ length: PHOTOS - 1 }, (_, i) => `photo-${String(i + 1).padStart(2, "0")}.png`);
  const never = names.filter((name) => painted[name] === undefined);
  expect(never, "previews that never painted").toEqual([]);

  const waits = names.map((name, i) => Math.round(painted[name]! - downs[i]!)).sort((a, b) => a - b);
  const p95 = waits[Math.ceil(waits.length * 0.95) - 1]!;
  const worst = waits.at(-1)!;
  const median = waits[Math.floor(waits.length / 2)]!;
  info.annotations.push({ type: "time to preview", description: `median ${median} ms, p95 ${p95} ms, worst ${worst} ms over ${waits.length} files` });
  console.log(`time to preview over ${waits.length} files: median ${median} ms, p95 ${p95} ms, worst ${worst} ms`);
  expect(p95, `p95 time to preview, ${p95} ms`).toBeLessThanOrEqual(P95_MS);
  expect(worst, `worst time to preview, ${worst} ms`).toBeLessThanOrEqual(WORST_MS);
});
