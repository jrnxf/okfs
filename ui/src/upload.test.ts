// The queue of uploads: a few at a time, never over a name that is taken, and the visitor's choice when one is.

import { beforeAll, beforeEach, expect, test } from "bun:test";

/** The files the server holds, by path, with their contents. */
let disk = new Map<string, string>();
/** The requests that were sent, as method, address and the header that says what the write is for. */
let sent: string[] = [];
/** The highest number of uploads on their way at once. */
let most = 0;
let open = 0;
/** Names the server hides from a look before an upload, as if they were taken only after it. */
let unseen = new Set<string>();
/** How long the server takes to make a folder, in milliseconds. */
let folderTakes = 0;

/** A server in the page: it answers each upload a moment after it is sent, as the real one does. */
class FakeRequest {
  status = 0;
  responseText = "";
  upload: { onprogress?: (event: { loaded: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  private method = "";
  private url = "";
  private headers: Record<string, string> = {};
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getResponseHeader() {
    return null;
  }
  send(body: Blob) {
    const at = new URL(this.url, "http://localhost/");
    const path = at.searchParams.get("path") ?? "";
    const want = this.headers["if-match"] ?? this.headers["if-none-match"];
    sent.push(`${this.method} ${path}${at.searchParams.get("keep") ? " keep" : ""} ${want}`);
    open++;
    most = Math.max(most, open);
    setTimeout(async () => {
      open--;
      const text = await body.text();
      const answer = (status: number, json: unknown) => {
        this.status = status;
        this.responseText = JSON.stringify(json);
        this.onload?.();
      };
      this.upload.onprogress?.({ loaded: body.size });
      let landed = path;
      if (this.headers["if-none-match"] === "*" && disk.has(path)) {
        if (!at.searchParams.get("keep")) return answer(412, { error: "taken", etag: `"${path}"`, s: 3, m: 1 });
        const dot = path.lastIndexOf(".");
        for (let copy = 1; disk.has(landed); copy++) landed = `${path.slice(0, dot)} (${copy})${path.slice(dot)}`;
      }
      if (this.headers["if-match"] && this.headers["if-match"] !== `"${path}"`) return answer(412, { error: "changed" });
      disk.set(landed, text);
      answer(this.headers["if-match"] ? 200 : 201, { path: landed, etag: `"${landed}"`, s: text.length, m: 2 });
    }, 1);
  }
}

Object.assign(globalThis, {
  location: { pathname: "/", search: "", href: "http://localhost/" },
  XMLHttpRequest: FakeRequest,
  fetch: async (url: string, init: RequestInit = {}) => {
    const at = new URL(url, "http://localhost/");
    if (init.method === "HEAD") {
      const path = at.pathname.replace(/^\/raw\//, "").split("/").map(decodeURIComponent).join("/");
      sent.push(`HEAD ${path}`);
      const text = unseen.has(path) ? undefined : disk.get(path);
      // A folder without an --index file is not found here, as on the real server.
      if (!text) return new Response(null, { status: 404 });
      const headers = { etag: `"${path}"`, "content-length": String(text.length), "last-modified": new Date(1000).toUTCString() };
      return new Response(null, { headers });
    }
    const path = at.searchParams.get("path") ?? "";
    sent.push(`${init.method ?? "GET"} ${path}`);
    if (at.pathname === "/api/list") return new Response("{}", { status: !unseen.has(path) && disk.get(path) === "" ? 200 : 404 });
    if (init.method !== "POST") return new Response("{}");
    await new Promise((done) => setTimeout(done, folderTakes));
    if (disk.has(path)) return new Response(JSON.stringify({ error: "taken", d: !disk.get(path) }), { status: 412 });
    disk.set(path, "");
    return new Response(JSON.stringify({ path }), { status: 201 });
  },
});

let upload: typeof import("./upload");
let config: typeof import("./config").config;
beforeAll(async () => {
  upload = await import("./upload");
  config = (await import("./config")).config;
});

beforeEach(() => {
  disk = new Map([["notes/taken.csv", "old"], ["notes/also.csv", "old"]]);
  sent = [];
  most = 0;
  open = 0;
  unseen = new Set();
  folderTakes = 0;
  Object.assign(config, { upload: true, edit: false, max_upload: undefined });
});

const file = (name: string, text = "new") => new File([text], name, { lastModified: 3000 });
const into = (dir: string, ...names: string[]) => names.map((name) => ({ file: file(name), dir, name }));

/** Waits until every upload has finished or one waits on the visitor. */
/**
 * Waits until no file is waiting or on its way: every one has finished, or waits on the visitor. A file that is not
 * asked about goes on while another is, so the dialog coming up is not enough.
 */
async function settled(queue: import("./upload").Uploads): Promise<void> {
  const moving = () => queue.jobs.some((job) => job.state === "waiting" || job.state === "sending");
  for (let turn = 0; turn < 500 && moving(); turn++) await new Promise((done) => setTimeout(done, 2));
}

const states = (queue: import("./upload").Uploads) => queue.jobs.map((job) => `${job.name} ${job.state}${job.path ? ` ${job.path}` : ""}`);

test("files go a few at a time, each lands as itself, and the folders come first", async () => {
  const queue = new upload.Uploads();
  await queue.add(into("notes/new", "a.txt", "b.txt", "c.txt", "d.txt", "e.txt"), ["notes/new"]);
  await settled(queue);
  expect(sent[0]).toBe("POST notes/new");
  expect(most).toBe(3);
  expect(states(queue)).toEqual(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"].map((name) => `${name} done notes/new/${name}`));
  expect(disk.get("notes/new/e.txt")).toBe("new");
  expect(queue.progress()).toEqual({ done: 5, all: 5 });
  queue.clear();
});

test("a name that is taken waits for the visitor, and nothing is replaced without asking", async () => {
  const queue = new upload.Uploads();
  await queue.add(into("notes", "taken.csv", "fresh.csv"));
  await settled(queue);
  expect(queue.asking?.job.name).toBe("taken.csv");
  expect(queue.asking?.clash).toMatchObject({ etag: '"notes/taken.csv"', s: 3 });
  // Without --allow-edit there is no replacing.
  expect(upload.replaceable(queue.asking?.clash ?? { error: "" })).toBe(false);
  expect(disk.get("notes/taken.csv")).toBe("old");
  expect(states(queue)).toContain("fresh.csv done notes/fresh.csv");

  queue.choose("keep", false);
  await settled(queue);
  expect(states(queue)).toContain("taken.csv done notes/taken (1).csv");
  expect(disk.get("notes/taken.csv")).toBe("old");
  expect(disk.get("notes/taken (1).csv")).toBe("new");
  queue.clear();
});

test("one choice for every name that is taken skips them all, or with --allow-edit replaces them", async () => {
  const queue = new upload.Uploads();
  await queue.add(into("notes", "taken.csv", "also.csv"));
  await settled(queue);
  expect(queue.others()).toBe(1);
  queue.choose("skip", true);
  await settled(queue);
  expect(queue.asking).toBeNull();
  expect(states(queue)).toEqual(["taken.csv skipped", "also.csv skipped"]);
  queue.clear();

  config.edit = true;
  await queue.add(into("notes", "taken.csv", "also.csv"));
  await settled(queue);
  expect(upload.replaceable(queue.asking?.clash ?? { error: "" })).toBe(true);
  queue.choose("replace", true);
  await settled(queue);
  expect(states(queue)).toEqual(["taken.csv done notes/taken.csv", "also.csv done notes/also.csv"]);
  expect(disk.get("notes/taken.csv")).toBe("new");
  // Each replace named the version it replaces.
  expect(sent).toContain('PUT notes/taken.csv "notes/taken.csv"');
  queue.clear();
});

test("a file larger than --max-upload is refused before it is sent, and a folder that cannot be made fails its files", async () => {
  config.max_upload = 2;
  const queue = new upload.Uploads();
  await queue.add(into("notes", "big.txt"));
  expect(states(queue)).toEqual(["big.txt failed"]);
  expect(queue.jobs[0]?.why).toContain("--max-upload");
  expect(sent).toEqual([]);
  queue.clear();

  config.max_upload = undefined;
  disk.set("notes/sub", "a file");
  await queue.add(into("notes/sub", "in.txt"), ["notes/sub"]);
  await settled(queue);
  expect(states(queue)).toEqual(["in.txt failed"]);
  expect(sent.filter((line) => line.startsWith("PUT"))).toEqual([]);
  queue.clear();
});

test("a name that is taken is found before any of the file is sent, and the server's refusal still stops one taken since", async () => {
  const queue = new upload.Uploads();
  await queue.add(into("notes", "taken.csv"));
  await settled(queue);
  expect(sent).toEqual(["HEAD notes/taken.csv"]);
  expect(queue.asking?.clash).toMatchObject({ etag: '"notes/taken.csv"', s: 3, m: 1 });
  queue.choose("skip", false);
  await settled(queue);
  queue.clear();

  unseen.add("notes/also.csv");
  sent = [];
  await queue.add(into("notes", "also.csv"));
  await settled(queue);
  expect(sent).toEqual(["HEAD notes/also.csv", "GET notes/also.csv", "PUT notes/also.csv *"]);
  expect(queue.asking?.clash).toMatchObject({ etag: '"notes/also.csv"' });
  expect(disk.get("notes/also.csv")).toBe("old");
  queue.choose("skip", false);
  await settled(queue);
  queue.clear();
});

test("a folder of the same name is found before the file is sent, and cannot be replaced", async () => {
  config.edit = true;
  disk.set("notes/dir", "");
  const queue = new upload.Uploads();
  await queue.add(into("notes", "dir"));
  await settled(queue);
  expect(queue.asking?.clash.d).toBe(true);
  expect(upload.replaceable(queue.asking?.clash ?? { error: "" })).toBe(false);
  expect(sent.filter((line) => line.startsWith("PUT"))).toEqual([]);
  queue.choose("skip", false);
  queue.clear();
});

test("the files a choice for every taken name sends go a few at a time", async () => {
  const names = ["1.csv", "2.csv", "3.csv", "4.csv", "5.csv", "6.csv", "7.csv"];
  for (const name of names) disk.set(`notes/${name}`, "old");
  const queue = new upload.Uploads();
  await queue.add(into("notes", ...names));
  await settled(queue);
  expect(queue.others()).toBe(names.length - 1);
  most = 0;
  queue.choose("keep", true);
  await settled(queue);
  expect(most).toBe(3);
  expect(states(queue)).toEqual(names.map((name) => `${name} done notes/${name.replace(".csv", " (1).csv")}`));
  queue.clear();
});

test("no file of a drop starts before its folders are made, even when an earlier upload ends meanwhile", async () => {
  folderTakes = 5;
  const queue = new upload.Uploads();
  await queue.add(into("notes", "first.txt"));
  await queue.add(into("notes/a/b", "late.txt"), ["notes/a", "notes/a/b"]);
  await settled(queue);
  expect(sent.indexOf("PUT notes/a/b/late.txt *")).toBeGreaterThan(sent.indexOf("POST notes/a/b"));
  expect(states(queue)).toEqual(["first.txt done notes/first.txt", "late.txt done notes/a/b/late.txt"]);
  queue.clear();
});

test("a copy is numbered before its extension, as the server numbers it", () => {
  expect(upload.numbered("tides.csv", 1)).toBe("tides (1).csv");
  expect(upload.numbered("Makefile", 2)).toBe("Makefile (2)");
  expect(upload.numbered(".env", 3)).toBe(".env (3)");
});
