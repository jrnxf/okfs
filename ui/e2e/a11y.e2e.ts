// What a screen reader is told: where the cursor is in the list and the palette, and an axe pass over both.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { type Served, serve } from "./serve";
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

test("Tab stops on the list after the column heads, and the keys move its cursor from there", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/photos/`);
  await expect(cursorName(page)).toHaveText("photo-00.png");
  await page.getByRole("button", { name: "Mod." }).focus();
  await page.keyboard.press("Tab");
  await expect(list(page)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(cursorName(page)).toHaveText("photo-01.png");
  await expect.poll(() => announced(page)).toMatchObject({ ...named("photo-01.png"), focused: true, said: "" });
  // The ring goes round the pane that scrolls the rows, so its four sides show however long the list is.
  await expect(page.locator(".list").filter({ has: list(page) })).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Mod." })).toBeFocused();
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

test("the palette gives the focus back to what opened it when it closes with no pick", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/photos/`);
  await expect(cursorName(page)).toHaveText("photo-00.png");
  const opener = page.getByRole("button", { name: "Find anything" });
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
  await expect(opener).toBeFocused();
  // A click outside closes it too, and the press does not take the focus to the page.
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(palette(page)).toBeHidden();
  await expect(opener).toBeFocused();
  // Opened from the list with its key, it gives the focus back to the list.
  await list(page).focus();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list(page)).toBeFocused();
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
  "color-contrast", // text on --accent is held at 3:1, and the ported themes keep their upstream accent and syntax colors
  "label-content-name-mismatch", // a row's name adds its kind, which is shown only as an icon
];

const brief = (v: { id: string; help: string; nodes: { target: unknown[] }[] }) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join("; ")})`;

test("axe finds nothing on the main view", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await expect(cursorName(page)).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).disableRules(KNOWN).analyze();
  expect(violations.map(brief)).toEqual([]);
});

test("the list sits in the main landmark, and the heading names the folder, or the file that is open", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await expect(cursorName(page)).toBeVisible();
  await expect(page.getByRole("main").getByRole("listbox", { name: "Files" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(okfs.root.split("/").pop() ?? "");
  await page.goto(`${okfs.origin}/main.rs`);
  await expect(page.locator(".code")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("main.rs");
});

test("the list holds rows only: a README, an empty folder, a missing address and a filter with no match pass axe", async ({ page, okfs }) => {
  const scratch = join(okfs.root, "listed");
  mkdirSync(join(scratch, "empty"), { recursive: true });
  writeFileSync(join(scratch, "README.md"), "# About\n\nA [link](https://example.com).\n");
  try {
    const clean = async () => {
      const { violations } = await new AxeBuilder({ page }).disableRules(KNOWN).analyze();
      expect(violations.map(brief)).toEqual([]);
    };
    await page.goto(`${okfs.origin}/listed/`);
    await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
    await expect(list(page).locator(":scope > :not([role=option])")).toHaveCount(0);
    await clean();
    await page.keyboard.press("/");
    await page.keyboard.type("zzqq");
    await expect(page.getByText("No name contains")).toBeVisible();
    await clean();
    await page.goto(`${okfs.origin}/listed/empty/`);
    await expect(page.locator(".list").getByText("This folder is empty")).toBeVisible();
    await clean();
    await page.goto(`${okfs.origin}/listed/gone/`);
    await expect(page.getByText("Nothing at this address")).toBeVisible();
    await clean();
  } finally {
    rmSync(scratch, { recursive: true });
  }
});

/** Each built-in theme, by the id its file gives it. */
const THEMES = readdirSync(resolve(import.meta.dirname, "../../themes")).map((file) => file.replace(/\.css$/, ""));

test("faint text reaches 4.5:1 in every built-in theme, light and dark", async ({ page, okfs }) => {
  const faintFails: string[] = [];
  for (const theme of THEMES) {
    for (const scheme of ["light", "dark"]) {
      // A code file has faint line numbers and a faint count in its bar, and a filter with no match a faint hint.
      for (const [address, keys] of [["/main.rs", ""], ["/", "/zzqq"]] as const) {
        await page.goto(`${okfs.origin}${address}?theme=${theme}&scheme=${scheme}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        if (keys) {
          await expect(cursorName(page)).toBeVisible();
          await page.keyboard.type(keys);
          await expect(page.getByText("No name contains")).toBeVisible();
        } else {
          await expect(page.locator(".code")).toBeVisible();
        }
        const faint = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--faint").trim().toLowerCase());
        const { violations } = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
        for (const node of violations.flatMap((v) => v.nodes)) {
          const data = node.any[0]?.data as { fgColor?: string; contrastRatio?: number } | undefined;
          if (data?.fgColor === faint) faintFails.push(`${theme} ${scheme} ${address}: ${data.contrastRatio}:1 at ${node.target.join(" ")}`);
        }
      }
    }
  }
  expect(faintFails).toEqual([]);
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

test("Tab stays in the list of keys and does not walk the page behind it", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await expect(cursorName(page)).toBeVisible();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeFocused();
  await expect(help).toHaveAttribute("aria-modal", "true");
  const close = help.getByRole("button", { name: "Close" });
  for (const [key, on] of [["Tab", close], ["Tab", help], ["Shift+Tab", close]] as const) {
    await page.keyboard.press(key);
    await expect(on).toBeFocused();
  }
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});

test("the list of keys opens from the foot of the page and closes from its button", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  await expect(cursorName(page)).toBeVisible();
  const open = page.getByRole("button", { name: "? keys" });
  await open.click();
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).include('[role="dialog"]').disableRules(KNOWN).analyze();
  expect(violations.map(brief)).toEqual([]);
  await help.getByRole("button", { name: "Close" }).click();
  await expect(help).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("the row menu is named, takes the focus and tells which action the keys are on", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/photos/`);
  await expect(cursorName(page)).toHaveText("photo-00.png");
  await page.keyboard.press("a");
  const menu = page.getByRole("menu", { name: "photo-00.png" });
  await expect(menu).toBeFocused();
  const active = () => menu.evaluate((box) => document.getElementById(box.getAttribute("aria-activedescendant") ?? "")?.textContent ?? null);
  const items = await menu.getByRole("menuitem").allTextContents();
  await expect.poll(active).toBe(items[0]);
  // j and k move as the arrows do, and Home and End go to the ends.
  for (const [key, at] of [["ArrowDown", 1], ["j", 2], ["k", 1], ["End", items.length - 1], ["Home", 0]] as const) {
    await page.keyboard.press(key);
    await expect.poll(active).toBe(items[at]);
  }
  const { violations } = await new AxeBuilder({ page }).include('[role="menu"]').disableRules(KNOWN).analyze();
  expect(violations.map(brief)).toEqual([]);
  // The action is the one the highlight is on at the key press, however fast Enter follows the arrow.
  await page.keyboard.press("ArrowDown");
  await expect.poll(active).toBe(items[1]);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(page).toHaveURL(/photo-00\.png/);
});

test("the keys move into the list that opens beside a menu action, and Escape closes only that list", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/deep/`);
  await expect(cursorName(page)).toHaveText("deeper");
  const openMenu = async () => {
    // The empty space is under the rows, in the scroll that holds the listbox.
    const box = await page.locator(".list").first().boundingBox();
    await page.mouse.click(box!.x + 60, box!.y + box!.height - 40, { button: "right" });
    await page.mouse.move(2, 2);
  };
  await openMenu();
  const menu = page.getByRole("menu", { name: "deep" });
  await expect(menu).toBeFocused();
  const active = () => menu.evaluate((box) => document.getElementById(box.getAttribute("aria-activedescendant") ?? "")?.textContent ?? null);
  const items = await menu.getByRole("menuitem").allTextContents();
  const sort = items.indexOf("Sort by");
  for (let i = 0; i <= sort; i++) await page.keyboard.press("ArrowDown");
  await expect.poll(active).toBe("Sort by");
  // The right arrow opens the list with the keys on the ticked choice. Down moves in it, not in the menu behind.
  await page.keyboard.press("ArrowRight");
  await expect.poll(active).toBe("Name");
  await page.keyboard.press("ArrowDown");
  await expect.poll(active).toBe("Modified");
  const { violations } = await new AxeBuilder({ page }).include('[role="menu"]').disableRules(KNOWN).analyze();
  expect(violations.map(brief)).toEqual([]);
  // Escape goes one level back: the list closes and the menu stays.
  await page.keyboard.press("Escape");
  await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
  await expect.poll(active).toBe("Sort by");
  // Enter on a choice sets the order, however fast it follows the arrows, and does not run the next action of the menu.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await openMenu();
  await expect(menu.getByRole("menuitem", { name: "Show hidden files" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Sort by" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "Modified" })).toHaveAttribute("aria-checked", "true");
});

test.describe("with --allow-edit", () => {
  let editable: Served;
  test.beforeAll(async () => {
    editable = await serve(["--allow-edit"]);
  });
  test.afterAll(() => editable.stop());

  test("the rename field is not inside an option, and the renamed row is the active row again", async ({ page }) => {
    await page.goto(editable.link);
    await expect(cursorName(page)).toBeVisible();
    for (let i = 0; i < 20 && (await cursorName(page).textContent()) !== "notes.md"; i++) await page.keyboard.press("ArrowDown");
    await expect(cursorName(page)).toHaveText("notes.md");
    await page.keyboard.press("F2");
    const field = page.getByRole("textbox", { name: "New name for notes.md" });
    await expect(field).toBeFocused();
    // An option may hold no control: the row with the field is drawn beside the listbox while the name is typed.
    await expect(list(page).getByRole("textbox")).toHaveCount(0);
    const { violations } = await new AxeBuilder({ page }).disableRules(KNOWN).analyze();
    expect(violations.map(brief)).toEqual([]);
    await page.keyboard.type("log");
    await page.keyboard.press("Enter");
    await expect(field).toHaveCount(0);
    await expect(cursorName(page)).toHaveText("log.md");
    expect(await announced(page)).toMatchObject(named("log.md"));
  });
});
