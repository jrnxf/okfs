// The keys that work on the list and on an open file. The palette, the dialogs and the filter take their own.

import { config } from "./config";
import type { Store } from "./store";
import { pick } from "./upload";

/** What the keys need from the page around the list. */
export interface KeyHost {
  /** Puts the focus where the list is narrowed: the folder's filter, or the query of the matches. */
  filter: () => void;
  closeMenu: () => void;
  flipScheme: () => void;
  /** How many rows of the list a page is: those on screen at once. */
  page: () => number;
  /** Opens the menu of the selection, or of the row under the cursor, at that row. */
  menu: () => void;
  /** Copies the path of the selection, or of the row under the cursor. */
  copyPath: () => void;
}

/** All that the keys ask about a press. */
export interface Press {
  key: string;
  shift: boolean;
  /** Ctrl, Cmd or Alt is down: the press is a shortcut of the browser or of the palette. */
  chord: boolean;
  /** The focus is where text is typed: the press is a character of that text. */
  typing: boolean;
  /** The focus is on something that space and Enter work by themselves: a button, a link, a player. */
  pressing: boolean;
}

const TYPED = "input, textarea, select, [contenteditable]";
const PRESSED = "button, a[href], summary, video, audio";

/** Reads a press from its event. */
export function pressOf(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "target">): Press {
  const target = event.target as Partial<Pick<Element, "closest">> | null;
  const within = (selector: string): boolean => Boolean(target?.closest?.(selector));
  return {
    key: event.key,
    shift: event.shiftKey,
    chord: event.ctrlKey || event.metaKey || event.altKey,
    typing: within(TYPED),
    pressing: within(PRESSED),
  };
}

/** What a press does on the list or on an open file, or nothing when the press is not the list's to take. */
export function keyFor(store: Store, host: KeyHost, press: Press): (() => void) | undefined {
  if (press.typing || press.chord) return undefined;
  // While a file is edited only Esc is the list's, and it leaves the editor: any other key would leave its file.
  if (store.s.editing) return press.key === "Escape" ? () => store.leave(() => undefined) : undefined;
  if (press.pressing && (press.key === " " || press.key === "Enter")) return undefined;
  // The menu key, and Shift F10 as in every desktop: the menu of the row under the cursor.
  if (press.key === "ContextMenu" || (press.shift && press.key === "F10")) return host.menu;
  if (store.s.trashView) {
    if (press.key === "Backspace") return press.shift ? () => store.askForget(store.trashCur()) : () => store.showTrash(false);
    return trashKeys(store, host)[press.key];
  }
  if (press.shift && press.key === "D") return () => store.askDelete();
  // Shift with an arrow or Space selects from the anchor: see pick.ts.
  if (press.shift && !store.s.finding && !store.s.open) {
    const by = { ArrowDown: 1, ArrowUp: -1, J: 1, K: -1 }[press.key];
    if (by !== undefined) return () => store.pickMove(by);
    if (press.key === " ") return () => store.pickCursor(true);
  }
  return listKeys(store, host)[press.key];
}

export function listKeys(store: Store, host: KeyHost): Record<string, () => void> {
  const { s } = store;
  // With a file open, down and up step from file to file instead. Left goes back to the list the file was opened
  // from, the way right opened it.
  const modal = s.open !== null;
  const down = () => (modal ? store.step(1) : store.move(1));
  const up = () => (modal ? store.step(-1) : store.move(-1));
  const left = () => store.up();
  const right = () => store.activate();
  if (s.finding) return findKeys(store, host, { down, up, left, right });
  return {
    j: down,
    ArrowDown: down,
    k: up,
    ArrowUp: up,
    h: left,
    ArrowLeft: left,
    // Not taken at all on an open file: a player there seeks with it.
    ...(modal ? {} : { l: right, ArrowRight: right }),
    Enter: () => store.activate(),
    ".": () => store.setHidden(),
    // Only a file with two forms has the key: on any other it does nothing, and is not offered.
    ...(store.flippable() ? { r: () => store.flipRaw() } : {}),
    ...(store.wrappable() ? { w: () => store.flipWrap() } : {}),
    Backspace: () => store.up(),
    "-": () => store.up(),
    Escape: () => {
      if (s.open) store.close();
      else if (store.clearPicks()) return;
      else if (s.filter) store.setFilter("");
      else if (store.trail()) store.toMatches();
      host.closeMenu();
    },
    Home: () => store.moveTo(0),
    End: () => store.moveTo(s.entries.length - 1),
    // Not taken on an open file: the file scrolls a page with them.
    ...(modal ? {} : { PageDown: () => store.move(host.page()), PageUp: () => store.move(-host.page()) }),
    "/": host.filter,
    y: () => void store.copyLink(),
    Y: host.copyPath,
    s: () => store.setSort(),
    t: host.flipScheme,
    "?": () => store.setHelp(true),
    // Not over an open file: its keys are the file's, and a menu or a selection is the list's.
    ...(modal ? {} : { a: host.menu, " ": () => store.pickCursor(false) }),
    ...adding(store),
    ...changing(store),
  };
}

/**
 * The keys that change entries that are there: rename, move and copy, each while its flag is on. Not over an open
 * file, where the keys are the file's.
 */
function changing(store: Store): Record<string, () => void> {
  if (store.s.open || store.s.status !== "ready") return {};
  const rename = () => store.startRename();
  return {
    ...(config.edit ? { F2: rename, R: rename, m: () => store.startPicking("move") } : {}),
    ...(config.upload ? { c: () => store.startPicking("copy") } : {}),
  };
}

/** The keys in the Trash: moving through it, putting back, deleting for good, and the way out. */
function trashKeys(store: Store, host: KeyHost): Record<string, () => void> {
  const leave = () => store.showTrash(false);
  const forget = () => store.askForget(store.trashCur());
  return {
    j: () => store.trashMove(1),
    ArrowDown: () => store.trashMove(1),
    k: () => store.trashMove(-1),
    ArrowUp: () => store.trashMove(-1),
    Home: () => store.trashMoveTo(0),
    End: () => store.trashMoveTo(Number.MAX_SAFE_INTEGER),
    PageDown: () => store.trashMove(host.page()),
    PageUp: () => store.trashMove(-host.page()),
    R: () => void store.restore(),
    // Shift and Backspace, or Delete: Backspace alone is the way out.
    Delete: forget,
    a: host.menu,
    Escape: leave,
    h: leave,
    ArrowLeft: leave,
    "-": leave,
    t: host.flipScheme,
    "?": () => store.setHelp(true),
  };
}

/**
 * The keys that change what is there: edit the text file, while changing files is on, and upload into the folder on
 * screen and make a new file in it, while adding is on.
 */
function adding(store: Store): Record<string, () => void> {
  const dir = store.addsTo();
  const edits: Record<string, () => void> = store.editable(store.s.open ?? store.cur()) ? { e: () => store.edit() } : {};
  if (dir === null || store.s.open) return edits;
  return { ...edits, u: () => pick(dir), n: () => void store.newHere("file"), N: () => void store.newHere("folder") };
}

/** The keys on the matches: as on a folder, except that the ways out of the folder go back to it, and `s` sorts the matches. */
function findKeys(store: Store, host: KeyHost, move: Record<"down" | "up" | "left" | "right", () => void>): Record<string, () => void> {
  const { down, up, left, right } = move;
  const last = () => store.list().length - 1;
  return {
    j: down,
    ArrowDown: down,
    k: up,
    ArrowUp: up,
    h: left,
    ArrowLeft: left,
    l: right,
    ArrowRight: right,
    Enter: () => store.activate(),
    Backspace: left,
    "-": left,
    Escape: () => {
      store.leaveFind();
      host.closeMenu();
    },
    Home: () => store.moveTo(0),
    End: () => store.moveTo(last()),
    PageDown: () => store.move(host.page()),
    PageUp: () => store.move(-host.page()),
    "/": host.filter,
    y: () => void store.copyLink(),
    s: () => store.setMatchSort(),
    ".": () => store.setHidden(),
    t: host.flipScheme,
    "?": () => store.setHelp(true),
  };
}
