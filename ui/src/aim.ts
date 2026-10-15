// Hover that previews at once, and does not jump while the pointer is on its way to the preview.
//
// The aiming test is the one of jQuery-menu-aim (Ben Kamens, https://github.com/kamens/jQuery-Menu-Aim, MIT),
// the "Amazon dropdown" fix: the pointer is heading for the pane when, against where it was a few moves ago, the
// slope to the pane's near top corner has fallen and the slope to its near bottom corner has risen, which is the
// pointer being inside the cone between its old place and the pane's edge. It is vendored as a pure function
// because the published ports tie themselves to a fixed set of menu items in the page (this list is virtual and
// redrawn by Preact) and add a dwell timer of their own.
//
// MIT License. Copyright (c) 2013 Ben Kamens. Permission is hereby granted, free of charge, to any person
// obtaining a copy of this software and associated documentation files, to deal in the software without
// restriction, subject to the copyright notice and this permission notice being included in all copies. The
// software is provided "as is", without warranty of any kind.

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How far above and below the pane's edge a pointer may still be counted as heading for it. */
const TOLERANCE = 75;
/** Pointer positions kept: the newest is the pointer, the oldest is where it was a few moves ago. */
const TRAIL = 3;
/** A held hover is looked at again after this long, in case the pointer stopped on the way. */
export const AIM_RECHECK = 100;

const slope = (a: Point, b: Point): number => (b.y - a.y) / (b.x - a.x);

/** Whether a pointer that moved from `from` to `to` is heading for `pane`, which lies to the right of `list`. */
export function heading(from: Point, to: Point, list: Box, pane: Box): boolean {
  // From outside the list there is nothing to hold: the pointer came in from elsewhere.
  if (from.x < list.left || from.x > list.right || from.y < list.top || from.y > list.bottom) return false;
  // The pane's near edge, with a margin above and below.
  const top: Point = { x: pane.left, y: pane.top - TOLERANCE };
  const bottom: Point = { x: pane.left, y: pane.bottom + TOLERANCE };
  return slope(to, top) < slope(from, top) && slope(to, bottom) > slope(from, bottom);
}

/** The pointer's last few places, and whether it is heading for a pane. */
export class Aim {
  private trail: Point[] = [];
  /** Where the pointer was when a hover was last held: if it has not moved since, it has stopped. */
  private held: Point | null = null;

  /** Takes a pointer position. Returns false when it is the place it already was. */
  track(point: Point): boolean {
    const last = this.trail[this.trail.length - 1];
    if (last && last.x === point.x && last.y === point.y) return false;
    this.trail.push(point);
    if (this.trail.length > TRAIL) this.trail.shift();
    return true;
  }

  /** True while the pointer is on its way to the pane: a hover should wait. */
  aiming(list: Box, pane: Box): boolean {
    const to = this.trail[this.trail.length - 1];
    const from = this.trail[0];
    if (!to || !from) return false;
    // At rest it is no longer on its way.
    if (this.held && this.held.x === to.x && this.held.y === to.y) return false;
    const on = heading(from, to, list, pane);
    this.held = on ? to : null;
    return on;
  }

  reset(): void {
    this.trail = [];
    this.held = null;
  }
}
