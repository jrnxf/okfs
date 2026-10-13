// One virtual list for both views: a single column of rows, or several columns of tiles.
// Only the rows on screen are in the page, so a folder of 50,000 scrolls like one of 50.

import type { ComponentChildren, RefObject } from "preact";
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";

/** Rows kept above and below what is visible, so a fast scroll does not show a gap. */
const OVERSCAN = 6;

interface Layout {
  cols: number;
  colW: number;
  rowH: number;
  gap: number;
  pad: number;
  padX: number;
}

export interface Cell {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Props {
  scroller: RefObject<HTMLDivElement | null>;
  count: number;
  grid: boolean;
  cursor: number;
  /** Changes when the list caught up with the disk by itself: the scroll position is then left alone. */
  caught: number;
  /** Changes when the list is a different list: the scroll position starts over. */
  listKey: string;
  render: (index: number, cell: Cell) => ComponentChildren;
  /** Reports how many columns there are, for moving the cursor by a row. */
  onCols: (cols: number) => void;
  /** Shown over the list when there is nothing in it. */
  empty: ComponentChildren;
  /** Shown under the rows, in the same scroll. */
  children?: ComponentChildren;
}

function layoutFor(width: number, grid: boolean, rowH: number): Layout {
  if (!grid) return { cols: 1, colW: width, rowH, gap: 0, pad: 0, padX: 0 };
  const [gap, pad, padX] = [4, 8, 8];
  const cols = Math.max(2, Math.floor((width - 16) / 118));
  const colW = (width - padX * 2 - gap * (cols - 1)) / cols;
  return { cols, colW, rowH: Math.round(colW * 0.82 + 30), gap, pad, padX };
}

export function VGrid({ scroller, count, grid, cursor, caught, listKey, render, onCols, empty, children }: Props) {
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

  const L = useMemo(() => layoutFor(box.width, grid, box.rowH), [box.width, box.rowH, grid]);
  const step = L.rowH + L.gap;
  const rows = Math.ceil(count / L.cols);
  const height = count ? L.pad * 2 + rows * step - L.gap : 0;

  useLayoutEffect(() => onCols(L.cols), [L.cols, onCols]);

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
    const row = Math.floor(cursor / L.cols);
    const y = L.pad + row * step;
    if (row === 0) outer.scrollTop = 0;
    else if (y < outer.scrollTop) outer.scrollTop = y - L.gap;
    else if (y + L.rowH > outer.scrollTop + outer.clientHeight) outer.scrollTop = y + L.rowH - outer.clientHeight + L.gap;
    setScrollTop(outer.scrollTop);
  }, [cursor, caught, listKey, L, step, box.height, scroller]);

  const first = Math.max(0, Math.floor((scrollTop - L.pad) / step) - OVERSCAN);
  const last = Math.min(rows, Math.ceil((scrollTop - L.pad + box.height) / step) + OVERSCAN);
  const cells: ComponentChildren[] = [];
  for (let row = first; row < last; row++) {
    for (let col = 0; col < L.cols; col++) {
      const index = row * L.cols + col;
      if (index >= count) break;
      cells.push(
        render(index, {
          top: L.pad + row * step,
          left: L.padX + col * (L.colW + L.gap),
          width: L.colW,
          height: L.rowH,
        }),
      );
    }
  }

  return (
    <div class="list" ref={scroller} tabIndex={-1} role="listbox" aria-label="Files">
      <div class="probe" ref={probe} />
      {empty}
      <div class={grid ? "rows tiles" : "rows"} ref={inner} style={{ height: `${height}px` }}>
        {cells}
      </div>
      {children}
    </div>
  );
}
