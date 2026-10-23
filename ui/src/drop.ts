// Turning what a drop or the file picker hands the page into files to upload, and the folders to make for them.

import { joinPath, parentOf } from "./api";
import type { Picked } from "./upload";

/** A file, by its path under the folder it was dropped or picked into: `photos/2025/boat.jpg`. */
export interface Held {
  file: File;
  rel: string;
}

/** What to upload: the files, the folders to make first, a folder before what is in it, and what was left out. */
export interface Plan {
  picked: Picked[];
  folders: string[];
  leftOut: number;
}

/** Folders that only `--hidden` would show, and what is in them, are left out, as the server would refuse them. */
const hidden = (name: string, showsHidden: boolean): boolean => !showsHidden && name.startsWith(".");

/**
 * Plans the upload of files by their paths into `dir`. Every folder on the way to a file is made first, a level at a
 * time. A file or a folder whose name starts with a dot is left out, with all under it, unless dotfiles are served.
 * `empty` are folders that hold nothing, to be made too.
 */
export function plan(held: Held[], dir: string, showsHidden: boolean, empty: string[] = []): Plan {
  const folders = new Set<string>();
  const picked: Picked[] = [];
  let leftOut = 0;
  const add = (rel: string): boolean => {
    const parts = rel.split("/").filter(Boolean);
    if (parts.some((part) => hidden(part, showsHidden))) {
      leftOut++;
      return false;
    }
    for (let depth = 1; depth < parts.length; depth++) folders.add(joinPath(dir, parts.slice(0, depth).join("/")));
    return true;
  };
  for (const { file, rel } of held) {
    if (!add(rel)) continue;
    const path = joinPath(dir, rel.split("/").filter(Boolean).join("/"));
    picked.push({ file, dir: parentOf(path), name: path.slice(path.lastIndexOf("/") + 1) });
  }
  // A folder that holds nothing is made all the same: the trailing slash keeps its own name out of the files.
  for (const rel of empty) if (add(`${rel}/`)) folders.add(joinPath(dir, rel));
  // A folder before what is in it: a shorter path is never under a longer one.
  const order = [...folders].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return { picked, folders: order, leftOut };
}

/** Reads one file of a dropped folder. */
const fileOf = (entry: FileSystemFileEntry): Promise<File> => new Promise((resolve, reject) => entry.file(resolve, reject));

/** Reads every entry of a dropped folder: a browser hands them over a batch at a time. */
async function entriesOf(folder: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = folder.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/**
 * What a drop holds, with each file's path under the drop and the folders that hold nothing. The entries are taken
 * from the drop at once, as a browser lets them be read only while the drop event runs; they are read after.
 */
export function heldIn(data: DataTransfer): Promise<{ held: Held[]; empty: string[] }> {
  const entries = [...data.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.() ?? null);
  // A browser without folder entries hands the files alone.
  if (entries.some((entry) => entry === null)) {
    return Promise.resolve({ held: [...data.files].map((file) => ({ file, rel: file.name })), empty: [] });
  }
  return (async () => {
    const held: Held[] = [];
    const empty: string[] = [];
    const walk = async (entry: FileSystemEntry, rel: string): Promise<void> => {
      if (entry.isFile) {
        held.push({ file: await fileOf(entry as FileSystemFileEntry), rel });
        return;
      }
      const inside = await entriesOf(entry as FileSystemDirectoryEntry);
      if (!inside.length) empty.push(rel);
      for (const child of inside) await walk(child, `${rel}/${child.name}`);
    };
    for (const entry of entries) if (entry) await walk(entry, entry.name);
    return { held, empty };
  })();
}

/** What the file picker hands over: each file by its path under the folder picked, or by its name alone. */
export const heldPicked = (files: FileList): Held[] => [...files].map((file) => ({ file, rel: file.webkitRelativePath || file.name }));
