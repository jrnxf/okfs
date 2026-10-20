// The keys that work on the list and on an open file. The palette, the dialogs and the filter take their own.

import type { Store } from "./store";

/** What the keys need from the page around the list. */
export interface KeyHost {
  /** Puts the focus where the list is narrowed: the folder's filter, or the query of the matches. */
  filter: () => void;
  closeMenu: () => void;
  flipScheme: () => void;
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
  if (press.pressing && (press.key === " " || press.key === "Enter")) return undefined;
  if (press.shift && press.key === "D") return () => store.askDelete();
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
      else if (s.filter) store.setFilter("");
      else if (store.trail()) store.toMatches();
      host.closeMenu();
    },
    Home: () => store.moveTo(0),
    End: () => store.moveTo(s.entries.length - 1),
    "/": host.filter,
    s: () => store.setSort(),
    t: host.flipScheme,
    "?": () => store.setHelp(true),
  };
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
    PageDown: () => store.move(10),
    PageUp: () => store.move(-10),
    "/": host.filter,
    s: () => store.setMatchSort(),
    ".": () => store.setHidden(),
    t: host.flipScheme,
    "?": () => store.setHelp(true),
  };
}
