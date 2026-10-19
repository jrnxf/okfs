// How the window is cut into slots, and what the folder under the cursor puts in them.

import { type Item, type Listing, joinPath } from "./api";

/**
 * The window is cut into equal slots: four from 1,200 px, three from 900 px, two under that. The main list is
 * one of them at every width, so nothing changes width as the cursor moves.
 */
export const slotsFor = (width: number): number => Math.min(4, Math.max(2, Math.floor(width / 300)));

/** The slots the window has now. */
export const slots = (): number => slotsFor(innerWidth);

/** The entry a column leads on to: the one picked in it, when it is there, or else its first. */
export const focusOf = (listing: Listing, picked?: string): Item | undefined =>
  (picked === undefined ? undefined : listing.entries.find((item) => item.n === picked)) ?? listing.entries[0];

/** What the slots beside the main list hold for the folder under the cursor. */
export interface Chain {
  /**
   * A column for each level. The first is `undefined` while the folder's answer is on its way: its column has a
   * header and no rows yet.
   */
  levels: (Listing | undefined)[];
  /** For each column that leads on to something on screen, the name of the entry it leads on to. */
  led: string[];
  /** The file the last column leads on to, shown in the slots after it. */
  file: { listing: Listing; item: Item; at: number } | null;
}

/**
 * Fills the slots beside the main list from the answer for the folder under the cursor: that folder's listing,
 * then the listing of each folder its focused entry leads to, one slot a level while there are folders and slots.
 * A column's focused entry is the one `picks` names for its level, or else its first. A level of the answer that
 * is not the inside of that entry, as in an answer for other picks that is still on screen, ends the columns. So
 * does a file: it is shown after the last column, when a slot is left for it.
 */
export function columnsOf(listing: Listing | undefined, slots: number, picks: string[] = []): Chain {
  const chain: Chain = { levels: [listing], led: [], file: null };
  for (let at = listing, level = 0; at && chain.levels.length < slots; level++) {
    const item = focusOf(at, picks[level]);
    if (!item) break;
    if (!item.d) {
      if (chain.levels.length < slots - 1) {
        chain.file = { listing: at, item, at: at.entries.indexOf(item) };
        chain.led.push(item.n);
      }
      break;
    }
    const inside = at.under;
    if (!inside || inside.path !== joinPath(at.path, item.n) || chain.levels.length >= slots - 1) break;
    chain.levels.push(inside);
    chain.led.push(item.n);
    at = inside;
  }
  return chain;
}

/**
 * The part of an answer that starts at the folder `path`. The answer for a folder above it already holds its
 * columns, so a step into the folder under the cursor shows them with the step while the folder's own answer is
 * on its way: no column shows the last folder's rows under this one's name, and each is in its slot for the slide.
 */
export function startingAt(listing: Listing | undefined, path: string): Listing | undefined {
  for (let at = listing; at; at = at.under) if (at.path === path) return at;
  return listing;
}
