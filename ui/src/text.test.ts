// A file's text in and out of the editor: its line endings and its byte-order mark are kept as they were found.

import { expect, test } from "bun:test";
import { linesChanged, linesSaved, mixedNote, pasted, readText, writeText } from "./text";

const bytes = (text: string) => new TextEncoder().encode(text);

test("a file is saved with the line endings and the byte-order mark it was read with", () => {
  const files = ["a\nb\n", "a\r\nb\r\n", "﻿a\nb", "﻿a\r\nb\r\n", "no newline at the end", "", "\n\n", "50%\r100%\n", 'id,note\r\n1,"a\rb"\r\n'];
  for (const file of files) {
    const read = readText(bytes(file));
    expect(read).not.toBeNull();
    if (!read) continue;
    expect(read.text.includes("\r\n")).toBe(false);
    expect(read.text.startsWith("﻿")).toBe(false);
    expect(writeText(read.text, read.form)).toBe(file);
  }
  // Lines the editor adds are written the file's way.
  const read = readText(bytes("﻿one\r\ntwo\r\n"));
  expect(read?.form).toEqual({ crlf: true, bom: true, mixed: 0 });
  expect(writeText(`${read?.text}three\n`, read?.form ?? { crlf: false, bom: false, mixed: 0 })).toBe("﻿one\r\ntwo\r\nthree\r\n");
  // A lone \r is a character of a line, not the end of one.
  expect(readText(bytes("50%\r100%\n"))?.text).toBe("50%\r100%\n");
  expect(readText(bytes('id,note\r\n1,"a\rb"\r\n'))?.text).toBe('id,note\n1,"a\rb"\n');
  // A file that mixes them keeps the one it has more of.
  expect(readText(bytes("a\r\nb\r\nc\n"))?.form.crlf).toBe(true);
  expect(readText(bytes("a\nb\nc\r\n"))?.form.crlf).toBe(false);
});

test("bytes that are not UTF-8 are not text the editor opens", () => {
  expect(readText(new Uint8Array([0xff, 0xfe, 0x00, 0x41]))).toBeNull();
  expect(readText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xc3]))).toBeNull();
});

test("the lines changed are counted from the first that differs to the last", () => {
  expect(linesChanged("a\nb\nc", "a\nb\nc")).toBe(0);
  expect(linesChanged("a\nb\nc", "a\nB\nc")).toBe(1);
  expect(linesChanged("a\nb\nc", "a\nb\nx\ny\nc")).toBe(2);
  expect(linesChanged("a\nb\nc\nd", "a\nd")).toBe(2);
  expect(linesChanged("a", "")).toBe(1);
});

test("a file that mixes line endings says so, and a change counts the endings a save makes the same", () => {
  const crlfs = readText(bytes("a\r\nb\r\nc\n"));
  const lfs = readText(bytes("x\ny\nz\r\n"));
  expect([crlfs?.form.mixed, lfs?.form.mixed]).toEqual([1, 1]);
  expect(crlfs && mixedNote(crlfs.form)).toBe("This file mixes CRLF and LF line endings. Saving writes CRLF at the end of every line.");
  expect(lfs && mixedNote(lfs.form)).toBe("This file mixes CRLF and LF line endings. Saving writes LF at the end of every line.");
  const one = readText(bytes("a\r\nb\r\n"));
  expect(one && mixedNote(one.form)).toBe("");
  if (!crlfs || !one) return;
  // Nothing changed is nothing to save; one line changed in a mixed file saves the other ending too, and the lines
  // from the first that differs to the last are counted.
  expect(linesSaved(crlfs, crlfs.text)).toBe(0);
  expect(linesSaved(crlfs, crlfs.text.replace("a", "A"))).toBe(3);
  expect(linesSaved(one, one.text.replace("a", "A"))).toBe(1);
  // A change to the line whose ending a save makes the file's own is that one line.
  expect(linesSaved(crlfs, crlfs.text.replace("c", "C"))).toBe(1);
  expect(linesSaved(crlfs, "a\nb\n")).toBe(1);
  expect(writeText(crlfs.text.replace("a", "A"), crlfs.form)).toBe("A\r\nb\r\nc\r\n");
});

test("text pasted or dropped into the editor ends its lines the editor's way, and keeps a lone carriage return", () => {
  expect(pasted("x\r\ny\r\n")).toBe("x\ny\n");
  expect(pasted("50%\r100%\n")).toBe("50%\r100%\n");
});
