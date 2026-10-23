// The queue of uploads: a few at a time, never over a name that is taken, and the visitor's choice when one is.

import { beforeAll, beforeEach, expect, test } from "bun:test";

/** The files the server holds, by path, with their contents. */
let disk = new Map<string, string>();
/** The requests that were sent, as method, address and the header that says what the write is for. */
let sent: string[] = [];
/** The highest number of uploads on their way at once. */
let most = 0;
let open = 0;

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
  fetch: (url: string, init: RequestInit = {}) => {
    const path = new URL(url, "http://localhost/").searchParams.get("path") ?? "";
    sent.push(`${init.method ?? "GET"} ${path}`);
    if (init.method !== "POST") return Promise.resolve(new Response("{}"));
    if (disk.has(path)) return Promise.resolve(new Response(JSON.stringify({ error: "taken", d: !disk.get(path) }), { status: 412 }));
    disk.set(path, "");
    return Promise.resolve(new Response(JSON.stringify({ path }), { status: 201 }));
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
  Object.assign(config, { upload: true, edit: false, max_upload: undefined });
});

const file = (name: string, text = "new") => new File([text], name, { lastModified: 3000 });
const into = (dir: string, ...names: string[]) => names.map((name) => ({ file: file(name), dir, name }));

/** Waits until every upload has finished or one waits on the visitor. */
async function settled(queue: import("./upload").Uploads): Promise<void> {
  for (let turn = 0; turn < 200 && queue.busy() && !queue.asking; turn++) await new Promise((done) => setTimeout(done, 2));
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

test("a copy is numbered before its extension, as the server numbers it", () => {
  expect(upload.numbered("tides.csv", 1)).toBe("tides (1).csv");
  expect(upload.numbered("Makefile", 2)).toBe("Makefile (2)");
  expect(upload.numbered(".env", 3)).toBe(".env (3)");
});
