// The app's state and every action on it: where we are, what is listed, where the cursor is.

import {
  type Found,
  type Hit,
  HttpError,
  type Item,
  type Listing,
  type MatchOrder,
  type Readme,
  deleteEntry,
  findOf,
  getJson,
  joinPath,
  nameOf,
  parentOf,
  parseLocation,
  urls,
  withFind,
} from "./api";
import { copyText } from "./clip";
import { type Config, config, locate } from "./config";
import { setShowsHidden, showsHidden } from "./hidden";
import { type Kind, extension, formOf, hasSource, isProse, kindOf, sourceFirst } from "./kinds";
import { prefs } from "./prefs";
import { NoAnswer } from "./reach";
import { columnsUrl, forgetAnswers, preload } from "./preview";
import { COLUMN_ROWS } from "./slots";

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  /** A link to the file or folder, not the thing itself. */
  link: boolean;
  size: number;
  /** Modified time, in seconds. */
  mtime: number;
  /** For a folder, how many entries it holds, hidden ones only while they are shown. */
  count?: number;
  /** For a folder, how many hidden entries it holds while they are not shown. */
  unlisted?: number;
  ext: string;
  kind: Kind;
  /** Position in name order, as the server sent it. Sorting by name is sorting by this. */
  rank: number;
  lower: string;
}

/** What a delete is asked for: an entry of the list, or the folder being shown. */
export type Doomed = Pick<Entry, "name" | "path" | "dir" | "link" | "kind" | "count" | "unlisted">;

export type SortKey = "name" | "time" | "size" | "kind";
export interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

export const SORT_KEYS: SortKey[] = ["name", "time", "size", "kind"];
export const SORT_LABEL: Record<SortKey, string> = { name: "Name", time: "Modified", size: "Size", kind: "Kind" };

/** Names and kinds read best first to last; sizes and times are wanted largest and newest first. */
const naturalDir = (key: SortKey): 1 | -1 => (key === "name" || key === "kind" ? 1 : -1);

/** One of the matches: the entry it is, and what of it the query matched. */
export interface Match {
  entry: Entry;
  hit: Hit;
}

/** The orders of the matches, in the order `s` steps through them. */
export const MATCH_ORDERS: MatchOrder[] = ["rank", "name", "folder", "size", "time"];
export const MATCH_LABEL: Record<MatchOrder, string> = { rank: "relevance", name: "name", folder: "folder", size: "size", time: "modified" };

/** How many matches are asked for at a time. The server sends no more in one answer. */
export const MATCH_PAGE = 200;
/** The next page is asked for once the cursor or the end of what is on screen comes this close to the last match loaded. */
const MATCH_AHEAD = 60;

/** Every match of a query from anywhere in the tree, listed in place of a folder: see `Store.find`. */
export interface Matches {
  q: string;
  /** The matches loaded so far, in `sort`. More come a page at a time: see `Store.more`. */
  list: Match[];
  /** How many there are in all. */
  total: number;
  /** How long the server took over the first page, in milliseconds. */
  took: number;
  sort: { key: MatchOrder; rev: boolean };
  cursor: number;
  /** The first page for the query and the sort has come. Until it has, the last answer stays on screen. */
  ready: boolean;
}

/** While browsing below a folder entered from the matches: the way back to them. */
export interface Trail {
  q: string;
  /** How many matches there were, for the button that goes back. */
  total: number;
  /** The folder entered from the matches. */
  root: string;
  /** How many entries of history back the matches are. */
  steps: number;
}

export interface State {
  status: "loading" | "ready" | "missing";
  /** The folder being shown, relative to the served folder. Empty for the top. */
  path: string;
  /** True when that folder is reached through a link. */
  link: boolean;
  /** That folder's own modified time, in seconds. */
  mtime: number;
  all: Entry[];
  /** `all` after the filter and the sort: what the list shows. */
  entries: Entry[];
  cursor: number;
  /** Hidden entries are listed: see `showsHidden`. */
  hidden: boolean;
  /**
   * The kinds of file the reader flipped away from the form they open in: see `formOf` and `sourceFirst`.
   * It starts empty on every visit.
   */
  flipped: string[];
  /** The kinds of prose the reader turned wrapping off for: see `isProse`. */
  unwrapped: string[];
  sort: Sort;
  filter: string;
  /** The file given the full width, if any. */
  open: Entry | null;
  readme: Readme | null;
  /** Bytes in the files directly in this folder. */
  bytes: number;
  /** Entries of this folder left out of `all` while hidden entries are not shown. */
  unlisted: number;
  palette: boolean;
  help: boolean;
  /** The matches are on screen in place of the folder's list. */
  finding: boolean;
  /** The last matches, kept while a folder or a file entered from them is shown, to go back to. */
  matches: Matches | null;
  /** What the delete dialog is asking about, while it is up. */
  doomed: Doomed | null;
  /** What the dialog that names a new file or folder makes, and in which folder, while it is up. */
  naming: Naming | null;
  /** Counts the times the list caught up with the disk by itself. The list does not scroll for those. */
  caught: number;
  /** A word on what was just done, such as a link copied, while it is shown. See `say`. */
  notice: string | null;
}

type HistoryMode = "push" | "replace" | "none";

/** A new file or folder to name, in the folder `dir`. */
export interface Naming {
  kind: "file" | "folder";
  dir: string;
}

/** What a history entry remembers besides its address. */
interface Mark {
  /** A file opened from the list in this visit: closing it is going back. */
  opened?: boolean;
  /** A folder's address standing for its listing, where it would otherwise open the folder's index page. */
  listing?: boolean;
  /** The matches, opened in this visit from the page before this entry: leaving them is going back. */
  found?: boolean;
  /** The matches' cursor and sort when they were left, for a return to them after a reload. */
  at?: number;
  sort?: Matches["sort"];
  /** See `Trail`. */
  trail?: Trail;
}

const mark = (): Mark => (history.state as Mark | null) ?? {};

/** The entries the pointer picked in the columns of the folder `root`, a name for each level from the first. */
interface Picks {
  root: string;
  names: string[];
}

const NO_PICKS: Picks = { root: "", names: [] };

/** How long a notice stays up. */
const NOTICE_MS = 2400;

/** How long a folder waits for the columns beside it once its listing has come. Past it, they come after it. */
const COLUMNS_WAIT = 150;

/** Settles when `promise` does, or after `ms`, whichever is first. */
function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((done) => {
    timer = setTimeout(done, ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

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
    unlisted: item.h,
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
    mtime: 0,
    all: [],
    entries: [],
    cursor: 0,
    hidden: showsHidden(),
    flipped: [],
    unwrapped: [],
    sort: savedSort(),
    filter: "",
    open: null,
    readme: null,
    bytes: 0,
    unlisted: 0,
    palette: false,
    help: false,
    finding: false,
    matches: null,
    doomed: null,
    naming: null,
    caught: 0,
    notice: null,
  };

  private readonly listeners = new Set<() => void>();
  /** Counts navigations, so a slow answer for a folder we already left is dropped. */
  private turn = 0;
  /**
   * Where the cursor was in each folder visited, by name. `drawn`: the entry is among the rows a column of the
   * folder draws, so the column can lead on to it. See `leftIn`. `dir`: the entry is a folder.
   */
  private readonly remembered = new Map<string, { name: string; drawn: boolean; dir: boolean }>();
  /** Where the cursor was, by folder and entry, when the last change was told: see `forgetLeft`. */
  private placed: { path: string; at: string } | null = null;
  /** What the pointer picked in the columns beside the list. See `pick`. */
  private picks: Picks = NO_PICKS;
  /** Where the folder being shown really is: the path its changes on disk are told by. */
  private real = "";
  /** The listing of the folder being shown, and of the one shown before it. See `before`. */
  private listing: Listing | null = null;
  private last: Listing | null = null;
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
  private noticed: ReturnType<typeof setTimeout> | undefined;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    // A move of the cursor starts the columns of the folder it lands on afresh, even one the pointer picked in before.
    if (this.picks !== NO_PICKS && this.picks.root !== this.columnsRoot()) this.picks = NO_PICKS;
    this.forgetLeft();
    for (const listener of this.listeners) listener();
  }

  /**
   * A folder's remembered cursor holds only while the cursor stays on the folder in its parent: ← then → returns to
   * the same entry, but once the cursor moves off the folder the next visit, and its columns, start at the top. The
   * memory of what lies in the folder goes with it.
   */
  private forgetLeft(): void {
    const { s } = this;
    const cur = s.finding ? null : this.cur();
    const now = cur ? { path: s.path, at: cur.path } : null;
    const was = this.placed;
    this.placed = now;
    if (!was) return;
    // The cursor stayed in the folder and moved off an entry, or the step out of a folder landed on another entry.
    let gone: string | null = null;
    if (now?.path === was.path) gone = now.at === was.at ? null : was.at;
    else if (now !== null && was.path !== "" && parentOf(was.path) === now.path) gone = now.at === was.path ? null : was.path;
    if (gone === null) return;
    for (const path of [...this.remembered.keys()]) {
      if (path === gone || path.startsWith(`${gone}/`)) this.remembered.delete(path);
    }
  }

  cur(): Entry | null {
    return this.list()[this.at()] ?? null;
  }

  /** What the list on screen shows: the folder's entries, or the matches. */
  list(): Entry[] {
    const { s } = this;
    return s.finding && s.matches ? s.matches.list.map((match) => match.entry) : s.entries;
  }

  /** Where the cursor is in `list`. */
  at(): number {
    const { s } = this;
    return s.finding && s.matches ? s.matches.cursor : s.cursor;
  }

  /** The file on show: the one given the full width, or the one under the cursor. */
  shown(): Entry | null {
    const { s } = this;
    const cur = this.cur();
    return s.open ?? (cur && !cur.dir ? cur : null);
  }

  /** Whether `file` is shown as its source: Markdown, a drawing and JSON are until their kind is flipped. */
  isRaw(file: Entry): boolean {
    return hasSource(file) && sourceFirst(file) !== this.s.flipped.includes(formOf(file));
  }

  /** The file on show, when it has a second form to flip to: see `hasSource`. */
  flippable(): Entry | null {
    const file = this.shown();
    return file && hasSource(file) ? file : null;
  }

  /** Whether the source of `file` wraps at the edge of the pane: prose does until its kind is flipped, code never. */
  wraps(file: Entry): boolean {
    return isProse(file) && !this.s.unwrapped.includes(file.kind);
  }

  /** The file on show, when it is prose shown as its source, which has lines to wrap. */
  wrappable(): Entry | null {
    const file = this.shown();
    return file && isProse(file) && (!hasSource(file) || this.isRaw(file)) ? file : null;
  }

  /** The folder whose columns are beside the list: the one under the cursor, while no file has the full width. */
  columnsRoot(): string | null {
    const cur = this.cur();
    return !this.s.open && cur?.dir ? cur.path : null;
  }

  /** What the pointer picked in the columns of the folder `root`, a name for each level from the first. */
  picked(root: string | null): string[] {
    return root !== null && this.picks.root === root ? this.picks.names : [];
  }

  /**
   * The pointer picked entries in the columns of the folder `root`, a name for each level from the first. They
   * hold until the cursor moves, and going into the folder lands on the first of them: see `activate`.
   */
  pick(root: string, names: string[]): void {
    if (this.picks.root === root && this.picks.names.join("/") === names.join("/")) return;
    this.picks = { root, names };
    this.emit();
  }

  /**
   * The entry the cursor was on when the folder at `path` was left, while a column of the folder draws it. A
   * column of the folder leads on to it, and going into the folder lands on it: see `focusOf`.
   */
  leftIn(path: string): string | undefined {
    const left = this.remembered.get(path);
    return left?.drawn ? left.name : undefined;
  }

  /**
   * The listing of the folder at `path` when it is the one shown before this one, as on a step out of it: its
   * columns are drawn from it until their own answer comes. See `steppedOut`.
   */
  before(path: string): Listing | undefined {
    return this.last?.path === path ? this.last : undefined;
  }

  /** The folder being shown as a column of it draws it: its first entries, folders first, in name order. */
  private column(): Entry[] {
    const { all } = this.s;
    return [...all.filter((entry) => entry.dir), ...all.filter((entry) => !entry.dir)].slice(0, COLUMN_ROWS);
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
    const url = urls.view(path, dir) + withFind(location.search);
    const pushing = mode === "push" && url !== location.pathname + location.search;
    const trail = state.trail ?? this.trailTo(path, pushing);
    const marked = trail ? { ...state, trail } : state;
    if (pushing) return history.pushState(marked, "", url);
    // A replaced file entry keeps what it remembered; a folder's entry takes only the mark it is given.
    history.replaceState(mode === "push" || dir ? marked : history.state, "", url);
  }

  /** The way back to the matches from `path`, while it is at or below the folder entered from them. */
  private trailTo(path: string, pushing: boolean): Trail | undefined {
    const trail = mark().trail;
    if (!trail || !(path === trail.root || path.startsWith(`${trail.root}/`))) return undefined;
    return { ...trail, steps: trail.steps + (pushing ? 1 : 0) };
  }

  /** The way back to the matches, while browsing below a folder entered from them. */
  trail(): Trail | null {
    const { s } = this;
    return s.finding ? null : (mark().trail ?? null);
  }

  /** Takes a listing as the folder being shown. */
  private take(listing: Listing): void {
    const { s } = this;
    if (this.listing?.path !== listing.path) this.last = this.listing;
    this.listing = listing;
    s.status = "ready";
    s.path = listing.path;
    this.real = listing.real ?? listing.path;
    s.link = listing.link === true;
    s.mtime = listing.m;
    s.all = listing.entries.map((item, rank) => toEntry(item, listing.path, rank));
    s.bytes = s.all.reduce((sum, entry) => sum + entry.size, 0);
    s.unlisted = listing.hidden ?? 0;
    s.readme = listing.readme;
  }

  /** Shows that nothing is at a path. */
  private lose(path: string): void {
    this.real = path;
    Object.assign(this.s, { status: "missing", path, link: false, mtime: 0, all: [], entries: [], open: null, readme: null, bytes: 0, unlisted: 0, filter: "" });
  }

  /**
   * Shows a folder. `select` puts the cursor on a name; `open` also gives that file the full width.
   * A folder holding the `--index` file opens that file, under the folder's own address, unless
   * a name was asked for or `listing` is set. `enter`: the folder is gone into from its column beside
   * the list, with what the pointer picked in the columns: the cursor lands on the entry the column
   * led on to, and the columns of that entry go on with the rest of the picks. See `focusOf`.
   */
  async showDir(
    path: string,
    opts: {
      select?: string;
      open?: string;
      listing?: boolean;
      history?: HistoryMode;
      enter?: string[];
      /** The matches are shown over the folder once it has come. */
      finding?: boolean;
      /** The folder is entered from the matches: see `Trail`. */
      trail?: Trail;
      /** A file opened from the matches: its folder gets no entry of its own, so closing it goes back to them. */
      alone?: boolean;
    } = {},
  ): Promise<void> {
    const { s } = this;
    const turn = ++this.turn;
    const heard = this.heard;
    const leaving = this.cur();
    if (leaving && s.status === "ready") this.remembered.set(s.path, { name: leaving.name, drawn: this.column().includes(leaving), dir: leaving.dir });
    // The columns of the folder the cursor lands on are asked for with the folder, and the folder waits a moment for
    // them: drawn together, every pane is on screen when the panes slide. See `landing`.
    const beside = this.landing(path, opts);
    const columns = beside === null ? null : preload(columnsUrl(beside, this.picked(beside), (at) => this.leftIn(at)));

    let listing: Listing;
    try {
      listing = await getJson<Listing>(urls.list(path));
      if (columns) await within(columns, COLUMNS_WAIT);
    } catch (error) {
      if (turn !== this.turn) return;
      // okfs did not answer: the page says so, and nothing here changes.
      if (error instanceof NoAnswer) return;
      if (!(error instanceof HttpError)) throw error;
      this.lose(path);
      this.setUrl(opts.history ?? "push", path, true);
      this.emit();
      return;
    }
    if (turn !== this.turn) return;

    const changed = s.path !== listing.path || s.status !== "ready";
    this.take(listing);
    s.finding = opts.finding === true;
    if (changed) s.filter = "";
    this.compute();
    const asked = opts.open !== undefined || opts.select !== undefined || opts.listing === true;
    const index = this.hasIndex() && !asked ? config.index : undefined;
    const open = opts.open ?? index;
    // The entry the folder's column led on to, found the way the column found it.
    const column = this.column();
    const focus = opts.enter?.[0] ?? this.leftIn(listing.path);
    const led = opts.enter && (column.find((entry) => entry.name === focus) ?? column[0])?.name;
    const wanted = open ?? opts.select ?? led ?? (changed ? this.remembered.get(listing.path)?.name : this.cur()?.name);
    if (open !== undefined && !s.entries.some((entry) => entry.name === open)) {
      // The file may be hidden by a filter that outlived a reload of the same folder.
      s.filter = "";
      this.compute();
    }
    this.select(wanted);
    const opened = open === undefined ? null : this.cur();
    s.open = opened && !opened.dir && opened.name === open ? opened : null;
    const landed = this.cur();
    if (landed && opts.enter?.length && landed.name === opts.enter[0]) this.picks = { root: landed.path, names: opts.enter.slice(1) };
    const mode = opts.history ?? "push";
    // An index page keeps its folder's address, so a link to the folder means the page.
    const paged = s.open !== null && index !== undefined;
    // A file opened from elsewhere gets its folder as the entry before it, so closing lands there.
    if (!s.open || paged || (mode === "push" && changed && !opts.alone)) {
      this.setUrl(mode, listing.path, true, { listing: !paged && this.hasIndex(), trail: opts.trail });
    }
    if (s.open && !paged) this.setUrl(mode, s.open.path, false, { opened: true });
    this.emit();
    // A change told while the listing was on its way may not be in it.
    if (heard !== this.heard) this.catchUp();
  }

  /**
   * The folder the cursor lands on when `showDir` shows `path`, where that is known before the folder's listing
   * comes: on a step out the folder left, and on a jump to a folder visited before the folder the cursor was on when
   * it was left. A step in needs none: its columns are in the answer for the folder above. See `startingAt`.
   */
  private landing(path: string, opts: { select?: string; open?: string; enter?: string[]; finding?: boolean }): string | null {
    const { s } = this;
    if (path === s.path || opts.open !== undefined || opts.enter || opts.finding) return null;
    if (opts.select !== undefined) return s.status === "ready" && joinPath(path, opts.select) === s.path ? s.path : null;
    const left = this.remembered.get(path);
    return left?.dir ? joinPath(path, left.name) : null;
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
    const { path, kind } = config.target;
    const find = findOf(location.search);
    if (find !== null && kind === "dir") return this.showMatches(find, path);
    return this.land(config.target);
  }

  /** Follows the address bar after back or forward. */
  private route(): Promise<void> {
    const { s } = this;
    const { path, dir } = parseLocation();
    const find = findOf(location.search);
    if (find !== null && dir) return this.showMatches(find, path);
    s.finding = false;
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
    const list = this.list();
    if (!list.length) return;
    const at = Math.max(0, Math.min(index, list.length - 1));
    if (s.finding && s.matches) {
      s.matches.cursor = at;
      this.more(at);
    } else {
      s.cursor = at;
    }
    this.emit();
  }

  move(delta: number): void {
    this.moveTo(this.at() + delta);
  }

  /**
   * Enters the folder under the cursor, or gives the file under it the full width. The cursor lands on the
   * entry the folder's column beside the list leads on to.
   */
  activate(index?: number): void {
    const { s } = this;
    // A file already at full width stays as it is: opening it again would only rewrite its history entry.
    if (s.open) return;
    if (s.finding) return this.openMatch(index);
    if (index !== undefined) s.cursor = index;
    const entry = this.cur();
    if (!entry) return;
    if (entry.dir) void this.showDir(entry.path, { enter: this.picked(entry.path) });
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
    if (s.finding) return this.leaveFind();
    // Above the folder the matches led into are the matches, not that folder's own folder.
    if (this.trail()?.root === s.path) return this.toMatches();
    if (s.path) void this.showDir(parentOf(s.path), { select: nameOf(s.path) });
  }

  /**
   * Lists every match of `query` in place of the folder, from anywhere in the tree, and pushes the folder's address
   * with `?find=` for it: back leaves the matches, and a reload or a shared link opens them again.
   */
  find(query: string): void {
    const { s } = this;
    const q = query.trim();
    if (!q || s.status === "loading") return;
    // Taken up again where they were left when they are the same matches.
    if (s.matches?.q !== q) s.matches = newMatches(q);
    s.finding = true;
    s.open = null;
    s.palette = false;
    history.pushState({ found: true } satisfies Mark, "", this.matchesUrl());
    this.emit();
    if (!s.matches.ready) void this.askMatches(false);
  }

  /** The matches for another query, in the same place in history. */
  refine(query: string): void {
    const { s } = this;
    const q = query.trim();
    if (!s.finding || !s.matches || !q || q === s.matches.q) return;
    s.matches.q = q;
    history.replaceState(history.state, "", this.matchesUrl());
    this.emit();
    void this.askMatches(false);
  }

  /** Sorts the matches by `key`. The same key again turns the order around; no key steps to the next one. */
  setMatchSort(key?: MatchOrder): void {
    const { matches } = this.s;
    if (!matches) return;
    const { sort } = matches;
    const next = key ?? MATCH_ORDERS[(MATCH_ORDERS.indexOf(sort.key) + 1) % MATCH_ORDERS.length] ?? "rank";
    matches.sort = { key: next, rev: next === sort.key && next !== "rank" ? !sort.rev : false };
    history.replaceState({ ...mark(), sort: matches.sort }, "", location.href);
    this.emit();
    void this.askMatches(false);
  }

  /** Leaves the matches for the folder they were opened over. */
  leaveFind(): void {
    const { s } = this;
    if (!s.finding) return;
    if (mark().found) {
      history.back();
      return;
    }
    s.finding = false;
    this.setUrl("replace", s.path, true, { listing: this.hasIndex() });
    this.emit();
  }

  /** Goes back to the matches from a folder entered from them, however deep, the way back goes: see `Trail`. */
  toMatches(): void {
    const trail = this.trail();
    if (!trail) return;
    if (trail.steps > 0) {
      history.go(-trail.steps);
      return;
    }
    this.find(trail.q);
  }

  /** Asks for the next page of the matches once `seen`, the cursor or the end of what is on screen, comes near the last loaded. */
  more(seen: number): void {
    const { matches } = this.s;
    if (!matches?.ready || matches.list.length >= matches.total) return;
    if (seen >= matches.list.length - MATCH_AHEAD) void this.askMatches(true);
  }

  /** Opens the match under the cursor, or at `index`: a folder is entered, a file is given the full width in its folder. */
  private openMatch(index?: number): void {
    const { s } = this;
    const matches = s.matches;
    if (!matches) return;
    if (index !== undefined) matches.cursor = index;
    const entry = this.cur();
    if (!entry) return;
    // Where the matches were left, for a return to them after a reload.
    history.replaceState({ ...mark(), at: matches.cursor, sort: matches.sort } satisfies Mark, "", location.href);
    if (entry.dir) {
      const trail = { q: matches.q, total: matches.total, root: entry.path, steps: 1 };
      void this.showDir(entry.path, { enter: this.picked(entry.path), trail });
    } else {
      void this.showDir(parentOf(entry.path), { open: entry.name, alone: true });
    }
  }

  /** The matches for `q` over the folder at `path`, as the address bar has them after back, forward or a reload. */
  private async showMatches(q: string, path: string): Promise<void> {
    const { s } = this;
    if (s.matches?.q !== q) {
      const kept = mark();
      s.matches = newMatches(q, kept.sort);
      s.matches.cursor = kept.at ?? 0;
      void this.askMatches(false);
    }
    s.open = null;
    if (s.status === "ready" && s.path === path) {
      s.finding = true;
      this.emit();
      return;
    }
    await this.showDir(path, { history: "none", listing: true, finding: true });
  }

  /** The address of the matches: the folder they are over, with `?find=` for them. */
  private matchesUrl(): string {
    return urls.view(this.s.path, true) + withFind(location.search, this.s.matches?.q);
  }

  /** Counts the asks for the first page of the matches, so an answer for a query or a sort since left is dropped. */
  private matchTurn = 0;
  private asking: AbortController | null = null;
  private askingMore = false;

  /** Asks for the first page of the matches, or with `more` for the page after those loaded. */
  private async askMatches(more: boolean): Promise<void> {
    const matches = this.s.matches;
    if (!matches || (more && this.askingMore)) return;
    if (!more) {
      this.asking?.abort();
      this.matchTurn++;
    }
    const turn = this.matchTurn;
    const abort = new AbortController();
    if (more) this.askingMore = true;
    else this.asking = abort;
    const { q, sort } = matches;
    const offset = more ? matches.list.length : 0;
    try {
      const found = await getJson<Found>(urls.search(q, { offset, limit: MATCH_PAGE, sort: sort.key, rev: sort.rev }), abort.signal);
      if (turn !== this.matchTurn || this.s.matches !== matches) return;
      const list = found.hits.map((hit, rank) => ({ entry: matchEntry(hit, offset + rank), hit }));
      if (more) {
        matches.list = [...matches.list, ...list];
      } else {
        // A first answer lands on the match the cursor was left on, when there is one; a new query starts at the top.
        const at = matches.ready ? 0 : matches.cursor;
        matches.list = list;
        matches.took = found.took;
        matches.cursor = Math.max(0, Math.min(at, list.length - 1));
        matches.ready = true;
      }
      matches.total = found.total;
      this.emit();
      // The first walk of the tree is still going on: what it finds later is asked for again.
      if (!more && !found.ready) setTimeout(() => turn === this.matchTurn && void this.askMatches(false), 1000);
    } catch {
      // Given up for a newer ask, or the server did not answer: the last answer stays.
    } finally {
      if (more) this.askingMore = false;
    }
  }

  /** While a file is open: moves to the next or previous file, skipping folders. */
  step(delta: 1 | -1): void {
    const { s } = this;
    for (let i = s.cursor + delta; i >= 0 && i < s.entries.length; i += delta) {
      const entry = s.entries[i];
      if (entry && !entry.dir) return this.openEntry(entry, "replace");
    }
  }

  /**
   * Shows or hides the hidden entries, and lists the folder again with or without them. The cursor stays on its
   * entry, or goes to the nearest one left. The choice is kept for this browser.
   */
  setHidden(on = !this.s.hidden): void {
    setShowsHidden(on);
    this.s.hidden = on;
    this.emit();
    this.catchUp();
    // The matches change too: the hidden ones are searched only while they are shown.
    if (this.s.matches) void this.askMatches(false);
  }

  /**
   * Flips the file on show between its source and what is made from it. The choice holds for the files of
   * its kind that follow. A file with one form stays as it is. `shown` is a file other than the cursor's, such
   * as one the pointer rests on in a column.
   */
  flipRaw(shown?: Entry): void {
    const { s } = this;
    const file = shown ?? this.flippable();
    if (!file || !hasSource(file)) return;
    const form = formOf(file);
    s.flipped = s.flipped.includes(form) ? s.flipped.filter((kept) => kept !== form) : [...s.flipped, form];
    this.emit();
  }

  /** Turns wrapping on or off for the prose on show. The choice holds for the files of its kind that follow. */
  flipWrap(): void {
    const file = this.wrappable();
    if (!file) return;
    const { s } = this;
    s.unwrapped = s.unwrapped.includes(file.kind) ? s.unwrapped.filter((kept) => kept !== file.kind) : [...s.unwrapped, file.kind];
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

  /** Puts up a notice for a moment. A newer one takes its place. */
  say(text: string): void {
    clearTimeout(this.noticed);
    this.s.notice = text;
    this.emit();
    this.noticed = setTimeout(() => {
      this.s.notice = null;
      this.emit();
    }, NOTICE_MS);
  }

  /**
   * The page's own address for the open file or the entry under the cursor, unless one is given, to share it. With
   * the key, when okfs asks for one: this browser keeps it in a cookie, and whoever is sent the link has none.
   */
  linkTo(entry: Pick<Entry, "path" | "dir"> | null = this.s.open ?? this.cur()): string | null {
    if (!entry) return null;
    const link = new URL(urls.view(entry.path, entry.dir), location.href);
    if (config.key) link.searchParams.set("key", config.key);
    return link.href;
  }

  /** Copies the link to the open file or the entry under the cursor, and says whether it did. */
  async copyLink(entry: Entry | null = this.s.open ?? this.cur()): Promise<void> {
    const link = this.linkTo(entry);
    if (!entry || !link) return;
    try {
      await copyText(link);
      this.say(`Copied the link to “${entry.name}”`);
    } catch {
      this.say("The browser would not copy the link");
    }
  }

  /** The folder new files go into: the one on screen, while one is and adding is on. Never over the matches. */
  addsTo(): string | null {
    const { s } = this;
    return config.upload && s.status === "ready" && !s.finding ? s.path : null;
  }

  /** Puts up the dialog that names a new file or folder in the folder on screen, or takes it down. */
  setNaming(kind: Naming["kind"] | null): void {
    const dir = this.addsTo();
    this.s.naming = kind && dir !== null ? { kind, dir } : null;
    this.emit();
  }

  /** Shows a file or folder just made, under the cursor in its folder, when that folder is the one on screen. */
  async made(path: string): Promise<void> {
    const { s } = this;
    if (parentOf(path) !== s.path) return;
    await this.showDir(s.path, { select: nameOf(path), listing: true, history: "none" });
  }

  /** The folder being shown, as something to delete. The served folder itself is never offered. */
  here(): Doomed | null {
    const { s } = this;
    if (!config.delete || s.status !== "ready" || !s.path) return null;
    return { name: nameOf(s.path), path: s.path, dir: true, link: s.link, kind: "folder", count: s.all.length, unlisted: s.unlisted };
  }

  /** Puts up the delete dialog, for the open file or the entry under the cursor unless one is given. */
  askDelete(doomed: Doomed | null = this.s.open ?? this.cur()): void {
    // A match is deleted from its own folder, where the list shows what is left.
    if (!config.delete || !doomed || this.s.finding) return;
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

/** Matches for `q`, before any has come. */
function newMatches(q: string, sort: Matches["sort"] = { key: "rank", rev: false }): Matches {
  return { q, list: [], total: 0, took: 0, sort, cursor: 0, ready: false };
}

/** A match as an entry of a list, with its folder's path in front of its name. */
export function matchEntry(hit: Hit, rank: number): Entry {
  return toEntry({ n: nameOf(hit.path), d: hit.dir, s: hit.s, m: hit.m, c: hit.c }, parentOf(hit.path), rank);
}

export const store = new Store();
