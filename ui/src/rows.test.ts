import { expect, test } from "bun:test";
import { rowId, rowName } from "./rows";

// Twelve minutes ago, so the age cell says "12m".
const mtime = Math.floor(Date.now() / 1000) - 12 * 60 - 5;
const base = { name: "x", dir: false, kind: "text", count: undefined, size: 0, link: false, mtime } as const;

test("a row's id follows its index", () => {
  expect(rowId(0)).toBe("row-0");
  expect(rowId(41)).toBe("row-41");
});

test("a folder is named by what it shows, then with how much it holds", () => {
  expect(rowName({ ...base, name: "src", dir: true, kind: "folder", count: 1 })).toBe("src, 1, 12m, folder, 1 item");
  expect(rowName({ ...base, name: "src", dir: true, kind: "folder", count: 0 })).toBe("src, 0, 12m, folder, 0 items");
  expect(rowName({ ...base, name: "src", dir: true, kind: "folder", count: 1234 })).toBe("src, 1,234, 12m, folder, 1,234 items");
  expect(rowName({ ...base, name: "src", dir: true, kind: "folder" })).toBe("src, 12m, folder");
});

test("a file is named by what it shows, then with its kind", () => {
  expect(rowName({ ...base, name: "notes.md", kind: "md", size: 2150 })).toMatch(/^notes\.md, 2\.1 KB, 12m, .+$/);
  expect(rowName({ ...base, name: "a.png", kind: "image", size: 3, mtime: 0 })).toMatch(/^a\.png, 3 B, [^,]+$/);
});

test("a match says its folder after its name, as the row shows it", () => {
  expect(rowName({ ...base, name: "a.txt", size: 3 }, "docs/old")).toMatch(/^a\.txt, docs\/old, 3 B, 12m, .+$/);
});

test("a link says it is one", () => {
  expect(rowName({ ...base, name: "ln", dir: true, kind: "folder", count: 2, link: true })).toBe("ln, 2, 12m, folder, link, 2 items");
  expect(rowName({ ...base, name: "a.txt", link: true, size: 3 })).toMatch(/^a\.txt, 3 B, 12m, .+, link$/);
});
