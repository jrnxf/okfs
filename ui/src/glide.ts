// The cursor's highlight travels with the panes when they slide: from the row it was on to the row it lands on, so the
// eye can follow it from one list to the next. The main list is always in the first slot, so on a step it moves up or
// down there while the rows slide sideways under it. See `useSlide`.

/**
 * How long the highlight takes to travel. Longer than the slide: on the slide's own time and curve it covered most of
 * the way in its first three frames, too soon for the eye to find it, let alone follow it. Nothing waits on it: a
 * key that moves the cursor stops it, and the next step takes it on from where it has got to.
 */
export const GLIDE_MS = 260;
/** Easing in and out, gently, as a thing moving from one place to another on screen does: no frame jumps far. */
export const GLIDE_EASE = "cubic-bezier(0.37, 0, 0.63, 1)";

/** A box on screen, in px, from the top left corner of the strip. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Two lengths a fraction of a pixel apart are the same. */
const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;

/** `rect`, a box on screen, measured from `origin`, the strip's. */
export const boxOf = (rect: DOMRectReadOnly, origin: DOMRectReadOnly): Box => ({
  x: rect.left - origin.left,
  y: rect.top - origin.top,
  w: rect.width,
  h: rect.height,
});

/**
 * Where the virtual list draws row `index`, from `rows`, the box of all its rows, and the height of one. Worked out,
 * not looked up: the list draws only the rows in view, and it draws them a render after it scrolls, so the row the
 * cursor lands on far down a list just shown is not in the page yet when the glide starts. See `VList`.
 */
export const rowOf = (rows: Box, index: number, rowH: number): Box => ({ x: rows.x, y: rows.y + index * rowH, w: rows.w, h: rowH });

/** True when `row` is wholly in `view`, the box the list scrolls in. */
export const seen = (row: Box, view: Box): boolean => row.y > view.y - 0.5 && row.y + row.h < view.y + view.h + 0.5;

/**
 * The frames of the highlight's travel from `from` to `to`, or none when it has nowhere to go: it lands where it was,
 * or the rows differ in size, as a list of matches two slots wide does from a folder's. The bar is the size of the
 * row it lands on and only moves, so the browser can move it without drawing it again.
 */
export function glideOf(from: Box, to: Box): Keyframe[] | null {
  if (!same(from.w, to.w) || !same(from.h, to.h) || (same(from.x, to.x) && same(from.y, to.y))) return null;
  return [{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: `translate(${to.x}px, ${to.y}px)` }];
}

/** The highlight where it is drawn: the travelling bar's while it runs, or else the cursor's row in the main list. */
export function highlightOf(strip: HTMLElement): Box | null {
  const origin = strip.getBoundingClientRect();
  const drawn = strip.querySelector<HTMLElement>(".glide") ?? strip.querySelector<HTMLElement>(".left:not(.ghost) .row[aria-selected='true']");
  return drawn ? boxOf(drawn.getBoundingClientRect(), origin) : null;
}

/** Where the main list of `strip` draws the row at `index`, if it is in view. */
export function landingOf(strip: HTMLElement, index: number): Box | null {
  const list = strip.querySelector<HTMLElement>(".left:not(.ghost) .list");
  const rows = list?.querySelector<HTMLElement>(".rows");
  const probe = list?.querySelector<HTMLElement>(".probe");
  if (!list || !rows || !probe || index < 0) return null;
  const origin = strip.getBoundingClientRect();
  const row = rowOf(boxOf(rows.getBoundingClientRect(), origin), index, probe.getBoundingClientRect().height);
  return seen(row, boxOf(list.getBoundingClientRect(), origin)) ? row : null;
}

/**
 * One travel of the highlight over `strip`: a bar drawn as the cursor's row is, above the panes and the copies sliding
 * out, while the rows' own highlight is hidden. It goes once it lands, or when it is stopped.
 */
export class Glide {
  private readonly bar: HTMLElement;
  private readonly run: Animation;

  constructor(
    private readonly strip: HTMLElement,
    /** The cursor it lands on: a cursor moved while it runs is somewhere else. */
    readonly index: number,
    to: Box,
    frames: Keyframe[],
    timing: KeyframeAnimationOptions,
  ) {
    this.bar = document.createElement("div");
    // It tints what is under it rather than covering it, so the rows sliding under it show through: on a light
    // ground the darker of the two is drawn, on a dark one the lighter. The rows' own highlight waits until it lands.
    this.bar.className =
      "glide pointer-events-none absolute top-0 left-0 z-2 bg-accent-soft shadow-[inset_3px_0_0_var(--accent)] mix-blend-darken dark:mix-blend-lighten";
    this.bar.setAttribute("aria-hidden", "true");
    Object.assign(this.bar.style, { width: `${to.w}px`, height: `${to.h}px` });
    strip.append(this.bar);
    strip.classList.add("gliding");
    this.run = this.bar.animate(frames, timing);
    const done = () => this.end();
    void this.run.finished.then(done, done);
  }

  /** Gives way: the rows draw the highlight again, where it is now. */
  stop(): void {
    this.run.cancel();
    this.end();
  }

  private end(): void {
    if (!this.bar.isConnected) return;
    this.bar.remove();
    this.strip.classList.remove("gliding");
  }
}
