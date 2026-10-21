// What is beside the main list. The file under the cursor as it is shown. For a folder under it, a column for it
// and for each folder its focused entry leads to, and the file that leads to after the last column. A column's
// focused entry is the one the pointer was last on, or else the one the cursor was on when the folder was left,
// or else its first: going into the folder lands on it.

import type { ComponentChildren, RefObject } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type Item, type Listing, urls } from "./api";
import { Aim, AIM_RECHECK } from "./aim";
import { config } from "./config";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { hasSource } from "./kinds";
import { goingOf } from "./moves";
import { DELETE_KEY } from "./palette";
import { Preview, columnsUrl, useLoaded } from "./preview";
import { SLIDE_MS } from "./slide";
import { type Chain, type Left, columnsOf, focusOf, standIn } from "./slots";
import { type Doomed, type Entry, store, toEntry } from "./store";

/** A click on a row of a column goes where a click in the main list would: into a folder, onto a file. */
function visit(listing: Listing, item: Item, open: boolean): void {
  const path = listing.path ? `${listing.path}/${item.n}` : item.n;
  // The pointer is on the row: its folder's column, the next one, leads on to no pick of its own.
  if (item.d) void store.showDir(path, { enter: [] });
  else if (open) void store.go(path, false);
  else void store.showDir(listing.path, { select: item.n });
}

/** What an empty folder says, in the main list and in a column. */
export const EMPTY_FOLDER = "This folder is empty";

/** A click on a button of a header leaves the focus where it was, so the keys go on working on the list. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * A folder's bar: its name, how much it holds, when it changed, and what can be done with it. The main list has
 * one as every column does, so a folder's rows sit at the same height in every slot, and on one grid with the
 * rows beside them.
 */
export function FolderBar({
  name,
  path,
  count,
  mtime,
  doomed,
  missing = false,
}: {
  name: string;
  path: string;
  count: number | undefined;
  mtime: number | undefined;
  doomed: Doomed | null;
  /** Nothing is at the path: the bar names it and says nothing more, and offers nothing to do with it. */
  missing?: boolean;
}) {
  const facts = [...(count === undefined ? [] : [fmt.items(count)]), ...(mtime === undefined ? [] : [fmt.rel(mtime)])];
  return (
    <div class="ph" onMouseDown={keepFocus}>
      {!missing && <KindIcon kind="folder" />}
      <span class="nm trunc">{name}</span>
      <span class="facts trunc num" title={mtime === undefined ? undefined : fmt.abs(mtime)}>{facts.join(" · ")}</span>
      {!missing && (
        <a class="btn" href={urls.zip(path)} download aria-label="Download as a zip" title="Download as a zip">
          <Icon name="download" />
        </a>
      )}
      {doomed && (
        <button class="btn" aria-label="Delete" title="Delete" onClick={() => store.askDelete(doomed)}>
          <Icon name="trash" />
        </button>
      )}
    </div>
  );
}

/**
 * One folder as a column: its own bar, then its first entries as the main list draws them, in name order.
 * `led` names the entry the next column, or the file after the last, is the inside of.
 */
function Column({ folder, listing, led, edge, level }: { folder: Entry; listing: Listing | undefined; led: string | undefined; edge: boolean; level: number }) {
  // The listing on screen is the last one's until this folder's has come.
  const own = listing?.path === folder.path ? listing : undefined;
  const more = listing ? listing.total - listing.entries.length : 0;
  const go = (open: boolean) => (event: MouseEvent) => {
    const row = (event.target as Element).closest<HTMLElement>("[data-i]");
    const item = row ? listing?.entries[Number(row.dataset.i)] : undefined;
    if (listing && item) visit(listing, item, open);
  };
  return (
    <section class={edge ? "col edge" : "col"} aria-label={folder.name} data-pane={folder.path} data-level={level}>
      <FolderBar name={folder.name} path={folder.path} count={own?.total ?? folder.count} mtime={folder.mtime} doomed={config.delete ? folder : null} />
      <div class="cols label">
        <span />
        <span class="hd">
          Name
          <Icon name="up" />
        </span>
        <span class="hd r">Size</span>
        <span class="hd r">Mod.</span>
      </div>
      <div class="col-rows" onClick={go(false)} onDblClick={go(true)}>
        {listing?.entries.map((item, at) => {
          const entry = toEntry(item, listing.path, at);
          return (
            <div class={item.n === led ? "row at" : "row"} data-i={at} data-dir={entry.dir ? "" : undefined} key={at}>
              <KindIcon kind={entry.kind} />
              <span class="nm trunc">
                <b>{entry.name}</b>
              </span>
              <span class="sz num">{entry.dir ? (entry.count === undefined ? "" : fmt.count(entry.count)) : fmt.size(entry.size)}</span>
              <span class="tm num" title={fmt.abs(entry.mtime)}>
                {fmt.rel(entry.mtime)}
              </span>
            </div>
          );
        })}
        {more > 0 && <div class="col-note label">and {fmt.count(more)} more</div>}
        {listing?.total === 0 && <div class="col-note label">{EMPTY_FOLDER}</div>}
      </div>
    </section>
  );
}

/** What a phone keeps behind one button, as its file bar has no room for it: the wrap, the download and the delete. */
function More({ file, wrappable }: { file: Entry; wrappable: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [file.path]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target as Element).closest?.(".more")) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  return (
    <span class="more">
      <button class="btn" aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="more" />
      </button>
      {open && (
        <div class="more-menu pop" role="menu" onClick={() => setOpen(false)}>
          {wrappable && (
            <button class="tm-row" role="menuitem" onClick={() => store.flipWrap()}>
              <Icon name="wrap" />
              <span class="nm">{store.wraps(file) ? "Stop wrapping lines" : "Wrap long lines"}</span>
            </button>
          )}
          <a class="tm-row" role="menuitem" href={urls.raw(file.path)} download>
            <Icon name="download" />
            <span class="nm">Download</span>
          </a>
          {config.delete && (
            <button class="tm-row" role="menuitem" onClick={() => store.askDelete(file)}>
              <Icon name="trash" />
              <span class="nm">Delete</span>
            </button>
          )}
        </div>
      )}
    </span>
  );
}

/** On a phone, the bar at the foot of an open file: previous and next in reach of a thumb, with the place in the folder. */
function StepBar({ file }: { file: Entry }) {
  const files = store.files();
  return (
    <nav class="stepbar" aria-label="Files in this folder">
      <button class="btn" aria-label="Previous file" onClick={() => store.step(-1)}>
        <Icon name="left" />
        Previous
      </button>
      <span class="num">
        {files.indexOf(file) + 1} / {files.length}
      </span>
      <button class="btn" aria-label="Next file" onClick={() => store.step(1)}>
        Next
        <Icon name="right" />
      </button>
    </nav>
  );
}

/** Where the cursor was in each folder it left, as the columns lead on to it. */
const left: Left = (path) => store.leftIn(path);

/**
 * The columns follow the pointer: the entry it is on leads on to the next column, or to its file after the last,
 * at once. A pointer on its way to the next column is let past the rows between, as it is in the main list: see
 * `aim.ts`. A key that moves the cursor takes over, and the pointer has it back once it moves. The picks are the
 * store's, as going into the folder lands where they lead: see `Store.pick`.
 */
function usePicks(root: string | null, drawn: RefObject<Chain>) {
  const here = useRef(root);
  here.current = root;
  const pointer = useRef({ aim: new Aim(), at: { x: -1, y: -1 }, held: "", timer: 0 });
  useEffect(() => () => clearTimeout(pointer.current.timer), []);

  const pick = useCallback((level: number, name: string) => {
    const root = here.current;
    const chain = drawn.current;
    if (root === null || !chain) return;
    // Each column before this one leads on to the next: the pick keeps those and follows this one.
    const names = [...chain.led.slice(0, level), name];
    // A level that goes where it would with no pick needs no name: the columns are the ones asked for ahead of the cursor.
    const unpicked = (level: number): string | undefined => {
      const listing = chain.levels[level];
      return listing && focusOf(listing, undefined, left)?.n;
    };
    while (names.length && names[names.length - 1] === unpicked(names.length - 1)) names.pop();
    store.pick(root, names);
  }, []);

  const onMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const p = pointer.current;
    // A row that slid under a still pointer, as the keys move the cursor, is not the pointer moving.
    if (event.clientX === p.at.x && event.clientY === p.at.y) return;
    p.at = { x: event.clientX, y: event.clientY };
    p.aim.track(p.at);
    const target = event.target as Element;
    const column = target.closest<HTMLElement>(".col[data-level]");
    const row = target.closest<HTMLElement>(".col-rows [data-i]");
    const level = Number(column?.dataset.level);
    const item: Item | undefined = row ? drawn.current?.levels[level]?.entries[Number(row.dataset.i)] : undefined;
    if (!column || !item) return;
    const key = `${level}/${item.n}`;
    if (p.held === key) return;
    clearTimeout(p.timer);
    p.held = "";
    const aimed = (): boolean => {
      const strip = column.parentElement?.getBoundingClientRect();
      const box = column.getBoundingClientRect();
      if (!strip) return false;
      return p.aim.aiming(box, { left: box.right, top: strip.top, right: strip.right, bottom: strip.bottom });
    };
    if (!aimed()) return pick(level, item.n);
    // On its way to the next column: the row under the pointer waits, and is taken if the pointer stops.
    p.held = key;
    const look = () => {
      if (p.held !== key) return;
      if (aimed()) p.timer = window.setTimeout(look, AIM_RECHECK);
      else {
        p.held = "";
        pick(level, item.n);
      }
    };
    p.timer = window.setTimeout(look, AIM_RECHECK);
  };
  const onLeave = () => {
    clearTimeout(pointer.current.timer);
    pointer.current.held = "";
  };
  return { names: store.picked(root), onMove, onLeave };
}

/**
 * The file the pane showed a moment ago, while the panes slide, when the pane has just gone from the slots: on a step
 * out that takes the file past the window's right edge. The pane stays in the page for the slide, out of the slots,
 * and slides out whole: a copy of it would leave out what is live in it, a page's or a PDF's frame, and go blank.
 * See `useSlide`.
 */
function useGoing(here: boolean, shown: Entry | null): Entry | null {
  const was = useRef<Entry | null>(null);
  const going = useRef<Entry | null>(null);
  const [, gone] = useState(0);
  going.current = goingOf(here, was.current, going.current);
  was.current = here ? shown : null;
  const entry = going.current;
  useEffect(() => {
    if (!entry) return;
    const timer = setTimeout(() => {
      going.current = null;
      gone((count) => count + 1);
    }, SLIDE_MS);
    return () => clearTimeout(timer);
  }, [entry]);
  return entry;
}

export function Side({ slots }: { slots: number }) {
  const { s } = store;
  const cur = store.cur();
  const file = s.open ?? (cur && !cur.dir ? cur : null);
  const columns = !s.open && cur?.dir ? cur : null;

  const [facts, setFacts] = useState<{ path: string; list: string[] }>({ path: "", list: [] });
  const report = useCallback((path: string, list: string[]) => {
    setFacts((old) => (old.path === path && old.list.join() === list.join() ? old : { path, list }));
  }, []);

  // The chain is drawn from the last answer while the one for the newest picks is on its way: see `columnsOf`.
  const chainRef = useRef<Chain>({ levels: [], led: [], file: null });
  const { names, onMove, onLeave } = usePicks(columns?.path ?? null, chainRef);
  const { data } = useLoaded<Listing>(columns ? columnsUrl(columns.path, names, left) : null);
  // On a step out the folder left is drawn as it was on screen, with the answer that was beside it, until its own
  // answer comes: a late answer would otherwise take the columns past it and the preview off screen, and bring them
  // back in their slots with no slide.
  const own = columns ? standIn(data, columns.path, store.before(columns.path)) : undefined;
  const chain = columns ? columnsOf(own, slots, names, left) : { levels: [], led: [], file: null };
  chainRef.current = chain;
  const { levels } = chain;
  const ledFile = chain.file ? toEntry(chain.file.item, chain.file.listing.path, chain.file.at) : null;

  const shown = file ?? ledFile;
  const here = !columns || ledFile !== null;
  const going = useGoing(here, shown);
  const drawn = here ? shown : going;
  const pane = useRef<HTMLDivElement>(null);
  // A pane back in the slots while it slid out, as a step back in at once does, is in its slot from here: the slide
  // of the step takes it on.
  useLayoutEffect(() => {
    const el = pane.current;
    if (!here || !el?.style.position) return;
    for (const run of el.getAnimations()) run.cancel();
    el.removeAttribute("style");
  });
  let header: ComponentChildren = null;
  if (drawn) {
    const file = drawn;
    const learned = facts.path === file.path ? facts.list : [];
    const files = s.open ? store.files() : [];
    const raw = store.isRaw(file);
    const wrappable = store.wrappable();
    header = (
      <>
        <button class="btn only-open" aria-label="Back to the list" onClick={() => store.close()}>
          <Icon name="left" />
        </button>
        <KindIcon kind={file.kind} />
        <span class="nm trunc">{file.name}</span>
        <span class="facts trunc num">{[...learned, fmt.size(file.size), fmt.abs(file.mtime)].join(" · ")}</span>
        <span class="pos num only-open">
          {files.indexOf(file) + 1} / {files.length}
        </span>
        <button class="btn only-open step" aria-label="Previous file" onClick={() => store.step(-1)}>
          <Icon name="up" />
        </button>
        <button class="btn only-open step" aria-label="Next file" onClick={() => store.step(1)}>
          <Icon name="down" />
        </button>
        {hasSource(file) && (
          <button class="btn" aria-label="Show the source" aria-pressed={raw} title={raw ? "Show it rendered (r)" : "Show the source (r)"} onClick={() => store.flipRaw(file)}>
            <Icon name="code" />
          </button>
        )}
        {wrappable === file && (
          <button class="btn wide" aria-label="Wrap long lines" aria-pressed={store.wraps(file)} title={store.wraps(file) ? "Stop wrapping long lines (w)" : "Wrap long lines (w)"} onClick={() => store.flipWrap()}>
            <Icon name="wrap" />
          </button>
        )}
        <a class="btn wide" href={urls.raw(file.path)} download aria-label="Download" title="Download">
          <Icon name="download" />
        </a>
        {config.delete && (
          <button class="btn wide" aria-label="Delete" title={`Delete (${DELETE_KEY})`} onClick={() => store.askDelete(file)}>
            <Icon name="trash" />
          </button>
        )}
        <More file={file} wrappable={wrappable === file} />
        {!ledFile && (
          <button class="btn widen" aria-label={s.open ? "Back to the list" : "Full width"} title={s.open ? "Back to the list (esc)" : "Full width (↵)"} onClick={() => (s.open ? store.close() : store.activate())}>
            <Icon name={s.open ? "pane" : "expand"} />
          </button>
        )}
      </>
    );
  }

  return (
    // The slots are counted for the pane: the matches take one more than a folder's list does.
    <section class="right" style={`--slots: ${slots}`} onPointerMove={onMove} onPointerLeave={onLeave}>
      {/* First in the page and last on screen: a column that comes or goes never moves the pane, whose frames
          would load again if it did. It goes by the path of the file it shows, as a column goes by its folder's:
          the same file is the same pane, which slides with the columns. One that has just gone slides out as it
          was, live: see `useGoing`. */}
      {here ? (
        <div class="pane" key="pane" ref={pane} data-pane={shown?.path ?? ""}>
          {/* With nothing to preview, as in an empty folder or at a missing address, there is nothing to head. */}
          {header && (
            <div class="ph" onMouseDown={keepFocus}>
              {header}
            </div>
          )}
          <div class="pv">{shown && <Preview entry={shown} stamp={store.stamp(shown)} report={report} raw={store.isRaw(shown)} wrap={store.wraps(shown)} />}</div>
          {s.open && shown && !ledFile && <StepBar file={shown} />}
        </div>
      ) : (
        going && (
          <div class="pane going" key="pane" ref={pane} data-going={going.path} aria-hidden="true" inert>
            <div class="ph">{header}</div>
            <div class="pv">
              <Preview entry={going} stamp={store.stamp(going)} report={report} raw={store.isRaw(going)} wrap={store.wraps(going)} />
            </div>
          </div>
        )
      )}
      {levels.map((listing, level) => {
        const above = levels[level - 1];
        const at = above ? above.entries.findIndex((item) => item.n === chain.led[level - 1]) : -1;
        const into = above && at >= 0 ? above.entries[at] : undefined;
        // The folder under the cursor heads the first column. Each one after is the entry the one before leads on to.
        const head = level === 0 ? columns : above && into ? toEntry(into, above.path, at) : null;
        // A column goes by its folder, not its slot: a step moves it, and what it is doing goes with it.
        return head && <Column key={head.path} folder={head} listing={listing} led={chain.led[level]} edge={level === slots - 2} level={level} />;
      })}
    </section>
  );
}
