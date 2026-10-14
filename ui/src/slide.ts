// Panes slide sideways into their new slots when the folder shown changes to one beside it: a step in, a step
// out, or a click a few columns along. Nothing moves up or down, and nothing waits for the slide.

import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { keyHeld } from "./preview";
import { store } from "./store";

/** How long a slide takes. It is a step through folders, taken many times a day: short, so no step waits on it. */
export const SLIDE_MS = 150;
/** Fast out of the gate, settling into the slot: the panes move with the key, not after it. */
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
/** The parts of a pane that scroll: a copy of the pane is scrolled as far as the pane was. */
const SCROLLS = ".list, .col-rows";

/**
 * A pane as it was on screen before the move: where it was and how far it had faded in, part way through a slide
 * that is still running, and a still copy of it to slide out when it is gone.
 */
interface Was {
  key: string;
  rect: DOMRect;
  opacity: number;
  copy: HTMLElement;
  scrolls: number[];
}

const still = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Each pane of the strip by its folder's path. The preview pane has an empty one: it is never the same pane. */
function panesOf(strip: HTMLElement): HTMLElement[] {
  return [...strip.querySelectorAll<HTMLElement>("[data-pane]")].filter((pane) => pane.getClientRects().length > 0);
}

/** A copy of a pane that can be shown while the pane itself has gone. A preview's frames are left out. */
function copyOf(pane: HTMLElement): HTMLElement {
  const copy = pane.classList.contains("pane") ? (pane.cloneNode(false) as HTMLElement) : (pane.cloneNode(true) as HTMLElement);
  const bar = pane.classList.contains("pane") ? pane.querySelector(".ph") : null;
  if (bar) copy.append(bar.cloneNode(true));
  for (const el of copy.querySelectorAll("[id]")) el.removeAttribute("id");
  copy.removeAttribute("data-pane");
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  copy.classList.add("ghost");
  return copy;
}

// A pane's box and opacity are read as they are drawn, so a slide still running is looked at where it has got to.
function look(strip: HTMLElement): Was[] {
  return panesOf(strip).map((pane) => ({
    key: pane.dataset.pane ?? "",
    rect: pane.getBoundingClientRect(),
    opacity: Number(getComputedStyle(pane).opacity),
    copy: copyOf(pane),
    scrolls: [...pane.querySelectorAll(SCROLLS)].map((el) => el.scrollTop),
  }));
}

/**
 * Slides the panes of `strip` when `path`, the folder shown, changes. A pane showing the same folder before and
 * after slides from where it is on screen to its new slot; a pane that comes slides in with them, fading up; a
 * pane that goes slides on out, fading away. A move during a slide takes the panes on from where they are, so
 * nothing jumps. A move with no pane in common, a phone's single pane, a reader who asked for less motion, and a
 * held key do not slide: under a held key the panes are where the key has taken them at once.
 */
export function useSlide(strip: RefObject<HTMLElement | null>, path: string): void {
  const shown = useRef(path);
  const before = useRef<Was[] | null>(null);
  const stop = useRef<(() => void) | null>(null);

  // The store tells of the new folder before the page draws it: the panes are looked at while they are the old ones.
  useEffect(
    () =>
      store.subscribe(() => {
        const el = strip.current;
        if (!el || before.current || store.s.path === shown.current) return;
        if (still() || keyHeld()) return;
        before.current = look(el);
      }),
    [strip],
  );

  useLayoutEffect(() => {
    if (path === shown.current) return;
    shown.current = path;
    const was = before.current;
    before.current = null;
    // The panes' slide still running gives way: the new one starts from where they were looked at, or, with
    // nothing looked at, the panes are in their new slots at once. Copies sliding out finish on their own.
    stop.current?.();
    stop.current = null;
    const el = strip.current;
    if (!el || !was || store.s.open) return;

    const box = el.getBoundingClientRect();
    const now = panesOf(el);
    const old = new Map(was.map((it) => [it.key, it]));
    const shift = new Map<HTMLElement, number>();
    for (const pane of now) {
      const it = pane.dataset.pane ? old.get(pane.dataset.pane) : undefined;
      if (it) shift.set(pane, it.rect.left - pane.getBoundingClientRect().left);
    }
    // The way the strip moves, from the panes it kept. A pane that comes or goes moves the same way.
    const along = [...shift.values()][0];
    if (along === undefined || along === 0) return;

    const timing = { duration: SLIDE_MS, easing: EASE_OUT };
    const runs: Animation[] = [];
    for (const pane of now) {
      const dx = shift.get(pane);
      const from = dx === undefined ? 0 : (old.get(pane.dataset.pane ?? "")?.opacity ?? 1);
      runs.push(pane.animate([{ transform: `translateX(${dx ?? along}px)`, opacity: from }, { transform: "none", opacity: 1 }], timing));
    }
    const kept = new Set(now.map((pane) => pane.dataset.pane).filter(Boolean));
    for (const it of was) {
      if (it.key && kept.has(it.key)) continue;
      const { copy, rect } = it;
      Object.assign(copy.style, {
        top: `${rect.top - box.top}px`,
        left: `${rect.left - box.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      el.append(copy);
      copy.querySelectorAll(SCROLLS).forEach((scroller, at) => {
        scroller.scrollTop = it.scrolls[at] ?? 0;
      });
      const out = copy.animate([{ transform: "none", opacity: it.opacity }, { transform: `translateX(${-along}px)`, opacity: 0 }], timing);
      void out.finished.then(
        () => copy.remove(),
        () => copy.remove(),
      );
    }
    const end = () => {
      for (const run of runs) run.cancel();
    };
    stop.current = end;
    void Promise.all(runs.map((run) => run.finished)).then(
      () => {
        if (stop.current === end) stop.current = null;
      },
      () => undefined,
    );
  }, [path, strip]);
}
