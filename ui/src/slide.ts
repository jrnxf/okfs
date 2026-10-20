// Panes slide sideways into their new slots when the folder shown changes to one beside it: a step in, a step
// out, or a click a few columns along; and when a file takes the full width or gives it back. Nothing moves up or
// down, and nothing waits for the slide.

import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { type Before, type Edges, type Move, alongOf, beforeOf, moveOf } from "./moves";
import { keyHeld } from "./preview";
import { store } from "./store";

/** How long a slide takes. It is a step through folders, taken many times a day: short, so no step waits on it. */
export const SLIDE_MS = 150;
/** Fast out of the gate, settling into the slot: the panes move with the key, not after it. */
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
/** The parts of a pane that scroll: a copy of the pane is scrolled as far as the pane was. */
const SCROLLS = ".list, .col-rows, .pv-scroll";
/** What a copy of a preview leaves out: what would load again or play in it, and what is loaded out of sight. */
const LIVE = "iframe, video, audio, object, embed, .pv-ahead";

/** A pane as it was on screen before the move, with its box, and a still copy of it to slide out when it is gone. */
interface Was extends Before {
  box: DOMRect;
  copy: HTMLElement;
  scrolls: number[];
}

const still = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Each pane of the strip, by its key: the path of its folder, or of the file it shows. A pane that shows neither
 * has an empty one: it is never the same pane.
 */
function panesOf(strip: HTMLElement): HTMLElement[] {
  return [...strip.querySelectorAll<HTMLElement>("[data-pane]")].filter((pane) => pane.getClientRects().length > 0);
}

/** A pane's edges as they are drawn. */
function edgesOf(pane: HTMLElement): Edges {
  const { left, right } = pane.getBoundingClientRect();
  return { left, right };
}

/** A copy of a pane that can be shown while the pane itself has gone. Of a preview, what is `LIVE` is left out. */
function copyOf(pane: HTMLElement): HTMLElement {
  const copy = pane.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll(LIVE)) el.remove();
  for (const el of copy.querySelectorAll("[id]")) el.removeAttribute("id");
  copy.removeAttribute("data-pane");
  copy.removeAttribute("data-going");
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  copy.classList.add("ghost");
  return copy;
}

// A pane's box and opacity are read as they are drawn, so a slide still running is looked at where it has got to. A
// pane sliding out that the page keeps is looked at too: back in the slots, it goes on from where it had got to.
function look(strip: HTMLElement): Was[] {
  const going = [...strip.querySelectorAll<HTMLElement>("[data-going]")].filter((pane) => pane.getClientRects().length > 0);
  return [...panesOf(strip), ...going].map((pane) => {
    const box = pane.getBoundingClientRect();
    return {
      key: pane.dataset.pane ?? pane.dataset.going ?? "",
      rect: { left: box.left, right: box.right },
      box,
      opacity: Number(getComputedStyle(pane).opacity),
      copy: copyOf(pane),
      scrolls: [...pane.querySelectorAll(SCROLLS)].map((el) => el.scrollTop),
    };
  });
}

/** True when `path` is a folder directly inside `from`: a step in, which slides left even with no pane in common. */
const into = (from: string, path: string): boolean => {
  const rest = from ? (path.startsWith(`${from}/`) ? path.slice(from.length + 1) : "") : path;
  return rest !== "" && !rest.includes("/");
};

/** How far a slot is from the next, as the panes were: the main list's left edge to the first column's. */
function slot(was: Was[]): number | undefined {
  const [first, next] = was;
  return first && next ? next.rect.left - first.rect.left : first && first.rect.right - first.rect.left;
}

/** The frames of a move: a pane moved whole slides, one held at the right edge moves its left edge. */
function framesOf(move: Move): Keyframe[] {
  return move.edge
    ? [
        { marginLeft: `${move.from}px`, opacity: move.opacity },
        { marginLeft: "0px", opacity: 1 },
      ]
    : [
        { transform: `translateX(${move.from}px)`, opacity: move.opacity },
        { transform: "none", opacity: 1 },
      ];
}

/** The pane that showed `key`, when the page keeps it in for the slide once it has gone from the slots. See `Side`. */
const goneOf = (strip: HTMLElement, key: string): HTMLElement | null => strip.querySelector<HTMLElement>(`[data-going="${CSS.escape(key)}"]`);

/** A pane coming or going: a change the slide has to take in. A copy sliding out is not one. */
const isPane = (node: Node): boolean =>
  node instanceof HTMLElement && !node.classList.contains("ghost") && (node.matches("[data-pane]") || node.querySelector("[data-pane]") !== null);

/**
 * One slide of the panes of `strip`, from where they were, `was`, by `along`. A pane that comes or goes while it runs,
 * as a column whose answer comes a moment after the step, joins it where it has got to: every pane is where the
 * slide would have it had the pane been there from the start, so the panes move as one.
 */
class Slide {
  private readonly runs = new Map<HTMLElement, Animation>();
  private readonly out = new Map<Was, Animation>();
  private readonly watch: MutationObserver;
  private readonly start = performance.now();

  constructor(
    private readonly strip: HTMLElement,
    private readonly was: Was[],
    private readonly along: number,
  ) {
    this.place();
    this.watch = new MutationObserver((records) => {
      if (records.some((record) => record.type === "attributes" || [...record.addedNodes, ...record.removedNodes].some(isPane))) this.place();
    });
    this.watch.observe(strip, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-pane"] });
    setTimeout(() => this.watch.disconnect(), SLIDE_MS);
  }

  /** Each pane where the slide has got to, from where it would be with no slide on it, and a copy of each gone. */
  private place(): void {
    const at = performance.now() - this.start;
    if (at >= SLIDE_MS) return;
    for (const run of this.runs.values()) run.cancel();
    this.runs.clear();
    const box = this.strip.getBoundingClientRect();
    const now = panesOf(this.strip).map((pane) => ({ pane, key: pane.dataset.pane ?? "", rect: edgesOf(pane) }));
    const timing = { duration: SLIDE_MS, easing: EASE_OUT };
    for (const placed of now) {
      const run = placed.pane.animate(framesOf(moveOf(placed.rect, beforeOf(this.was, placed), this.along, box.right)), timing);
      run.currentTime = at;
      this.runs.set(placed.pane, run);
    }
    const kept = new Set(now.map((placed) => placed.key).filter(Boolean));
    for (const it of this.was) {
      const going = this.out.get(it);
      if (it.key && kept.has(it.key)) {
        going?.cancel();
        this.out.delete(it);
        continue;
      }
      if (going) continue;
      // The pane itself when the page keeps it for the slide, live: a copy leaves out what is live in it.
      const live = it.key ? goneOf(this.strip, it.key) : null;
      const copy = live ?? it.copy;
      const { box: was } = it;
      // It is drawn as a copy is: see `.ghost`.
      if (live) Object.assign(live.style, { display: "flex", position: "absolute", zIndex: "1", pointerEvents: "none" });
      Object.assign(copy.style, {
        top: `${was.top - box.top}px`,
        left: `${was.left - box.left}px`,
        width: `${was.width}px`,
        height: `${was.height}px`,
      });
      if (!live) this.strip.append(copy);
      copy.querySelectorAll(SCROLLS).forEach((scroller, index) => {
        scroller.scrollTop = it.scrolls[index] ?? 0;
      });
      const run = copy.animate(
        [
          { transform: "none", opacity: it.opacity },
          { transform: `translateX(${-this.along}px)`, opacity: 0 },
        ],
        timing,
      );
      run.currentTime = at;
      this.out.set(it, run);
      // The page takes away a pane it kept, once the slide is over: until then it is out of sight. One back in the
      // slots is left as it is.
      const done = () => {
        if (!live) copy.remove();
        else if (live.dataset.going !== undefined) live.style.display = "none";
      };
      void run.finished.then(done, done);
    }
  }

  /** Gives way to the next slide, which starts from where the panes have got to. Copies sliding out finish on their own. */
  stop(): void {
    this.watch.disconnect();
    for (const run of this.runs.values()) run.cancel();
  }
}

/**
 * Slides the panes of `strip` when `path`, the folder shown, changes, and when `open`, a file has the full width,
 * does. A pane showing the same folder or file before and after slides from where it is on screen to its new slot;
 * a pane that comes slides in with them, fading up; a pane that goes slides on out, fading away. A move during a
 * slide takes the panes on from where they are, so nothing jumps. A step into a folder that was not shown slides
 * by a slot; any other move with no pane in common, a file given the full width in another folder, a phone's
 * single pane, a reader who asked for less motion, and a held key do not slide: under a held key the panes are
 * where the key has taken them at once.
 */
export function useSlide(strip: RefObject<HTMLElement | null>, path: string, open: boolean): void {
  const shown = useRef({ path, open });
  const before = useRef<Was[] | null>(null);
  const running = useRef<Slide | null>(null);

  // The store tells of the change before the page draws it: the panes are looked at while they are the old ones.
  useEffect(
    () =>
      store.subscribe(() => {
        const el = strip.current;
        const { s } = store;
        if (!el || before.current || (s.path === shown.current.path && (s.open !== null) === shown.current.open)) return;
        if (still() || keyHeld()) return;
        before.current = look(el);
      }),
    [strip],
  );

  useLayoutEffect(() => {
    const from = shown.current;
    if (path === from.path && open === from.open) return;
    shown.current = { path, open };
    const was = before.current;
    before.current = null;
    // The panes' slide still running gives way: the new one starts from where they were looked at, or, with
    // nothing looked at, the panes are in their new slots at once.
    running.current?.stop();
    running.current = null;
    const el = strip.current;
    if (!el || !was || (open && path !== from.path)) return;

    const now = panesOf(el).map((pane) => ({ key: pane.dataset.pane ?? "", rect: edgesOf(pane) }));
    // A click in the first pane on a folder that was not shown keeps none: the step in slides by a slot, as one
    // from a column does.
    const along = alongOf(was, now) ?? (into(from.path, path) ? slot(was) : undefined);
    if (!along) return;
    running.current = new Slide(el, was, along);
  }, [path, open, strip]);
}
