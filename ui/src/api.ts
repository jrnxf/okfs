// The server's endpoints, as the page sees them.

import { showsHidden } from "./hidden";
import { call, heard } from "./reach";

export interface Item {
  n: string;
  d?: boolean;
  /** A link. Deleting it removes the link and leaves what it points at. */
  l?: boolean;
  s: number;
  m: number;
  /** For a folder, how many entries it holds, hidden ones only while they are shown. */
  c?: number;
  /** For a folder, how many hidden entries it holds, while they are not shown. */
  h?: number;
}

export interface Readme {
  name: string;
  html: string;
}

export interface Listing {
  path: string;
  /** Where the folder really is, when a link was followed to reach it. Changes on disk are told by this path. */
  real?: string;
  /** The folder is reached through a link. Deleting it removes the link only. Sent with a whole listing only. */
  link?: boolean;
  /** The folder's own modified time, in seconds. */
  m: number;
  entries: Item[];
  /** The entries in the folder, past those sent, and none of those hidden. */
  total: number;
  /** The entries hidden from it: see `showsHidden`. */
  hidden?: number;
  /** How many names in it are not text, so okfs cannot show them. */
  unreadable?: number;
  readme: Readme | null;
  /** The listing of the entry followed, the first unless another was named, when levels were asked for and it is a folder. */
  under?: Listing;
}

export type TextPreview =
  | { kind: "markdown"; html: string; lines: number }
  | { kind: "code"; html: string; lines: number; highlighted: boolean; more?: boolean; cut?: boolean }
  | { kind: "table"; head: string[]; rows: string[][]; numeric: boolean[]; total: number }
  | { kind: "json"; text: string; lines: number }
  | { kind: "none"; reason: "binary" };

export interface Hit {
  path: string;
  dir: boolean;
  /** Matched characters, counted in characters of the name or of the whole path. */
  idx: number[];
  name: boolean;
  /** Modified time in seconds, and size in bytes. Zero for a folder, and for a link. */
  m: number;
  s: number;
  /** For a folder, how many entries its listing shows. */
  c?: number;
}

/** The orders the matches can come in: the best first, or by one of these. */
export type MatchOrder = "rank" | "name" | "folder" | "size" | "time";

/** One page of the matches: `limit` of them after the first `offset`, in `sort`, turned around with `rev`. */
export interface MatchPage {
  offset: number;
  limit: number;
  sort: MatchOrder;
  rev: boolean;
}

export interface Found {
  hits: Hit[];
  total: number;
  indexed: number;
  ready: boolean;
  /** How long the server searched, in milliseconds. */
  took: number;
}

/** A file among the most recently written, with its time in seconds. */
export interface Changed {
  path: string;
  m: number;
}

export interface Recent {
  /** Newest first. */
  files: Changed[];
}

export interface Archive {
  entries: { name: string; size: number; dir: boolean }[];
  total: number;
}

/** First path segments that belong to the server. A served name that collides goes behind `/-/`. */
const RESERVED = new Set(["api", "raw", "zip", "assets", "theme.css", "-"]);

const encode = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** Hidden entries are asked for too while they are shown. Every answer that lists names says which it holds. */
const all = (): string => (showsHidden() ? "&all=1" : "");

export const urls = {
  /**
   * With `limit`, the first entries only; with `depth`, also the folders the first entry leads to, that many levels
   * down. `follow` names the entry to go into in place of the first, a level after another.
   */
  list: (path: string, limit?: number, depth?: number, follow: string[] = []) =>
    `/api/list?path=${encodeURIComponent(path)}${limit ? `&limit=${limit}` : ""}${depth ? `&depth=${depth}` : ""}` +
    `${follow.length ? `&follow=${encodeURIComponent(follow.join("/"))}` : ""}${all()}`,
  /** The preview of one file: `getAnswer` takes it out of the answer, which holds it under its path. */
  preview: (path: string) => `/api/previews?p=${encodeURIComponent(path)}`,
  /** The text of a file as it is written, as source code, whatever the file is. */
  source: (path: string) => `/api/previews?p=${encodeURIComponent(path)}&raw=1`,
  /** Several text files in one answer, by path, source code cut to its first `lines` lines. */
  previews: (paths: string[], lines: number, source = false) =>
    `/api/previews?lines=${lines}${source ? "&raw=1" : ""}&${paths.map((path) => `p=${encodeURIComponent(path)}`).join("&")}`,
  archive: (path: string) => `/api/archive?path=${encodeURIComponent(path)}`,
  /** The best matches for the palette; with `page`, any page of them in any order. */
  search: (query: string, page?: MatchPage) =>
    `/api/search?q=${encodeURIComponent(query)}${all()}` +
    (page
      ? `&offset=${page.offset}&limit=${page.limit}${page.sort === "rank" ? "" : `&sort=${page.sort}`}${page.rev ? "&rev=1" : ""}`
      : ""),
  recent: () => `/api/recent${showsHidden() ? "?all=1" : ""}`,
  /** The time and size make a rewritten picture a new address: the browser keeps a thumbnail by its address. */
  thumb: (path: string, width: number, modified: number, size: number) =>
    `/api/picture?path=${encodeURIComponent(path)}&w=${width}&m=${modified}&s=${size}`,
  /** A picture whole, as a PNG or a JPEG: see `decodedByServer`. */
  picture: (path: string) => `/api/picture?path=${encodeURIComponent(path)}`,
  /** The stream of changes to the served folder. */
  events: "/api/events",
  /** A small answer, to learn whether okfs is there and takes the page's key. */
  probe: "/assets/favicon.svg",
  /** One entry, for deleting it. */
  entry: (path: string, forever = false) => `/api/entry?path=${encodeURIComponent(path)}${forever ? "&forever=1" : ""}`,
  /** The Trash: what it holds, and with `id` or `all`, what to delete from it for good. */
  trash: (id?: string, all = false) =>
    `/api/trash${id !== undefined ? `?id=${encodeURIComponent(id)}` : all ? "?all=1" : ""}`,
  restore: (id: string) => `/api/trash/restore?id=${encodeURIComponent(id)}`,
  /** A move or a rename, and a copy, from one path to another. `keep`: under the first free name like it when it is taken. */
  move: (from: string, to: string, keep = false) =>
    `/api/move?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${keep ? "&keep=1" : ""}`,
  copy: (from: string, to: string, keep = false) =>
    `/api/copy?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${keep ? "&keep=1" : ""}`,
  /** One file, for writing it. With `keep`, a name that is taken gives way to the next free one. */
  file: (path: string, keep = false) => `/api/file?path=${encodeURIComponent(path)}${keep ? "&keep=1" : ""}`,
  /** One folder, for making it. */
  folder: (path: string) => `/api/folder?path=${encodeURIComponent(path)}`,
  raw: (path: string) => `/raw/${encode(path)}`,
  /** A page to show in a frame. The server sends it on to an address its own images and scripts load from. */
  frame: (path: string) => `/api/frame/${encode(path)}`,
  zip: (path: string) => `/zip/${encode(path)}${showsHidden() ? "?all=1" : ""}`,
  /** The shareable address of a folder or of an open file. */
  view(path: string, dir: boolean): string {
    if (!path) return "/";
    const first = path.split("/", 1)[0] ?? "";
    return `${RESERVED.has(first) ? "/-/" : "/"}${encode(path)}${dir ? "/" : ""}`;
  },
};

/** The query of the matches an address shows, from its `?find=`, or `null` when it shows none. */
export const findOf = (search: string): string | null => new URLSearchParams(search).get("find");

/** An address's query with its `?find=` set to `find`, or taken out without one. The rest, such as `?theme=`, stays. */
export function withFind(search: string, find?: string): string {
  const params = new URLSearchParams(search);
  params.delete("find");
  if (find !== undefined) params.set("find", find);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Reads the address bar back into a path and whether it names a folder. */
export function parseLocation(): { path: string; dir: boolean } {
  const pathname = location.pathname.replace(/^\/-(\/|$)/, "/");
  const parts = pathname.split("/").filter(Boolean);
  let path: string;
  try {
    path = parts.map(decodeURIComponent).join("/");
  } catch {
    path = parts.join("/");
  }
  return { path, dir: pathname.endsWith("/") || !path };
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await call(url, { signal });
  if (!response.ok) throw new HttpError(response.status);
  return (await response.json()) as T;
}

/**
 * What an address of the server answers. The preview of one file comes from `/api/previews`, which answers
 * with each file's preview under its path: that one is taken out, and a file with none fails as a missing one.
 */
export async function getAnswer<T>(url: string, signal?: AbortSignal): Promise<T> {
  const at = new URL(url, location.href);
  if (at.pathname !== "/api/previews") return getJson<T>(url, signal);
  const all = await getJson<Record<string, T>>(url, signal);
  const path = at.searchParams.get("p") ?? "";
  if (!Object.hasOwn(all, path)) throw new HttpError(404);
  return all[path] as T;
}

/** A delete that did not go through, with the server's reason. */
export class DeleteError extends Error {
  /**
   * `partial`: a folder was being removed when it stopped, so part of it may be gone. `disk`: it is on another disk
   * than the Trash, so it can only be deleted for good.
   */
  constructor(
    reason: string,
    readonly partial: boolean,
    readonly disk = false,
  ) {
    super(reason);
  }
}

/** An entry in the Trash, as the server lists it. Times are in seconds. */
export interface TrashItem {
  id: string;
  /** Where it was, relative to the served folder. */
  path: string;
  deleted: number;
  /** When it goes for good. */
  gone: number;
  dir: boolean;
  link: boolean;
  size: number;
  /** For a folder, how many entries it held. */
  count: number;
}

export interface TrashList {
  days: number;
  items: TrashItem[];
}

/**
 * Deletes a file, a link, or a folder with everything in it: into the Trash while the server keeps one, and then the
 * answer is what the Trash lists for it, or for good with `forever` or without a Trash, and then it is nothing. Fails
 * with a `DeleteError`.
 */
export async function deleteEntry(path: string, forever = false): Promise<TrashItem | null> {
  // The header marks the request as the page's own: the server refuses a delete without it.
  const response = await call(urls.entry(path, forever), { method: "DELETE", headers: { "x-okfs": "delete" } });
  if (response.ok) {
    const body: { trash?: TrashItem } = await response.json().catch(() => ({}));
    return body.trash ?? null;
  }
  const body: { error?: unknown; partial?: unknown; disk?: unknown } = await response.json().catch(() => ({}));
  const reason = typeof body.error === "string" ? body.error : `the server answered ${response.status}`;
  throw new DeleteError(reason, body.partial === true, body.disk === true);
}

/** A change the server refused, with its reason. */
export class ChangeError extends Error {
  constructor(
    reason: string,
    readonly status: number,
  ) {
    super(reason);
  }
}

/** Sends a change the page asks for, `kind` naming it for the server, and reads what it answers. */
async function change<T>(url: string, method: string, kind: "delete" | "move" | "write"): Promise<T> {
  const response = await call(url, { method, headers: { "x-okfs": kind } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: unknown };
  if (response.ok) return body;
  const reason = typeof body.error === "string" ? body.error : `the server answered ${response.status}`;
  throw new ChangeError(reason, response.status);
}

export const listTrash = (): Promise<TrashList> => getJson<TrashList>(urls.trash());

/** Puts an entry of the Trash back where it was. Answers with where it went: its name differs when that was taken. */
export const restoreEntry = (id: string): Promise<{ path: string; made: string | null }> => change(urls.restore(id), "POST", "delete");

/** Deletes an entry of the Trash for good, or with `all`, all of them. */
export const forgetEntry = (id: string | null): Promise<{ gone: number }> =>
  change(id === null ? urls.trash(undefined, true) : urls.trash(id), "DELETE", "delete");

/** Moves or renames an entry. Answers with where it is now. */
export const moveEntry = (from: string, to: string, keep = false): Promise<{ path: string }> =>
  change(urls.move(from, to, keep), "POST", "move");

/** Copies an entry, a folder with all it shows. Answers with where the copy is. */
export const copyEntry = (from: string, to: string, keep = false): Promise<{ path: string }> =>
  change(urls.copy(from, to, keep), "POST", "write");

/** A file as a write answers with it: where it landed, its tag, its size and its time in seconds. */
export interface Written {
  path: string;
  etag: string;
  s: number;
  m: number;
}

/**
 * What is at a name a write could not take: a folder, or a file with its tag, size and time. `gone` when nothing is
 * there any more, as for a file changed since it was read and then removed.
 */
export interface Clash {
  error: string;
  d?: boolean;
  etag?: string;
  s?: number;
  m?: number;
  gone?: boolean;
}

/** A write that did not go through, with the server's reason, and what is at the name when it was taken. */
export class WriteError extends Error {
  constructor(
    reason: string,
    readonly status: number,
    readonly clash?: Clash,
  ) {
    super(reason);
  }
}

/** What a write of a file is for: a new file, beside one of the same name with `keep`, or over the version `over`. */
export type Want = { new: true; keep?: boolean } | { over: string };

/** The reason a refused write gives, and what is at its name when it says. */
function writeError(status: number, text: string): WriteError {
  let body: Partial<Clash> = {};
  try {
    body = JSON.parse(text) as Partial<Clash>;
  } catch {}
  const reason = typeof body.error === "string" ? body.error : `the server answered ${status}`;
  return new WriteError(reason, status, status === 412 ? (body as Clash) : undefined);
}

/**
 * Writes a file: the whole body, moved into place on the server only once it has all come. `sent` hears how many
 * bytes have gone. It goes by XMLHttpRequest, as `fetch` tells nothing of an upload's progress. Fails with a
 * `WriteError`, or a `NoAnswer` when a proxy answers for okfs or it refuses the key. A connection cut before an
 * answer fails this file only: okfs may close one on a refusal it sends before the body has come.
 */
export function putFile(path: string, body: Blob, want: Want, sent?: (bytes: number) => void): Promise<Written> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", urls.file(path, "new" in want && want.keep === true));
    // The header marks the request as the page's own: the server refuses a write without it.
    request.setRequestHeader("x-okfs", "write");
    if ("new" in want) request.setRequestHeader("if-none-match", "*");
    else request.setRequestHeader("if-match", want.over);
    if (sent) request.upload.onprogress = (event) => sent(event.loaded);
    request.onerror = () => reject(new WriteError("the connection closed before okfs answered", 0));
    request.onload = () => {
      const refused = heard(request.status, () => request.getResponseHeader("www-authenticate"));
      if (refused) return reject(refused);
      if (request.status >= 200 && request.status < 300) resolve(JSON.parse(request.responseText) as Written);
      else reject(writeError(request.status, request.responseText));
    };
    request.send(body);
  });
}

/** Makes one folder. The answer is what is at the name when it is taken, and nothing when the folder was made. */
export async function makeFolder(path: string): Promise<Clash | undefined> {
  const response = await call(urls.folder(path), { method: "POST", headers: { "x-okfs": "write" } });
  if (response.ok) return undefined;
  const error = writeError(response.status, await response.text().catch(() => ""));
  if (error.clash) return error.clash;
  throw error;
}

/**
 * What is at a name, asked before a file is sent to it, so a name that is taken is known before any of the file goes:
 * a folder, or a file with its tag, size and time. Nothing when the name is free.
 */
export async function lookUp(path: string): Promise<Clash | undefined> {
  // Not followed: a folder with an --index file sends its address on, to a page that is no file of that name.
  const response = await call(urls.raw(path), { method: "HEAD", cache: "no-store", redirect: "manual" });
  const error = "there is already an entry of that name";
  if (!response.ok) {
    const folder = await call(urls.list(path, 1), { cache: "no-store" });
    return folder.ok ? { error, d: true } : undefined;
  }
  const size = response.headers.get("content-length");
  const modified = Date.parse(response.headers.get("last-modified") ?? "");
  return {
    error,
    etag: response.headers.get("etag") ?? undefined,
    s: size === null ? undefined : Number(size),
    m: Number.isNaN(modified) ? undefined : Math.floor(modified / 1000),
  };
}

/** The served path an address of the server asks about, or `null` when it names none. */
export const pathOf = (url: string): string | null => {
  const query = new URL(url, location.href).searchParams;
  return query.get("path") ?? query.get("p");
};

export const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
export const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
