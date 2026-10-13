// How the window is cut into slots, and what the folder under the cursor puts in them.

import type { Item, Listing } from "./api";

/**
 * The window is cut into equal slots: four from 1,200 px, three from 900 px, two under that. The main list is
 * one of them at every width, so nothing changes width as the cursor moves.
 */
export const slotsFor = (width: number): number => Math.min(4, Math.max(2, Math.floor(width / 300)));

/** The slots the window has now. */
export const slots = (): number => slotsFor(innerWidth);

/** What is beside the main list when the cursor is on a folder. */
export interface Chain {
  /**
   * That folder's listing, then the listing of each folder its first entry leads to. The first is `undefined`
   * while the folder's answer is on its way: its column has a header and no rows yet.
   */
  levels: (Listing | undefined)[];
  /** The file the path ends on, by its folder and its name, when a slot is left for its preview. */
  file: { dir: string; item: Item } | null;
}

/**
 * Fills the slots beside the main list from the answer for the folder under the cursor: a column for each
 * folder down the first entries, one slot a level while there are folders and slots, then the file the path
 * reaches in every slot left. With no slot left there is no preview.
 */
export function chainOf(listing: Listing | undefined, slots: number): Chain {
  const levels = [listing];
  for (let at = listing; at; ) {
    const first = at.entries[0];
    const room = levels.length < slots - 1;
    if (first && !first.d) return { levels, file: room ? { dir: at.path, item: first } : null };
    if (!first || !room || !at.under) break;
    at = at.under;
    levels.push(at);
  }
  return { levels, file: null };
}
