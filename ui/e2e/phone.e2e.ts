// A phone with every write flag on: the header keeps the folder's name, every button can be hit with a thumb, and the
// keyboard hints are for a keyboard.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { type Served, serve } from "./serve";

const DEEP = "a-rather-long-folder-name-for-a-phone/inner-folder-with-a-long-name";
/** The least a thumb needs: a button's hit area is at least this wide and high. */
const THUMB = 44;

let okfs: Served;
test.beforeAll(async () => {
  okfs = await serve(["--allow-upload", "--allow-edit", "--allow-delete"]);
  mkdirSync(join(okfs.root, DEEP), { recursive: true });
  writeFileSync(join(okfs.root, DEEP, "notes.md"), "# Field notes\n\nSome words.\n");
});
test.afterAll(() => okfs.stop());

/** The nested folder, past the key. */
async function open(page: Page) {
  await page.goto(okfs.link);
  await expect(page.getByRole("option", { name: /^deep/ })).toBeVisible();
  await page.goto(`${okfs.origin}/${DEEP}/`);
  await expect(page.getByRole("option", { name: /^notes\.md/ })).toBeVisible();
}

const portrait = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

/**
 * Every button and link under `scope` that is on screen, with how far from its centre a tap still lands on it. That
 * is the hit area: the drawn box can be smaller, as a button's own padding or a reach beyond its edge makes up the rest.
 */
async function reach(page: Page, scope: string) {
  return page.evaluate(
    ({ scope, half }) => {
      const out: { name: string; w: number; h: number; hit: number }[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(`${scope} :is(button, a[href], [role="button"])`)) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const lands = (x: number, y: number) => {
          // A bar at the very edge of the screen has no point beyond it to probe, so a probe stays on the screen.
          y = Math.min(y, innerHeight - 1.5);
          const hit = document.elementFromPoint(x, y);
          return !!hit && (hit === el || el.contains(hit));
        };
        // The reach is the box or its pseudo-element, whichever is larger.
        const after = getComputedStyle(el, "::after");
        const reach = after.content === "none" ? { w: 0, h: 0 } : { w: parseFloat(after.width) || 0, h: parseFloat(after.height) || 0 };
        // The browser snaps a probe on a sub-pixel, so one is set a whole pixel inside each edge: a tap there must land on the control.
        const w = Math.max(box.width, reach.w) >= 2 * half + 2 && lands(cx - half, cy) && lands(cx + half, cy) ? 44 : 0;
        const h = Math.max(box.height, reach.h) >= 2 * half + 2 && lands(cx, cy - half) && lands(cx, cy + half) ? 44 : 0;
        out.push({ name: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 20) ?? "", w, h, hit: Math.min(w, h) });
      }
      return out;
    },
    { scope, half: THUMB / 2 - 1 },
  );
}

test.describe("a phone, upright", () => {
  test.use(portrait);

  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  test("the folder's name ends in an ellipsis before it meets the buttons", async ({ page }) => {
    const crumb = page.locator(`[data-crumb="${DEEP}"]`);
    const { clipped, ellipsis, right, buttons } = await crumb.evaluate((el) => {
      const style = getComputedStyle(el);
      const header = el.closest("header")!;
      const first = [...header.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.getBoundingClientRect().left);
      return {
        clipped: el.scrollWidth > el.clientWidth,
        ellipsis: style.textOverflow === "ellipsis" && style.overflow === "hidden" && style.display !== "inline-flex" && style.display !== "flex",
        right: el.getBoundingClientRect().right,
        buttons: Math.min(...first),
      };
    });
    expect(clipped).toBe(true);
    expect(ellipsis).toBe(true);
    expect(right).toBeLessThanOrEqual(buttons);
    // It keeps a useful part of the name: not a few letters.
    expect((await crumb.boundingBox())!.width).toBeGreaterThan(100);
  });

  test("every button in the header and in the footer has a 44 px hit area", async ({ page }) => {
    for (const scope of ["body > header", "body > footer"]) {
      const found = await reach(page, scope);
      expect(found.length, scope).toBeGreaterThan(0);
      expect(found.filter((b) => b.hit < THUMB), scope).toEqual([]);
    }
  });

  test("a file's sheet has buttons of 44 px too, the form switch and More among them", async ({ page }) => {
    await page.goto(`${okfs.origin}/${DEEP}/notes.md`);
    await expect(page.getByRole("heading", { level: 1, name: "notes.md" })).toBeVisible();
    await expect(page.locator("[data-pane]").getByRole("button", { name: "More" })).toBeVisible();
    const found = await reach(page, "[data-pane]");
    expect(found.map((b) => b.name)).toEqual(expect.arrayContaining(["Back to the list", "More", "Preview", "Code"]));
    expect(found.filter((b) => b.hit < THUMB)).toEqual([]);
  });

  test("what the header lost to the narrow width is behind its More button", async ({ page }) => {
    const header = page.locator("body > header");
    await expect(header.getByRole("button", { name: "Upload files here" })).toHaveCount(0);
    await header.getByRole("button", { name: "More" }).click();
    const menu = page.getByRole("menu");
    for (const name of [/Upload files/, /New file/, /Move this folder to Trash/, /^Trash$/, /hidden files/, /Theme/]) await expect(menu.getByRole("menuitem", { name })).toBeVisible();
  });
});

test.describe("a phone, on its side", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test("the keyboard hints and the shortcut on the search button stay away", async ({ page }) => {
    await open(page);
    const shown = await page.evaluate(() => [...document.querySelectorAll("kbd")].filter((k) => k.getBoundingClientRect().width > 0).map((k) => k.textContent));
    expect(shown).toEqual([]);
    await expect(page.getByText("Find anything", { exact: true })).toBeHidden();
  });
});

test.describe("a desktop", () => {
  test("keeps its hints", async ({ page }) => {
    await open(page);
    await expect(page.locator("body > footer kbd").first()).toBeVisible();
    await expect(page.getByText("Find anything", { exact: true })).toBeVisible();
  });
});
