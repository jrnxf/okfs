// The server's endpoints, as the page sees them.

import { showsHidden } from "./hidden";
import { call } from "./reach";

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
  entry: (path: string) => `/api/entry?path=${encodeURIComponent(path)}`,
  raw: (path: string) => `/raw/${encode(path)}`,
  zip: (path: string) => `/zip/${encode(path)}`,
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
  /** `partial`: a folder was being removed when it stopped, so part of it may be gone. */
  constructor(
    reason: string,
    readonly partial: boolean,
  ) {
    super(reason);
  }
}

/** Deletes a file, a link, or a folder with everything in it. Fails with a `DeleteError`. */
export async function deleteEntry(path: string): Promise<void> {
  // The header marks the request as the page's own: the server refuses a delete without it.
  const response = await call(urls.entry(path), { method: "DELETE", headers: { "x-okfs": "delete" } });
  if (response.ok) return;
  const body: { error?: unknown; partial?: unknown } = await response.json().catch(() => ({}));
  const reason = typeof body.error === "string" ? body.error : `the server answered ${response.status}`;
  throw new DeleteError(reason, body.partial === true);
}

/** The served path an address of the server asks about, or `null` when it names none. */
export const pathOf = (url: string): string | null => {
  const query = new URL(url, location.href).searchParams;
  return query.get("path") ?? query.get("p");
};

export const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
export const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
