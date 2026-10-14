// Panes slide sideways into their new slots when the folder shown changes to one beside it: a step in, a step
// out, or a click a few columns along. Nothing moves up or down, and nothing waits for the slide.

import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { store } from "./store";

/** How long a slide takes. A move that comes sooner than this after the last one is not slid at all. */
export const SLIDE_MS = 180;
/** Fast out of the gate, settling into the slot. */
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
/** The parts of a pane that scroll: a copy of the pane is scrolled as far as the pane was. */
const SCROLLS = ".list, .col-rows";

/** A pane as it was before the move: where it was, and a still copy of it to slide out when it is gone. */
interface Was {
  key: string;
  rect: DOMRect;
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

function look(strip: HTMLElement): Was[] {
  return panesOf(strip).map((pane) => ({
    key: pane.dataset.pane ?? "",
    rect: pane.getBoundingClientRect(),
    copy: copyOf(pane),
    scrolls: [...pane.querySelectorAll(SCROLLS)].map((el) => el.scrollTop),
  }));
}

/**
 * Slides the panes of `strip` when `path`, the folder shown, changes. A pane showing the same folder before and
 * after slides from its old slot to its new one; a pane that comes slides in with them, fading up; a pane that
 * goes slides on out, fading away. A move with no pane in common, a phone's single pane, a reader who asked for
 * less motion, and a held key do not slide.
 */
export function useSlide(strip: RefObject<HTMLElement | null>, path: string): void {
  const shown = useRef(path);
  const before = useRef<Was[] | null>(null);
  const last = useRef(0);
  const stop = useRef<(() => void) | null>(null);

  // The store tells of the new folder before the page draws it: the panes are looked at while they are the old ones.
  useEffect(
    () =>
      store.subscribe(() => {
        const el = strip.current;
        if (!el || before.current || store.s.path === shown.current) return;
        if (still() || performance.now() - last.current < SLIDE_MS) return;
        before.current = look(el);
      }),
    [strip],
  );

  useLayoutEffect(() => {
    if (path === shown.current) return;
    shown.current = path;
    const was = before.current;
    before.current = null;
    last.current = performance.now();
    // A slide still running is ended where it was going: the new move shows at once.
    stop.current?.();
    stop.current = null;
    const el = strip.current;
    if (!el || !was || store.s.open) return;

    const box = el.getBoundingClientRect();
    const now = panesOf(el);
    const shift = new Map<HTMLElement, number>();
    for (const pane of now) {
      const old = pane.dataset.pane ? was.find((it) => it.key === pane.dataset.pane) : undefined;
      if (old) shift.set(pane, old.rect.left - pane.getBoundingClientRect().left);
    }
    // The way the strip moves, from the panes it kept. A pane that comes or goes moves the same way.
    const along = [...shift.values()][0];
    if (along === undefined || along === 0) return;

    const timing = { duration: SLIDE_MS, easing: EASE_OUT };
    const runs: Animation[] = [];
    for (const pane of now) {
      const dx = shift.get(pane);
      runs.push(
        dx === undefined
          ? pane.animate([{ transform: `translateX(${along}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], timing)
          : pane.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], timing),
      );
    }
    const kept = new Set(now.map((pane) => pane.dataset.pane).filter(Boolean));
    const copies: HTMLElement[] = [];
    for (const old of was) {
      if (old.key && kept.has(old.key)) continue;
      const { copy, rect } = old;
      Object.assign(copy.style, {
        top: `${rect.top - box.top}px`,
        left: `${rect.left - box.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      el.append(copy);
      copy.querySelectorAll(SCROLLS).forEach((scroller, at) => {
        scroller.scrollTop = old.scrolls[at] ?? 0;
      });
      copies.push(copy);
      runs.push(copy.animate([{ transform: "none", opacity: 1 }, { transform: `translateX(${-along}px)`, opacity: 0 }], timing));
    }
    const end = () => {
      for (const run of runs) run.cancel();
      for (const copy of copies) copy.remove();
    };
    stop.current = end;
    void Promise.all(runs.map((run) => run.finished)).then(
      () => {
        if (stop.current === end) {
          stop.current = null;
          end();
        }
      },
      () => undefined,
    );
  }, [path, strip]);
}
