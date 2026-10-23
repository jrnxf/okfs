// A file's text as the editor holds it and as it is saved: the editor keeps lines joined by `\n`, and the file keeps
// the line endings and the byte-order mark it was found with. A lone `\r` is not a line ending: it stays in the text.

/**
 * How a file writes its text: with `\r\n` line endings, and with a byte-order mark in front. `mixed`: how many of the
 * endings it was found with are not its own, which a save writes its way.
 */
export interface Form {
  crlf: boolean;
  bom: boolean;
  mixed: number;
}

/** The largest file the editor opens: the most of a file a preview reads, too. */
export const MAX_EDIT = 2 * 1024 * 1024;

/**
 * The text of a file's bytes, for the editor, with how it is written. `null` when the bytes are not UTF-8 text. A
 * file with more `\r\n` endings than lone `\n` ones keeps `\r\n`.
 */
export function readText(bytes: Uint8Array): { text: string; form: Form } | null {
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  const bom = raw.startsWith("﻿");
  const body = bom ? raw.slice(1) : raw;
  const crlfs = body.match(/\r\n/g)?.length ?? 0;
  const lfs = body.match(/(?<!\r)\n/g)?.length ?? 0;
  const crlf = crlfs > lfs;
  return { text: body.replace(/\r\n/g, "\n"), form: { crlf, bom, mixed: Math.min(crlfs, lfs) } };
}

/** Text pasted or dropped into the editor, with its `\r\n` endings made the editor's `\n`. A lone `\r` stays. */
export function pasted(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** What the editor says of a file that mixes line endings, which a save makes all the same. Empty for any other file. */
export function mixedNote(form: Form): string {
  if (!form.mixed) return "";
  return `This file mixes CRLF and LF line endings. Saving writes ${form.crlf ? "CRLF" : "LF"} at the end of every line.`;
}

/** How many lines a save changes: those that differ, and with any change the endings it makes the file's own. */
export function linesSaved(before: string, after: string, form: Form): number {
  const changed = linesChanged(before, after);
  return changed && changed + form.mixed;
}

/** The bytes to save for the editor's text, written the way the file was found. */
export function writeText(text: string, form: Form): string {
  const lines = form.crlf ? text.replace(/\n/g, "\r\n") : text;
  return form.bom ? `﻿${lines}` : lines;
}

/**
 * How many lines differ between two texts, counted from the first line that differs to the last: what is the same at
 * the start and at the end is not counted. Zero when they are the same.
 */
export function linesChanged(before: string, after: string): number {
  if (before === after) return 0;
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return Math.max(a.length - start - end, b.length - start - end, 1);
}
