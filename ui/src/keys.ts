// The keys that work on the list and on an open file. The palette, the dialogs and the filter take their own.

import type { Store } from "./store";

/** What the keys need from the page around the list. */
export interface KeyHost {
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
  // With a file open, the keys that move the cursor step from file to file instead.
  const modal = s.open !== null;
  const down = () => (modal ? store.step(1) : store.move(1));
  const up = () => (modal ? store.step(-1) : store.move(-1));
  const left = () => (modal ? store.step(-1) : store.up());
  const right = () => (modal ? store.step(1) : store.activate());
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
    // A file at full width keeps space for itself: it pages through a long text.
    ...(modal ? {} : { " ": () => store.setPeek() }),
    // Only a file with two forms has the key: on any other it does nothing, and is not offered.
    ...(store.flippable() ? { r: () => store.flipRaw() } : {}),
    Backspace: () => store.up(),
    "-": () => store.up(),
    Escape: () => {
      if (s.open) store.close();
      else if (s.peek) store.setPeek(false);
      else if (s.filter) store.setFilter("");
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
