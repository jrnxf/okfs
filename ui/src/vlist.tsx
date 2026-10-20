// One virtual list: a single column of rows.
// Only the rows on screen are in the page, so a folder of 50,000 scrolls like one of 50.

import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

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
  /** Shown over the list when there is nothing in it. */
  empty: ComponentChildren;
  /** Shown under the rows, in the same scroll. */
  children?: ComponentChildren;
  /** Told the last row on screen as it changes, for a list that loads more as it is scrolled. */
  onShown?: (last: number) => void;
}

export function VList({ scroller, count, cursor, caught, listKey, render, empty, children, onShown }: Props) {
  const inner = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
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
  const cells: ComponentChildren[] = [];
  for (let index = first; index < last; index++) {
    cells.push(render(index, { top: index * step, left: 0, width: box.width, height: step }));
  }

  return (
    <div class="list" ref={scroller} tabIndex={-1} role="listbox" aria-label="Files">
      <div class="probe" ref={probe} />
      {empty}
      <div class="rows" ref={inner} style={{ height: `${height}px` }}>
        {cells}
      </div>
      {children}
    </div>
  );
}
