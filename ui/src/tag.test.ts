// A tag read through a proxy that compresses is okfs's own tag again, so a page's own save is known as its own.
import { expect, test } from "bun:test";
import { tagIn } from "./api";

const tagged = (etag?: string): Response => new Response(null, { headers: etag ? { etag } : {} });

test("a coding a proxy added to the tag, and a weak mark, come off", () => {
  for (const coding of ["gzip", "zstd", "br", "deflate"]) expect(tagIn(tagged(`"18e8a3-4f41-${coding}"`))).toBe('"18e8a3-4f41"');
  expect(tagIn(tagged('W/"18e8a3-4f41-gzip"'))).toBe('"18e8a3-4f41"');
  expect(tagIn(tagged('"18e8a3-4f41"'))).toBe('"18e8a3-4f41"');
});

test("another version stays another version, and an answer with no tag has none", () => {
  expect(tagIn(tagged('"18e8a3-4f49-zstd"'))).not.toBe('"18e8a3-4f41"');
  expect(tagIn(tagged())).toBeNull();
});
