// What a file's address says about how it is shown: `?code` shows its code, `?focus` shows only it.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./test";

const pane = (page: Page) => page.locator('[data-pane="notes.md"]');
const banner = (page: Page) => page.locator("body > header");
const footer = (page: Page) => page.locator("body > footer");
const heading = (page: Page) => pane(page).getByRole("heading", { name: "Field notes" });
const shownAs = (page: Page) => page.getByRole("group", { name: "Show as" }).getByRole("button", { pressed: true });

test("?code opens a file as its code, and r and the switch write it", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/notes.md?code`);
  await expect(pane(page)).toContainText("# Field notes");
  await expect(heading(page)).toHaveCount(0);
  await expect(shownAs(page)).toHaveText("Code");

  // What is made from it is how a file opens, so its address needs no word for it.
  await page.keyboard.press("r");
  await expect(page).toHaveURL(`${okfs.origin}/notes.md`);
  await expect(heading(page)).toBeVisible();
  await expect(shownAs(page)).toHaveText("Preview");

  await page.getByRole("button", { name: "Code" }).click();
  await expect(page).toHaveURL(`${okfs.origin}/notes.md?code=1`);
  await page.reload();
  await expect(pane(page)).toContainText("# Field notes");
  await expect(shownAs(page)).toHaveText("Code");
});

test("a drawing, JSON and a table open as what is made from them, each named for it", async ({ page, okfs }) => {
  const forms = join(okfs.root, "forms");
  mkdirSync(forms);
  writeFileSync(join(forms, "shape.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="teal"/></svg>\n');
  writeFileSync(join(forms, "data.json"), '{ "name": "okfs", "tags": ["one", "two"] }\n');
  writeFileSync(join(forms, "table.csv"), "name,count\napples,3\n");
  try {
    for (const [name, made] of [
      ["shape.svg", "Image"],
      ["data.json", "Tree"],
      ["table.csv", "Table"],
    ]) {
      await page.goto(`${okfs.origin}/forms/${name}`);
      await expect(shownAs(page)).toHaveText(made!);
      await expect(page.locator("pre.code")).toHaveCount(0);
      await page.keyboard.press("r");
      await expect(shownAs(page)).toHaveText("Code");
      await expect(page.locator("pre.code")).toBeVisible();
      await expect(page).toHaveURL(`${okfs.origin}/forms/${name}?code=1`);
    }
  } finally {
    rmSync(forms, { recursive: true });
  }
});

test("?focus shows only the file, and Esc brings okfs back before it closes the file", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/notes.md?focus`);
  await expect(heading(page)).toBeVisible();
  // A word as typed is written the one way the page writes it.
  await expect(page).toHaveURL(`${okfs.origin}/notes.md?focus=1`);
  await expect(banner(page)).toBeHidden();
  await expect(footer(page)).toBeHidden();
  await expect(pane(page).getByRole("button", { name: "Back to the list" })).toBeHidden();
  // The pane has the whole window.
  const box = await pane(page).boundingBox();
  expect(box).toMatchObject({ x: 0, y: 0, width: 1280, height: 800 });

  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(`${okfs.origin}/notes.md`);
  await expect(banner(page)).toBeVisible();
  await expect(footer(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(`${okfs.origin}/`);
});

test("the two go together, and the button leaves focus", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/notes.md?code&focus`);
  await expect(pane(page)).toContainText("# Field notes");
  await expect(banner(page)).toBeHidden();
  await page.getByRole("button", { name: "Leave focus" }).click();
  await expect(page).toHaveURL(`${okfs.origin}/notes.md?code=1`);
  await expect(banner(page)).toBeVisible();
});

test("f shows only the open file, never the browser's full screen, and a file opened in its code says so in its address", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/`);
  // On the list there is nothing to focus on.
  await page.keyboard.press("f");
  await expect(page).toHaveURL(`${okfs.origin}/`);
  await page.getByRole("option", { name: /^notes\.md/ }).click();
  // The flip on the list holds for the file opened next, and its address says so.
  await page.keyboard.press("r");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${okfs.origin}/notes.md?code=1`);

  await page.keyboard.press("f");
  await expect(page).toHaveURL(`${okfs.origin}/notes.md?code=1&focus=1`);
  await expect(banner(page)).toBeHidden();
  // The browser's own full screen is a separate thing.
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(`${okfs.origin}/`);
  await expect(banner(page)).toBeVisible();
  await expect(pane(page)).toContainText("# Field notes");
});

test("a folder's address drops what is only about a file", async ({ page, okfs }) => {
  await page.goto(`${okfs.origin}/deep/?focus=1&code&theme=nord`);
  await expect(page.getByRole("option", { name: /^readme\.txt/ })).toBeVisible();
  await expect(page).toHaveURL(`${okfs.origin}/deep/?theme=nord`);
  await expect(banner(page)).toBeVisible();
});
