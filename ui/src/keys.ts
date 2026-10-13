// The keys that work on the list and on an open file. The palette, the dialogs and the filter take their own.

import type { Store } from "./store";

/** What the keys need from the page around the list. */
export interface KeyHost {
  /** How many entries share a row of the list: one, or the grid's columns. */
  across: number;
  filter: () => void;
  closeMenu: () => void;
  flipScheme: () => void;
}

export function listKeys(store: Store, host: KeyHost): Record<string, () => void> {
  const { s } = store;
  // With a file open, the keys that move the cursor step from file to file instead.
  const modal = s.open !== null;
  const across = s.view === "grid" ? host.across : 1;
  const down = () => (modal ? store.step(1) : store.move(across));
  const up = () => (modal ? store.step(-1) : store.move(-across));
  const left = () => (modal ? store.step(-1) : across > 1 ? store.move(-1) : store.up());
  const right = () => (modal ? store.step(1) : across > 1 ? store.move(1) : store.activate());
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
    Backspace: () => store.up(),
    "-": () => store.up(),
    Escape: () => {
      if (s.open) store.close();
      else if (s.filter) store.setFilter("");
      host.closeMenu();
    },
    Home: () => store.moveTo(0),
    End: () => store.moveTo(s.entries.length - 1),
    "/": host.filter,
    g: () => store.setView(),
    p: () => store.setPane(),
    s: () => store.setSort(),
    t: host.flipScheme,
    "?": () => store.setHelp(true),
  };
}
