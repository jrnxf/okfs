// What a screen reader is told about a row of the file list.

import * as fmt from "./fmt";
import { LABEL } from "./kinds";
import type { Entry } from "./store";

/** The id of the row at `index`. */
export const rowId = (index: number): string => `row-${index}`;

/** What a screen reader says for a row: "src, folder, 1 item" or "notes.md, Markdown, 2.1 KB". */
export function rowName(entry: Pick<Entry, "name" | "dir" | "kind" | "count" | "size" | "link">): string {
  const link = entry.link ? ", link" : "";
  if (entry.dir) return `${entry.name}, folder${link}${entry.count === undefined ? "" : `, ${fmt.items(entry.count)}`}`;
  return `${entry.name}, ${LABEL[entry.kind]}${link}, ${fmt.size(entry.size)}`;
}
