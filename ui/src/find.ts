// What the palette's search shows while the server is still working on what was just typed.

import type { Found } from "./api";

/** The server's answer, with the query it answers. */
export interface Answer {
  q: string;
  found: Found;
}

/** Whether the answer on hand is for the query asked: only then can "nothing matches" be said. */
export const waiting = (asked: string, answer: Answer | null): boolean => answer?.q !== asked;

/**
 * How long to hold the next request back. The first keystroke after a pause goes at once,
 * and a burst is let through no faster than `settle` apart, so fast typing makes one request
 * for the latest text instead of one per key.
 */
export const holdBack = (now: number, lastSent: number, settle: number): number => Math.max(0, settle - (now - lastSent));

/** The time the server took, as short as it reads: `0.4 ms`, `12 ms`. */
export const took = (ms: number): string => (ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`);
