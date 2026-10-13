// The app's state and every action on it: where we are, what is listed, where the cursor is.

import { HttpError, type Item, type Listing, type Readme, deleteEntry, getJson, joinPath, nameOf, parentOf, parseLocation, urls } from "./api";
import { type Config, config, locate } from "./config";
import { type Kind, extension, hasSource, kindOf } from "./kinds";
import { prefs } from "./prefs";
import { forgetAnswers } from "./preview";

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  /** A link to the file or folder, not the thing itself. */
  link: boolean;
  size: number;
  /** Modified time, in seconds. */
  mtime: number;
  /** For a folder, how many entries it holds. */
  count?: number;
  ext: string;
  kind: Kind;
  /** Position in name order, as the server sent it. Sorting by name is sorting by this. */
  rank: number;
  lower: string;
}

/** What a delete is asked for: an entry of the list, or the folder being shown. */
export type Doomed = Pick<Entry, "name" | "path" | "dir" | "link" | "kind" | "count">;

export type SortKey = "name" | "time" | "size" | "kind";
export type View = "list" | "grid";
export interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

export const SORT_KEYS: SortKey[] = ["name", "time", "size", "kind"];
export const SORT_LABEL: Record<SortKey, string> = { name: "Name", time: "Modified", size: "Size", kind: "Kind" };

/** Names and kinds read best first to last; sizes and times are wanted largest and newest first. */
const naturalDir = (key: SortKey): 1 | -1 => (key === "name" || key === "kind" ? 1 : -1);

export interface State {
  status: "loading" | "ready" | "missing";
  /** The folder being shown, relative to the served folder. Empty for the top. */
  path: string;
  /** True when that folder is reached through a link. */
  link: boolean;
  all: Entry[];
  /** `all` after the filter and the sort: what the list shows. */
  entries: Entry[];
  cursor: number;
  view: View;
  /**
   * The preview is open: what is under the cursor is shown beside the list, and follows the cursor. Closed,
   * nothing is asked of the server about a file until one is opened. It starts closed on every visit.
   */
  peek: boolean;
  /** The path of the file shown as its source, not as what is made from it. Empty for none. */
  raw: string;
  sort: Sort;
  filter: string;
  /** The file given the full width, if any. */
  open: Entry | null;
  readme: Readme | null;
  /** Bytes in the files directly in this folder. */
  bytes: number;
  palette: boolean;
  help: boolean;
  /** What the delete dialog is asking about, while it is up. */
  doomed: Doomed | null;
  /** Counts the times the list caught up with the disk by itself. The list does not scroll for those. */
  caught: number;
}

type HistoryMode = "push" | "replace" | "none";

/** What a history entry remembers besides its address. */
interface Mark {
  /** A file opened from the list in this visit: closing it is going back. */
  opened?: boolean;
  /** A folder's address standing for its listing, where it would otherwise open the folder's index page. */
  listing?: boolean;
}

const mark = (): Mark => (history.state as Mark | null) ?? {};

export function toEntry(item: Item, dir: string, rank: number): Entry {
  const isDir = item.d === true;
  return {
    name: item.n,
    path: joinPath(dir, item.n),
    dir: isDir,
    link: item.l === true,
    size: item.s,
    mtime: item.m,
    count: item.c,
    ext: isDir ? "" : extension(item.n),
    kind: kindOf(item.n, isDir),
    rank,
    lower: item.n.toLowerCase(),
  };
}

/** The time and size a listing gives for an entry. They move when a file is rewritten. */
/** What a file is loaded under until it is seen to change: its time and size. */
export const versionOf = (entry: Entry): string => `${entry.mtime}.${entry.size}`;

function savedSort(): Sort {
  const [key, dir] = (prefs.get("sort") ?? "").split(":");
  const known = SORT_KEYS.find((candidate) => candidate === key);
  return known ? { key: known, dir: dir === "-1" ? -1 : 1 } : { key: "name", dir: 1 };
}

export class Store {
  readonly s: State = {
    status: "loading",
    path: "",
    link: false,
    all: [],
    entries: [],
    cursor: 0,
    view: prefs.get("view") === "grid" ? "grid" : "list",
    peek: false,
    raw: "",
    sort: savedSort(),
    filter: "",
    open: null,
    readme: null,
    bytes: 0,
    palette: false,
    help: false,
    doomed: null,
    caught: 0,
  };

  private readonly listeners = new Set<() => void>();
  /** Counts navigations, so a slow answer for a folder we already left is dropped. */
  private turn = 0;
  /** Where the cursor was in each folder visited, by name. */
  private readonly remembered = new Map<string, string>();
  /** Where the folder being shown really is: the path its changes on disk are told by. */
  private real = "";
  /** Counts what the server told, so a folder that was on its way while something came in is read once more. */
  private heard = 0;
  /** What the next catch-up has to do, while one is due. See `catchUp`. */
  private due: { all: boolean } | null = null;
  private catching = false;
  /** True while a delete of our own runs. It shows the folder itself when it is done. */
  private removing = false;
  /** The stamp of each file shown by its address, and the time and size the file had when it was loaded. See `stamp`. */
  private readonly stamps = new Map<string, { stamp: string; seen?: string }>();
  private stamped = 0;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    // The source is shown of one file: it is left behind when another file, or none, is on show.
    if (this.s.raw && this.shown()?.path !== this.s.raw) this.s.raw = "";
    for (const listener of this.listeners) listener();
  }

  cur(): Entry | null {
    return this.s.entries[this.s.cursor] ?? null;
  }

  /** The file on show: the one given the full width, or the one under the cursor while the preview is open. */
  shown(): Entry | null {
    const { s } = this;
    const cur = this.cur();
    return s.open ?? (s.peek && cur && !cur.dir ? cur : null);
  }

  /** The file on show, when it has a second form to flip to: see `hasSource`. */
  flippable(): Entry | null {
    const file = this.shown();
    return file && hasSource(file) ? file : null;
  }

  /** The files of the current list, in order: what next and previous step through. */
  files(): Entry[] {
    return this.s.entries.filter((entry) => !entry.dir);
  }

  /** The folder being shown holds the `--index` file, whatever the filter hides. */
  private hasIndex(): boolean {
    return this.s.all.some((entry) => !entry.dir && entry.name === config.index);
  }

  private compute(): void {
    const { s } = this;
    const query = s.filter.trim().toLowerCase();
    const shown = query ? s.all.filter((entry) => entry.lower.includes(query)) : s.all.slice();
    const { key, dir } = s.sort;
    const by: Record<SortKey, (a: Entry, b: Entry) => number> = {
      name: (a, b) => a.rank - b.rank,
      size: (a, b) => a.size - b.size,
      time: (a, b) => a.mtime - b.mtime,
      kind: (a, b) => (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0),
    };
    const order = by[key];
    shown.sort((a, b) => Number(b.dir) - Number(a.dir) || order(a, b) * dir || a.rank - b.rank);
    s.entries = shown;
    s.cursor = Math.max(0, Math.min(s.cursor, shown.length - 1));
  }

  private select(name: string | undefined): void {
    const at = name === undefined ? -1 : this.s.entries.findIndex((entry) => entry.name === name);
    this.s.cursor = Math.max(0, at);
  }

  private setUrl(mode: HistoryMode, path: string, dir: boolean, state: Mark = {}): void {
    if (mode === "none") return;
    const url = urls.view(path, dir) + location.search;
    if (mode === "push" && url !== location.pathname + location.search) return history.pushState(state, "", url);
    // A replaced file entry keeps what it remembered; a folder's entry takes only the mark it is given.
    history.replaceState(mode === "push" || dir ? state : history.state, "", url);
  }

  /** Takes a listing as the folder being shown. */
  private take(listing: Listing): void {
    const { s } = this;
    s.status = "ready";
    s.path = listing.path;
    this.real = listing.real ?? listing.path;
    s.link = listing.link === true;
    s.all = listing.entries.map((item, rank) => toEntry(item, listing.path, rank));
    s.bytes = s.all.reduce((sum, entry) => sum + entry.size, 0);
    s.readme = listing.readme;
  }

  /** Shows that nothing is at a path. */
  private lose(path: string): void {
    this.real = path;
    Object.assign(this.s, { status: "missing", path, link: false, all: [], entries: [], open: null, readme: null, bytes: 0, filter: "" });
  }

  /**
   * Shows a folder. `select` puts the cursor on a name; `open` also gives that file the full width.
   * A folder holding the `--index` file opens that file, under the folder's own address, unless
   * a name was asked for or `listing` is set.
   */
  async showDir(
    path: string,
    opts: { select?: string; open?: string; listing?: boolean; history?: HistoryMode } = {},
  ): Promise<void> {
    const { s } = this;
    const turn = ++this.turn;
    const heard = this.heard;
    const leaving = this.cur();
    if (leaving && s.status === "ready") this.remembered.set(s.path, leaving.name);

    let listing: Listing;
    try {
      listing = await getJson<Listing>(urls.list(path));
    } catch (error) {
      if (turn !== this.turn) return;
      if (!(error instanceof HttpError)) throw error;
      this.lose(path);
      this.setUrl(opts.history ?? "push", path, true);
      this.emit();
      return;
    }
    if (turn !== this.turn) return;

    const changed = s.path !== listing.path || s.status !== "ready";
    this.take(listing);
    if (changed) s.filter = "";
    this.compute();
    const asked = opts.open !== undefined || opts.select !== undefined || opts.listing === true;
    const index = this.hasIndex() && !asked ? config.index : undefined;
    const open = opts.open ?? index;
    const wanted = open ?? opts.select ?? (changed ? this.remembered.get(listing.path) : this.cur()?.name);
    if (open !== undefined && !s.entries.some((entry) => entry.name === open)) {
      // The file may be hidden by a filter that outlived a reload of the same folder.
      s.filter = "";
      this.compute();
    }
    this.select(wanted);
    const opened = open === undefined ? null : this.cur();
    s.open = opened && !opened.dir && opened.name === open ? opened : null;
    const mode = opts.history ?? "push";
    // An index page keeps its folder's address, so a link to the folder means the page.
    const paged = s.open !== null && index !== undefined;
    // A file opened from elsewhere gets its folder as the entry before it, so closing lands there.
    if (!s.open || paged || (mode === "push" && changed)) this.setUrl(mode, listing.path, true, { listing: !paged && this.hasIndex() });
    if (s.open && !paged) this.setUrl(mode, s.open.path, false, { opened: true });
    this.emit();
    // A change told while the listing was on its way may not be in it.
    if (heard !== this.heard) this.catchUp();
  }

  /**
   * Changes whenever the file is rewritten. A picture, a video or a sound is loaded by an address that
   * carries it, and a frame is made again for each one, so the new contents are loaded and the old are not
   * shown from memory. It starts as the file's time and size. It moves when the server names the file as
   * written, and when a call to catch up on everything does not find the file listed with the time and size
   * it was loaded with.
   */
  stamp(entry: Entry): string {
    let kept = this.stamps.get(entry.path);
    if (!kept) {
      kept = { stamp: versionOf(entry) };
      this.stamps.set(entry.path, kept);
      // Oldest first out: a Map keeps insertion order. A file dropped here starts again from its time and size.
      if (this.stamps.size > 500) this.stamps.delete(this.stamps.keys().next().value as string);
    }
    // The listing was read before the file is loaded under this stamp: what is loaded is never older.
    kept.seen ??= versionOf(entry);
    return kept.stamp;
  }

  /** Marks a file that has been shown as rewritten: it is loaded again the next time it is shown. */
  private restamp(path: string): void {
    if (this.stamps.has(path)) this.stamps.set(path, { stamp: `r${++this.stamped}` });
  }

  /**
   * Nothing that is kept can be trusted. A stamp stays only where the folder on screen lists its file with
   * the time and size it was loaded with, and every answer is asked for again.
   */
  private distrust(): void {
    const listed = new Map(this.s.all.map((entry) => [entry.path, versionOf(entry)]));
    for (const [path, kept] of [...this.stamps]) if (kept.seen !== listed.get(path)) this.restamp(path);
    forgetAnswers();
  }

  /** A folder's real path, as the path the page knows it by. They differ under a folder reached through a link. */
  private local(dir: string): string {
    const { path } = this.s;
    const { real } = this;
    if (real === path) return dir;
    if (dir === real) return path;
    if (!real) return joinPath(path, dir);
    return dir.startsWith(`${real}/`) ? path + dir.slice(real.length) : dir;
  }

  /**
   * The server says a folder changed on disk: entries came or went, or the files named were written.
   * Only what is on screen is read again.
   */
  changed(dir: string, files: string[]): void {
    const { s } = this;
    this.heard++;
    const here = this.local(dir);
    const named = new Set(files);
    // A file on screen is loaded again once its folder has been read: see `stamp`.
    for (const name of files) this.restamp(joinPath(here, name));
    // What is kept about the folder and about the files written in it is out of date, on screen or not.
    // So is what is kept about each folder above it: the answer for a folder's columns holds the folders under it.
    const holds = (path: string): boolean => (path ? here.startsWith(`${path}/`) : here !== "");
    forgetAnswers((path) => path === here || holds(path) || (parentOf(path) === here && named.has(nameOf(path))));
    if (s.status === "loading") return;
    // The folder on screen shows its own entries, how many each folder in it holds, and that it is there at all.
    const inside = dir !== "" && parentOf(dir) === this.real;
    const above = dir !== this.real && (dir === "" || this.real.startsWith(`${dir}/`));
    if (dir === this.real || inside || above) this.catchUp();
  }

  /** The server says more changed than it names, or nothing was heard for a while: nothing kept can be trusted. */
  sync(): void {
    this.heard++;
    this.catchUp(true);
  }

  /**
   * Reads the folder on screen again, soon, or asks again for an address that had nothing. `all`: the files
   * that were written are not known by name, so they are told by their time and size, and nothing kept about
   * the other folders is trusted.
   */
  private catchUp(all = false): void {
    this.due = { all: all || this.due?.all === true };
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.catching || this.removing) return;
    this.catching = true;
    try {
      while (this.due) {
        const { all } = this.due;
        this.due = null;
        await this.reread(all);
      }
    } finally {
      this.catching = false;
    }
  }

  /**
   * Shows the folder as it is on disk now and leaves the rest as it is: the filter, the sort, the view,
   * the scroll position and the open file. The cursor stays on its entry by name.
   */
  private async reread(all: boolean): Promise<void> {
    const { s } = this;
    const { path } = s;
    const turn = this.turn;
    if (s.status === "loading") return;
    if (s.status === "missing") return this.arrive(all);
    let listing: Listing | null = null;
    try {
      listing = await getJson<Listing>(urls.list(path));
    } catch (error) {
      // The server did not answer: the stream drops too, and catches up when it is back.
      if (!(error instanceof HttpError)) return;
    }
    // The reader went elsewhere meanwhile, and that folder is read as it is now. A call to catch up on everything still stands.
    if (turn !== this.turn || path !== s.path) {
      if (all) this.catchUp(true);
      return;
    }
    if (!listing) {
      this.lose(path);
      this.distrust();
      this.emit();
      return;
    }

    const order = s.entries.map((entry) => entry.name);
    const at = s.cursor;
    this.take(listing);
    this.compute();
    const now = new Map(s.all.map((entry) => [entry.name, entry]));
    const place = new Map(s.entries.map((entry, index) => [entry.name, index]));
    // The cursor's entry may be gone: the nearest one that is left takes it, the next one first.
    const nearest = [...order.slice(at), ...order.slice(0, at).reverse()].find((name) => place.has(name));
    s.cursor = (nearest === undefined ? undefined : place.get(nearest)) ?? 0;
    if (s.open) {
      const still = now.get(s.open.name);
      s.open = still && !still.dir ? still : null;
      // The address of a file that is gone gives way to its folder's.
      if (!s.open) this.setUrl("replace", s.path, true, { listing: this.hasIndex() });
    }

    if (all) this.distrust();
    s.caught++;
    this.emit();
  }

  /**
   * Nothing is at the page's address. Asks the server for it again, the way a reload does, and shows what
   * is there now: a folder and a file come back the same way.
   */
  private async arrive(all: boolean): Promise<void> {
    const turn = this.turn;
    // The server may not answer: the stream drops too, and catches up when it is back.
    const found = await locate().catch(() => undefined);
    // The reader went elsewhere meanwhile. A call to catch up on everything still stands.
    if (turn !== this.turn || this.s.status !== "missing") {
      if (all) this.catchUp(true);
      return;
    }
    if (all) this.distrust();
    if (found) await this.land(found).catch(() => undefined);
  }

  /** Goes to any path in the tree: a folder is shown, a file is opened in its folder. */
  go(path: string, dir: boolean, history: HistoryMode = "push", listing = false): Promise<void> {
    if (dir) return this.showDir(path, { history, listing });
    return this.showDir(parentOf(path), { open: nameOf(path), history });
  }

  /** Shows what the server found at the page's address: a folder, a file in its folder, or nothing. */
  private land({ path, kind }: Config["target"]): Promise<void> {
    // A reload of a folder whose index page was closed stays on the listing.
    if (kind !== "missing") return this.go(path, kind === "dir", "replace", mark().listing === true);
    this.lose(path);
    this.emit();
    return Promise.resolve();
  }

  start(): Promise<void> {
    addEventListener("popstate", () => void this.route());
    return this.land(config.target);
  }

  /** Follows the address bar after back or forward. */
  private route(): Promise<void> {
    const { s } = this;
    const { path, dir } = parseLocation();
    const folder = dir ? path : parentOf(path);
    const listing = mark().listing === true;
    if (s.status !== "ready" || folder !== s.path) return this.go(path, dir, "none", listing);
    // A folder's address means its index page, unless the entry was left on the listing.
    const index = this.hasIndex() && !listing ? joinPath(path, config.index ?? "") : null;
    const file = dir ? index : path;
    const at = file === null ? -1 : s.entries.findIndex((entry) => entry.path === file);
    if (file !== null && at < 0) return this.go(path, dir, "none", listing);
    if (at >= 0) s.cursor = at;
    s.open = at >= 0 ? (s.entries[at] ?? null) : null;
    this.emit();
    return Promise.resolve();
  }

  moveTo(index: number): void {
    const { s } = this;
    if (!s.entries.length) return;
    s.cursor = Math.max(0, Math.min(index, s.entries.length - 1));
    this.emit();
  }

  move(delta: number): void {
    this.moveTo(this.s.cursor + delta);
  }

  /** Enters the folder under the cursor, or gives the file under it the full width. */
  activate(index?: number): void {
    const { s } = this;
    // A file already at full width stays as it is: opening it again would only rewrite its history entry.
    if (s.open) return;
    if (index !== undefined) s.cursor = index;
    const entry = this.cur();
    if (!entry) return;
    if (entry.dir) void this.showDir(entry.path);
    else this.openEntry(entry, "push");
  }

  private openEntry(entry: Entry, mode: HistoryMode): void {
    const { s } = this;
    const at = s.entries.indexOf(entry);
    if (at >= 0) s.cursor = at;
    s.open = entry;
    this.setUrl(mode, entry.path, false, { opened: true });
    this.emit();
  }

  close(): void {
    const { s } = this;
    if (!s.open) return;
    // Opened from the list in this visit: going back is the same as closing, and keeps history short.
    if (mark().opened) {
      history.back();
      return;
    }
    s.open = null;
    this.setUrl("replace", s.path, true, { listing: this.hasIndex() });
    this.emit();
  }

  up(): void {
    const { s } = this;
    if (s.open) return this.close();
    if (s.path) void this.showDir(parentOf(s.path), { select: nameOf(s.path) });
  }

  /** While a file is open: moves to the next or previous file, skipping folders. */
  step(delta: 1 | -1): void {
    const { s } = this;
    for (let i = s.cursor + delta; i >= 0 && i < s.entries.length; i += delta) {
      const entry = s.entries[i];
      if (entry && !entry.dir) return this.openEntry(entry, "replace");
    }
  }

  setView(view?: View): void {
    const { s } = this;
    s.view = view ?? (s.view === "list" ? "grid" : "list");
    prefs.set("view", s.view);
    this.emit();
  }

  /** Opens or closes the preview. The choice is for this visit: nothing is kept. */
  setPeek(peek = !this.s.peek): void {
    this.s.peek = peek;
    this.emit();
  }

  /** Flips the file on show between what is made from it and its source. A file with one form stays as it is. */
  flipRaw(): void {
    const { s } = this;
    const file = this.flippable();
    if (!file) return;
    s.raw = s.raw === file.path ? "" : file.path;
    this.emit();
  }

  /** Sorts by a key. The same key again flips the direction; no key moves to the next one. */
  setSort(key?: SortKey): void {
    const { s } = this;
    if (key === undefined) {
      const next = SORT_KEYS[(SORT_KEYS.indexOf(s.sort.key) + 1) % SORT_KEYS.length] ?? "name";
      s.sort = { key: next, dir: naturalDir(next) };
    } else {
      s.sort = { key, dir: s.sort.key === key ? (-s.sort.dir as 1 | -1) : naturalDir(key) };
    }
    prefs.set("sort", `${s.sort.key}:${s.sort.dir}`);
    const keep = this.cur();
    this.compute();
    if (keep) s.cursor = Math.max(0, s.entries.indexOf(keep));
    this.emit();
  }

  setFilter(query: string): void {
    const { s } = this;
    s.filter = query;
    s.cursor = 0;
    this.compute();
    this.emit();
  }

  setPalette(on: boolean): void {
    this.s.palette = on;
    this.emit();
  }

  setHelp(on: boolean): void {
    this.s.help = on;
    this.emit();
  }

  /** The folder being shown, as something to delete. The served folder itself is never offered. */
  here(): Doomed | null {
    const { s } = this;
    if (!config.delete || s.status !== "ready" || !s.path) return null;
    return { name: nameOf(s.path), path: s.path, dir: true, link: s.link, kind: "folder", count: s.all.length };
  }

  /** Puts up the delete dialog, for the open file or the entry under the cursor unless one is given. */
  askDelete(doomed: Doomed | null = this.s.open ?? this.cur()): void {
    if (!config.delete || !doomed) return;
    this.s.doomed = doomed;
    this.emit();
  }

  cancelDelete(): void {
    this.s.doomed = null;
    this.emit();
  }

  /** Deletes what the dialog asked about, then shows the folder without it. Fails with the server's reason. */
  async remove(doomed: Doomed): Promise<void> {
    this.removing = true;
    try {
      await this.removeNow(doomed);
    } finally {
      this.removing = false;
      // What other programs changed meanwhile was left waiting.
      void this.drain();
    }
  }

  private async removeNow(doomed: Doomed): Promise<void> {
    const { s } = this;
    const here = doomed.path === s.path;
    // The neighbours of the folder being shown are in the folder above: ask for them while it is still there.
    const above = here ? await getJson<Listing>(urls.list(parentOf(doomed.path))).catch(() => null) : null;
    try {
      await deleteEntry(doomed.path);
    } catch (error) {
      // Part of a folder may be gone all the same: the list, the pane and the dialog show what is there now.
      await this.showDir(s.path, { open: s.open?.name, listing: true, history: "none" }).catch(() => undefined);
      s.doomed = (here ? this.here() : s.all.find((entry) => entry.path === doomed.path)) ?? doomed;
      forgetAnswers();
      this.emit();
      throw error;
    }
    try {
      if (here) {
        // In the list's own order when it is sorted by name: folders first.
        const items = above?.entries ?? [];
        const names = [...items.filter((item) => item.d), ...items.filter((item) => !item.d)].map((item) => item.n);
        const was = names.indexOf(doomed.name);
        await this.showDir(parentOf(doomed.path), { select: names[was + 1] ?? names[was - 1], listing: true, history: "replace" });
        return;
      }
      const at = s.entries.findIndex((entry) => entry.path === doomed.path);
      if (at < 0) {
        await this.showDir(s.path, { listing: true, history: "none" });
        return;
      }
      // The cursor stays where it is, on what came after; at the end of the list it steps back.
      const beside = s.entries[at + 1] ?? s.entries[at - 1];
      if (s.open?.path !== doomed.path) {
        await this.showDir(s.path, { select: beside?.name, listing: true, history: "replace" });
        return;
      }
      // An open file gives its place to the next file, as stepping does. With none left, the list is back.
      const files = this.files();
      const turn = files.findIndex((entry) => entry.path === doomed.path);
      const next = files[turn + 1] ?? files[turn - 1];
      await this.showDir(s.path, { open: next?.name, select: beside?.name, listing: true, history: "replace" });
    } finally {
      s.doomed = null;
      // After the list is back, so that nothing on screen asks about what is gone.
      forgetAnswers();
      this.emit();
    }
  }
}

export const store = new Store();
