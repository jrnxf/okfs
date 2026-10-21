// The preview of one file, had from the route that answers for several by path.

import { beforeAll, expect, test } from "bun:test";

/** What the server holds a preview of, by path. */
const previews: Record<string, unknown> = {
  "a b.md": { kind: "markdown", html: "<p>a</p>" },
  "sub/c.rs": { kind: "code" },
};
Object.assign(globalThis, {
  location: { pathname: "/", search: "", href: "http://localhost/" },
  fetch: (url: string) => {
    const at = new URL(url, "http://localhost/");
    const paths = at.pathname === "/api/previews" ? at.searchParams.getAll("p").filter((p) => p in previews) : [];
    const body = Object.fromEntries(paths.map((path) => [path, previews[path]]));
    return Promise.resolve(new Response(JSON.stringify(body)));
  },
});

let api: typeof import("./api");
beforeAll(async () => {
  api = await import("./api");
});

test("one file's preview is taken out of the answer for it, and one with none fails as a missing file", async () => {
  for (const path of ["a b.md", "sub/c.rs"]) {
    for (const url of [api.urls.preview(path), api.urls.source(path), `${api.urls.preview(path)}&lines=80`]) {
      expect(url.startsWith("/api/previews?p=")).toBe(true);
      expect(api.pathOf(url)).toBe(path);
      expect(await api.getAnswer(url)).toEqual(previews[path]);
    }
  }
  const missing = api.getAnswer(api.urls.preview("gone.md"));
  await expect(missing).rejects.toBeInstanceOf(api.HttpError);
  await expect(missing).rejects.toMatchObject({ status: 404 });
  // Any other address is answered as it is.
  expect(await api.getAnswer(api.urls.list(""))).toEqual({});
  expect(api.urls.thumb("p.png", 160, 1, 2)).toBe("/api/picture?path=p.png&w=160&m=1&s=2");
});
