// Which rows of a list are selected, and how a click or a key changes that: the anchor model Finder, Windows
// Explorer, the macOS and GTK tables and Gmail's checkboxes share.
//
// A click, or a Ctrl or ⌘ click, sets the anchor. Shift selects from the anchor to the row and replaces the last
// such range instead of adding to it, so going back toward the anchor shrinks it. What stays selected under a range
// is the `base`: nothing after a plain click, so Shift selects exactly the range as Explorer does, and the rows picked
// with Ctrl or ⌘ before, so they survive as they do in Finder. Ctrl or ⌘ with Shift adds the range to what is
// selected. In select mode, where each row has a box to tick, Shift gives every row of the range the state the
// clicked one takes, as Gmail does, so a range can be unselected as easily as selected.
//
// Rows are named by their paths, so a selection holds while the list is sorted, filtered or read again.

export interface Picked {
  /** The paths of the selected rows. */
  sel: ReadonlySet<string>;
  /** Where a range starts: a path of the list. */
  anchor: string | null;
  /** What stays selected under the next range from the anchor. */
  base: ReadonlySet<string>;
}

export const NONE: Picked = { sel: new Set(), anchor: null, base: new Set() };

/** The rows from `a` to `b` of `rows`, both included, in either order. Empty when either is not in it. */
function span(rows: readonly string[], a: string, b: string): string[] {
  const from = rows.indexOf(a);
  const to = rows.indexOf(b);
  if (from < 0 || to < 0) return [];
  return rows.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** A plain click: the row alone is selected, and is the anchor. */
export function only(path: string): Picked {
  return { sel: new Set([path]), anchor: path, base: new Set() };
}

/**
 * A Ctrl or ⌘ click, and Space: the row is selected or unselected and the rest stay. The row is the anchor. `cursor` is
 * the row the cursor is on: the first such click keeps it, as Finder does, so two rows end up selected.
 */
export function toggle(now: Picked, path: string, cursor?: string | null): Picked {
  const sel = new Set(now.sel);
  if (sel.size === 0 && cursor && cursor !== path) sel.add(cursor);
  if (sel.has(path)) sel.delete(path);
  else sel.add(path);
  return { sel, anchor: path, base: new Set(sel) };
}

/**
 * A Shift click, Shift and an arrow, and Shift and Space: the rows from the anchor to `path`, on top of the base. With
 * `add`, Ctrl or ⌘ held too: the range is added to what is selected. With no anchor, the range starts at `from`, the
 * cursor.
 */
export function extend(now: Picked, rows: readonly string[], path: string, from: string | null, add = false): Picked {
  const anchor = now.anchor !== null && rows.includes(now.anchor) ? now.anchor : (from ?? path);
  const base = now.anchor === anchor ? now.base : now.sel;
  const range = span(rows, anchor, path);
  if (add) {
    const sel = new Set([...now.sel, ...range]);
    return { sel, anchor, base: new Set(sel) };
  }
  return { sel: new Set([...base, ...range]), anchor, base };
}

/** A tick of a row's box in select mode: Shift gives the whole range from the anchor the state the row takes. */
export function check(now: Picked, rows: readonly string[], path: string, shift: boolean): Picked {
  const on = !now.sel.has(path);
  const range = shift && now.anchor !== null ? span(rows, now.anchor, path) : [];
  const sel = new Set(now.sel);
  for (const row of range.length ? range : [path]) {
    if (on) sel.add(row);
    else sel.delete(row);
  }
  return { sel, anchor: path, base: new Set(sel) };
}

/** Every row of the list. */
export function everything(rows: readonly string[]): Picked {
  const sel = new Set(rows);
  return { sel, anchor: rows[0] ?? null, base: new Set(sel) };
}

/** Keeps only the rows still in the list, as after it is read again. */
export function within(now: Picked, rows: readonly string[]): Picked {
  const there = new Set(rows);
  const keep = (set: ReadonlySet<string>) => new Set([...set].filter((path) => there.has(path)));
  const sel = keep(now.sel);
  if (sel.size === now.sel.size && (now.anchor === null || there.has(now.anchor))) return now;
  return { sel, anchor: now.anchor !== null && there.has(now.anchor) ? now.anchor : null, base: keep(now.base) };
}
