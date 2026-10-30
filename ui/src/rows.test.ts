import { expect, test } from "bun:test";
import { rowId, rowName } from "./rows";

const base = { name: "x", dir: false, kind: "text", count: undefined, size: 0, link: false } as const;

test("a row's id follows its index", () => {
  expect(rowId(0)).toBe("row-0");
  expect(rowId(41)).toBe("row-41");
});

test("a folder is named with how much it holds", () => {
  expect(rowName({ ...base, name: "src", dir: true, kind: "folder", count: 1 })).toBe("src, folder, 1 item");
  expect(rowName({ ...base, name: "src", dir: true, kind: "folder", count: 0 })).toBe("src, folder, 0 items");
  expect(rowName({ ...base, name: "src", dir: true, kind: "folder", count: 1234 })).toBe("src, folder, 1,234 items");
  expect(rowName({ ...base, name: "src", dir: true, kind: "folder" })).toBe("src, folder");
});

test("a file is named with its kind and size", () => {
  expect(rowName({ ...base, name: "notes.md", kind: "md", size: 2150 })).toMatch(/^notes\.md, .+, 2\.1 KB$/);
  expect(rowName({ ...base, name: "a.png", kind: "image", size: 3 })).toMatch(/^a\.png, .+, 3 B$/);
});

test("a link says it is one", () => {
  expect(rowName({ ...base, name: "ln", dir: true, kind: "folder", count: 2, link: true })).toBe("ln, folder, link, 2 items");
  expect(rowName({ ...base, name: "a.txt", link: true, size: 3 })).toMatch(/^a\.txt, .+, link, 3 B$/);
});
