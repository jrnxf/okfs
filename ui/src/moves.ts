// How each pane moves when the panes slide: from where it was on screen into its new slot. Kept apart from the page,
// which `slide.ts` draws it on, so the moves can be checked without one.

/** A pane's left and right edges on screen, in px. */
export interface Edges {
  left: number;
  right: number;
}

/** A pane on screen by its key: the path of its folder, or of the file it shows. An empty key is never the same pane. */
export interface Placed {
  key: string;
  rect: Edges;
}

/** A pane as it was before the move: where it was drawn, part way through a slide still running, and how far it had faded in. */
export interface Before extends Placed {
  opacity: number;
}

/** How a pane comes into its slot. */
export interface Move {
  /** How far its left edge starts from where it ends, in px. */
  from: number;
  /** Only its left edge moves: it is held at the strip's right edge, and grows or narrows into its slot. Else it moves whole. */
  edge: boolean;
  /** The opacity it starts at. It ends at 1. */
  opacity: number;
}

/** Two edges a fraction of a pixel apart are at the same place. */
const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;

/** The pane `now` was before the move, if it was on screen. */
export function beforeOf(was: Before[], now: Placed): Before | undefined {
  return now.key ? was.find((it) => it.key === now.key) : undefined;
}

/**
 * The way the panes move, from those kept: how far the left edge of the first kept pane that moves has to go. A pane
 * that comes or goes moves as far. Undefined when no kept pane moves.
 */
export function alongOf(was: Before[], now: Placed[]): number | undefined {
  for (const pane of now) {
    const it = beforeOf(was, pane);
    if (it && !same(it.rect.left, pane.rect.left)) return it.rect.left - pane.rect.left;
  }
  return undefined;
}

/**
 * How the pane `now` moves into its slot when the panes move `along`. A kept pane starts where it was and as far
 * faded in as it was. A pane that comes starts `along` away, unseen. A pane held at the strip's right edge, `right`,
 * moves only its left edge: moved whole, it would leave a gap at the edge of the window as it comes from the left,
 * or the controls at its right end would slide away and back as it grows or narrows. A pane that comes from the
 * right moves whole, in from past the edge.
 */
export function moveOf(now: Edges, was: Before | undefined, along: number, right: number): Move {
  if (was) {
    const from = was.rect.left - now.left;
    return { from, edge: !same(from, 0) && same(was.rect.right, now.right), opacity: was.opacity };
  }
  return { from: along, edge: along < 0 && same(now.right, right), opacity: 0 };
}

/**
 * What a pane that has just gone from the slots shows while the panes slide: `going`, what it showed as it slid out
 * after the last draw, and `was`, what it showed in the slots then. One that goes keeps what it showed, so it slides
 * out live and whole; one back in the slots, `here`, shows what it is given there.
 */
export function goingOf<T>(here: boolean, was: T | null, going: T | null): T | null {
  return here ? null : (was ?? going);
}
