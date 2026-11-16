// What a row of the file list shows in its cells, and what a screen reader is told about it.

import * as fmt from "./fmt";
import { LABEL } from "./kinds";
import type { Entry } from "./store";

type Named = Pick<Entry, "name" | "dir" | "kind" | "count" | "size" | "link" | "mtime">;

/** The id of the row at `index`. */
export const rowId = (index: number): string => `row-${index}`;

/** The size cell: a file's size, or how many items a folder holds (blank when it is not known). */
export const sizeCell = (entry: Pick<Entry, "dir" | "count" | "size">): string =>
  entry.dir ? (entry.count === undefined ? "" : fmt.count(entry.count)) : fmt.size(entry.size);

/** The age cell: "now", "12m", "3h", "5d" or a date, and blank when the time is not known. */
export const ageCell = (entry: Pick<Entry, "mtime">): string => (entry.mtime ? fmt.rel(entry.mtime) : "");

/**
 * What a screen reader says for a row. It starts with the row's visible text, in the same order (the name, the folder
 * of a match, the size and the age), so a person who speaks what they see names the row, and then says the kind,
 * which the row shows only as an icon: "src, 1, 12m, folder, 1 item" or "notes.md, 2.1 KB, 3h, Markdown".
 */
export function rowName(entry: Named, folder?: string): string {
  const shown = [entry.name, folder, sizeCell(entry), ageCell(entry)].filter(Boolean);
  const link = entry.link ? ", link" : "";
  const kind = entry.dir ? `folder${link}${entry.count === undefined ? "" : `, ${fmt.items(entry.count)}`}` : `${LABEL[entry.kind]}${link}`;
  return `${shown.join(", ")}, ${kind}`;
}
