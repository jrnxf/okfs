// One virtual list: a single column of rows.
// Only the rows on screen are in the page, so a folder of 50,000 scrolls like one of 50.

import { Fragment, type ComponentChildren, type RefObject } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

/** Rows kept above and below what is visible, so a fast scroll does not show a gap. */
const OVERSCAN = 6;

export interface Cell {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Props {
  scroller: RefObject<HTMLDivElement | null>;
  count: number;
  cursor: number;
  /** Changes when the list caught up with the disk by itself: the scroll position is then left alone. */
  caught: number;
  /** Changes when the list is a different list: the scroll position starts over. */
  listKey: string;
  render: (index: number, cell: Cell) => ComponentChildren;
  /** A row drawn beside the listbox, in the same place, for the time it holds a control: an option may hold none. */
  apart?: number;
  /** Shown over the list when there is nothing in it. */
  empty: ComponentChildren;
  /** Shown under the rows, in the same scroll. */
  children?: ComponentChildren;
  /** Told the last row on screen as it changes, for a list that loads more as it is scrolled. */
  onShown?: (last: number) => void;
}

export function VList({ scroller, count, cursor, caught, listKey, render, apart = -1, empty, children, onShown }: Props) {
  const inner = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const live = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0, rowH: 34 });
  const [scrollTop, setScrollTop] = useState(0);

  // The row height comes from tokens, so it is measured, and measured again when a theme changes it.
  useLayoutEffect(() => {
    const [outer, content, sample] = [scroller.current, inner.current, probe.current];
    if (!outer || !content || !sample) return;
    const measure = () => {
      const next = { width: content.clientWidth, height: outer.clientHeight, rowH: sample.getBoundingClientRect().height };
      setBox((old) => (old.width === next.width && old.height === next.height && old.rowH === next.rowH ? old : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    // The rows can be narrower than the scroller, and change width while it does not.
    observer.observe(content);
    observer.observe(sample);
    const onScroll = () => setScrollTop(outer.scrollTop);
    outer.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      outer.removeEventListener("scroll", onScroll);
    };
  }, [scroller]);

  const step = box.rowH;
  const height = count * step;

  // A new list starts at the top; after that the cursor is kept in view.
  const shownKey = useRef(listKey);
  const shownCaught = useRef(caught);
  useLayoutEffect(() => {
    const outer = scroller.current;
    if (!outer || !box.height) return;
    // Entries that came or went on disk may have moved the cursor's row: the reader did not ask to go there.
    if (shownCaught.current !== caught && shownKey.current === listKey) {
      shownCaught.current = caught;
      setScrollTop(outer.scrollTop);
      return;
    }
    shownCaught.current = caught;
    if (shownKey.current !== listKey) {
      shownKey.current = listKey;
      outer.scrollTop = 0;
    }
    const y = cursor * step;
    if (cursor === 0) outer.scrollTop = 0;
    else if (y < outer.scrollTop) outer.scrollTop = y;
    else if (y + step > outer.scrollTop + outer.clientHeight) outer.scrollTop = y + step - outer.clientHeight;
    setScrollTop(outer.scrollTop);
  }, [cursor, caught, listKey, step, box.height, scroller]);

  const first = Math.max(0, Math.floor(scrollTop / step) - OVERSCAN);
  const last = Math.min(count, Math.ceil((scrollTop + box.height) / step) + OVERSCAN);
  useEffect(() => onShown?.(last), [last, count, onShown]);
  // The keys are read by the page, so the list often does not have focus, and a screen reader is told where the cursor is:
  // by the listbox's active row for a reader that does have focus on it, and by a live region for the rest.
  // Only an attribute and a line of text change; nothing renders again.
  const tell = useCallback(() => {
    const [box, status] = [inner.current, live.current];
    if (!box || !status) return;
    const row = count > 0 ? box.querySelector(`[data-i="${cursor}"]`) : null;
    if (row?.id) box.setAttribute("aria-activedescendant", row.id);
    else box.removeAttribute("aria-activedescendant");
    // With focus on the listbox the reader follows the active row itself: saying it here too would be heard twice.
    status.textContent = row && document.activeElement !== box ? (row.getAttribute("aria-label") ?? "") : "";
  }, [cursor, count, apart]);
  useLayoutEffect(tell, [tell, listKey, caught]);
  // A click moves the cursor first and focus after: the line said for the first is taken back, and given again when focus leaves.
  // The listeners are put on once and call the latest `tell`: a focus that lands between a render and the effect that
  // would swap the listeners must not tell an old cursor.
  const latest = useRef(tell);
  latest.current = tell;
  useEffect(() => {
    const box = inner.current;
    const told = () => latest.current();
    box?.addEventListener("focus", told);
    box?.addEventListener("blur", told);
    return () => {
      box?.removeEventListener("focus", told);
      box?.removeEventListener("blur", told);
    };
  }, []);
  const cells: ComponentChildren[] = [];
  const draw = (index: number) => {
    if (index !== apart) cells.push(render(index, { top: index * step, left: 0, width: box.width, height: step }));
  };
  for (let index = first; index < last; index++) draw(index);
  // The cursor's row stays in the page when a wheel or a touch scrolls it away, so the active row always exists.
  if (cursor < count && (cursor < first || cursor >= last)) draw(cursor);
  const held = apart >= 0 && apart < count;
  const listed = count - (held ? 1 : 0);

  return (
    <Fragment>
      <div class="list relative min-h-0 flex-1 overflow-auto overscroll-contain" ref={scroller}>
        {/* A row's height, as the page draws it: see `pageOf` in app.tsx. */}
        <div class="probe pointer-events-none invisible absolute h-(--row-h) w-0" ref={probe} aria-hidden="true" />
        {empty}
        {held && <div class="absolute inset-x-0 top-0">{render(apart, { top: apart * step, left: 0, width: box.width, height: step })}</div>}
        {/* The listbox holds the rows and nothing else: the text of an empty list and the README are beside it, in the same scroll.
            With no row there is no listbox, as in the palette: a list with no option tells a screen reader nothing.
            Tab stops on it, so a keyboard comes to the rows in the order of the page. Its ring is drawn on the scroll round it: see app.css. */}
        <div class="rows relative" ref={inner} tabIndex={listed ? 0 : -1} role={listed ? "listbox" : undefined} aria-label={listed ? "Files" : undefined} style={{ height: `${height}px` }}>
          {cells}
        </div>
        {children}
      </div>
      <div class="sr-only" ref={live} role="status" aria-live="polite" aria-atomic="true" />
    </Fragment>
  );
}
