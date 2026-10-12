// The server's endpoints, as the page sees them.

export interface Item {
  n: string;
  d?: boolean;
  /** A link. Deleting it removes the link and leaves what it points at. */
  l?: boolean;
  s: number;
  m: number;
  c?: number;
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
  entries: Item[];
  total: number;
  readme: Readme | null;
}

export type TextPreview =
  | { kind: "markdown"; html: string; lines: number }
  | { kind: "code"; html: string; lines: number; highlighted: boolean }
  | { kind: "table"; head: string[]; rows: string[][]; numeric: boolean[]; total: number }
  | { kind: "json"; text: string; lines: number }
  | { kind: "doc"; title: string; text: string }
  | { kind: "none"; reason: "binary" | "large" };

export interface Hit {
  path: string;
  dir: boolean;
  /** Matched characters, counted in characters of the name or of the whole path. */
  idx: number[];
  name: boolean;
}

export interface Found {
  hits: Hit[];
  total: number;
  indexed: number;
  ready: boolean;
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

export const urls = {
  list: (path: string, limit?: number) =>
    `/api/list?path=${encodeURIComponent(path)}${limit ? `&limit=${limit}` : ""}`,
  preview: (path: string) => `/api/preview?path=${encodeURIComponent(path)}`,
  /** The start of a text file only, for a grid tile. */
  head: (path: string) => `/api/preview?path=${encodeURIComponent(path)}&head=1`,
  archive: (path: string) => `/api/archive?path=${encodeURIComponent(path)}`,
  search: (query: string) => `/api/search?q=${encodeURIComponent(query)}`,
  recent: "/api/recent",
  /** The time and size make a rewritten picture a new address: the browser keeps a thumbnail by its address. */
  thumb: (path: string, width: number, modified: number, size: number) =>
    `/api/thumb?path=${encodeURIComponent(path)}&w=${width}&m=${modified}&s=${size}`,
  /** The stream of changes to the served folder. */
  events: "/api/events",
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
  const response = await fetch(url, { signal });
  if (!response.ok) throw new HttpError(response.status);
  return (await response.json()) as T;
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
  const response = await fetch(urls.entry(path), { method: "DELETE", headers: { "x-okfs": "delete" } });
  if (response.ok) return;
  const body: { error?: unknown; partial?: unknown } = await response.json().catch(() => ({}));
  const reason = typeof body.error === "string" ? body.error : `the server answered ${response.status}`;
  throw new DeleteError(reason, body.partial === true);
}

/** The served path an address of the server asks about, or `null` when it names none. */
export const pathOf = (url: string): string | null => new URL(url, location.href).searchParams.get("path");

export const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
export const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
