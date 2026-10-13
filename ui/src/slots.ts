// How the window is cut into slots, and what the folder under the cursor puts in them.

import type { Listing } from "./api";

/**
 * The window is cut into equal slots: four from 1,200 px, three from 900 px, two under that. The main list is
 * one of them at every width, so nothing changes width as the cursor moves.
 */
export const slotsFor = (width: number): number => Math.min(4, Math.max(2, Math.floor(width / 300)));

/** The slots the window has now. */
export const slots = (): number => slotsFor(innerWidth);

/**
 * Fills the slots beside the main list from the answer for the folder under the cursor: that folder's listing,
 * then the listing of each folder its first entry leads to, one slot a level while there are folders and slots.
 * The first is `undefined` while the folder's answer is on its way: its column has a header and no rows yet.
 */
export function columnsOf(listing: Listing | undefined, slots: number): (Listing | undefined)[] {
  const levels = [listing];
  for (let at = listing?.under; at && levels.length < slots - 1; at = at.under) levels.push(at);
  return levels;
}
