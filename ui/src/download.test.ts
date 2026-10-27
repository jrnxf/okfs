// A link that saves its file names it after the file, not "true".

import { expect, test } from "bun:test";
import { Glob } from "bun";

test("every link with `download` gives it an empty name, so the file keeps its own", async () => {
  // Preact writes a bare `download` as download="true", which Safari takes as the name to save a zip under and Chrome
  // as the name of a file sent without one. An empty value leaves the name to the server's Content-Disposition, or
  // to the address.
  const bare: string[] = [];
  for await (const file of new Glob("*.tsx").scan(import.meta.dir)) {
    const lines = (await Bun.file(`${import.meta.dir}/${file}`).text()).split("\n");
    lines.forEach((line, i) => {
      if (/\sdownload(?=\s+[\w-]+=|\s*\/?>)/.test(line)) bare.push(`${file}:${i + 1}`);
    });
  }
  expect(bare).toEqual([]);
});
