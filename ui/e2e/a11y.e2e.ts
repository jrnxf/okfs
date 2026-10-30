// What a screen reader is told: where the cursor is in the list and the palette, and an axe pass over both.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./test";

const list = (page: Page) => page.locator('[role="listbox"][aria-label="Files"]');
const cursorName = (page: Page) => page.locator('[role="listbox"] [data-cursor] b').last();

/**
 * What the list tells a screen reader. The keys are read by the page, so focus is usually not on the list: the live
 * region then says the cursor row. With focus on the list the reader follows `aria-activedescendant` itself, and the
 * region stays quiet so the row is not heard twice.
 */
const announced = async (page: Page) => {
  // A folder change draws the old pane under the new one for a moment: read the list when only one is left.
  await expect(list(page)).toHaveCount(1);
  return list(page).evaluate((box) => {
    const id = box.getAttribute("aria-activedescendant");
    const row = id ? document.getElementById(id) : null;
    const focused = document.activeElement === box;
    const said = document.querySelector('[role="status"][aria-live="polite"][aria-atomic="true"]')?.textContent ?? "";
    const name = row?.getAttribute("aria-label") ?? null;
    return { id, role: row?.getAttribute("role") ?? null, name, focused, said, heard: focused ? said === "" : said === name, inList: !!row && box.contains(row) };
  });
};

/** The cursor row is named by `aria-activedescendant` and heard exactly once, whoever holds focus. */
const named = (name: string) => ({ role: "option", inList: true, heard: true, name: expect.stringContaining(name) });

test("the list's active row follows j and k and is heard once", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/photos/`);
  await expect(cursorName(page)).toHaveText("photo-00.png");
  await expect.poll(() => announced(page)).toMatchObject(named("photo-00.png"));

  for (const [key, name] of [["j", "photo-01.png"], ["j", "photo-02.png"], ["k", "photo-01.png"], ["ArrowDown", "photo-02.png"]] as const) {
    await page.keyboard.press(key);
    await expect(cursorName(page)).toHaveText(name);
    await expect.poll(() => announced(page)).toMatchObject(named(name));
  }
});

test("a click puts focus on the list and the live region stands down", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/photos/`);
  await page.getByRole("option", { name: /^photo-05\.png/ }).click();
  await expect(cursorName(page)).toHaveText("photo-05.png");
  await expect.poll(() => announced(page)).toMatchObject({ ...named("photo-05.png"), focused: true, said: "" });
});

test("the active row survives a sort and a filter", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/photos/`);
  // A key has rows to move over only once the listing is in.
  await expect(cursorName(page)).toHaveText("photo-00.png");
  await page.keyboard.press("j");
  await expect(cursorName(page)).toHaveText("photo-01.png");

  await page.keyboard.press("s");
  await expect.poll(async () => (await announced(page)).name).toContain((await cursorName(page).textContent())!);
  expect(await announced(page)).toMatchObject({ role: "option", inList: true, heard: true });

  await page.keyboard.press("/");
  await page.keyboard.type("photo-3");
  await expect(page.getByRole("option", { name: /^photo-30\.png/ })).toBeVisible();
  await expect.poll(() => announced(page)).toMatchObject({ role: "option", inList: true, name: expect.stringContaining("photo-3") });
  await page.keyboard.press("Enter");
  await page.keyboard.press("j");
  await expect.poll(async () => (await announced(page)).name).toContain((await cursorName(page).textContent())!);
  expect(await announced(page)).toMatchObject({ role: "option", inList: true, heard: true });
});

const palette = (page: Page) => page.getByRole("dialog", { name: "Find anything" });

/** The combobox's active descendant must be an option that exists, and it must be the selected one. */
const combobox = (page: Page) =>
  palette(page)
    .getByRole("combobox")
    .evaluate((input) => {
      const id = input.getAttribute("aria-activedescendant");
      const row = id ? document.getElementById(id) : null;
      return { id, role: row?.getAttribute("role") ?? null, selected: row?.getAttribute("aria-selected") ?? null, focused: document.activeElement === input };
    });

test("the palette's active option exists after every arrow key, the show-all row too", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toBeVisible();
  await expect.poll(() => combobox(page)).toMatchObject({ role: "option", selected: "true", focused: true });

  const count = await palette(page).getByRole("option").count();
  for (let i = 0; i < count + 1; i++) {
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => combobox(page)).toMatchObject({ role: "option", selected: "true", focused: true });
  }
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => combobox(page)).toMatchObject({ role: "option", selected: "true", focused: true });
  }

  // A query with more matches than rows ends in the "show all" row: reach it by walking to the bottom.
  await page.keyboard.type("photo");
  await expect(palette(page).getByRole("option").first()).toBeVisible();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => combobox(page)).toMatchObject({ role: "option", selected: "true" });
  }
  await expect(page.locator("#palette-row-all")).toHaveCount(1);
});

test("the palette with nothing found names no active option", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type("zzzqqqxxx");
  await expect(palette(page).getByText(/Nothing matches/)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  expect(await combobox(page)).toMatchObject({ id: null, focused: true });
  await expect(palette(page).getByRole("option")).toHaveCount(0);
});

/**
 * Rules the page does not yet meet, each a design or page-structure change of its own rather than a fault in a
 * widget's wiring. Everything else axe checks is held at zero.
 */
const KNOWN = [
  "color-contrast", // the --faint text token is 3.5:1 on the light surface
  "label-content-name-mismatch", // a row's name adds its kind, which is shown only as an icon
  "landmark-one-main",
  "page-has-heading-one",
  "region", // the list and the folder bar sit outside a landmark
];

const brief = (v: { id: string; help: string; nodes: { target: unknown[] }[] }) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join("; ")})`;

test("axe finds nothing on the main view", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await expect(cursorName(page)).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).disableRules(KNOWN).analyze();
  expect(violations.map(brief)).toEqual([]);
});

test("axe finds nothing on the open palette", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type("photo");
  await expect(palette(page).getByRole("option").first()).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).disableRules(KNOWN).analyze();
  expect(violations.map(brief)).toEqual([]);
});
