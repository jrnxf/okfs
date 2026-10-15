// Twin Pane: a dense list on the left, what is under the cursor beside it, a status line below.

import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type Archive, type Listing, type TextPreview, nameOf, urls } from "./api";
import { config } from "./config";
import * as fmt from "./fmt";
import { Icon, KindIcon, Sprite } from "./icons";
import { keyFor, pressOf } from "./keys";
import { kindOf } from "./kinds";
import { ConfirmDelete, Help, ThemeMenu } from "./overlays";
import { MOD, Palette } from "./palette";
import { Prose, lookAhead, pagesAhead, useLoaded } from "./preview";
import { Aim, AIM_RECHECK } from "./aim";
import { FolderBar, Side } from "./side";
import { useSlide } from "./slide";
import { slots } from "./slots";
import { type Entry, SORT_LABEL, type SortKey, store } from "./store";
import { isDark, onThemeChange, setScheme } from "./theme";
import { type Cell, VGrid } from "./vgrid";

/** At this width and below, the list takes the whole screen and a file opens as a sheet over it. */
const PHONE = 760;
const phone = (): boolean => innerWidth <= PHONE;

/** Redraws the component whenever `subscribe` calls back. */
function useTick(subscribe: (listener: () => void) => () => void): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const redraw = () => tick((n) => n + 1);
    const stop = subscribe(redraw);
    // A change can land between the first draw and this subscription: draw once more to catch it.
    redraw();
    return stop;
  }, [subscribe]);
}

const subscribeStore = (listener: () => void) => store.subscribe(listener);
/** The slots are cut from the window's width: see `slotsFor`. */
const subscribeResize = (listener: () => void) => {
  addEventListener("resize", listener);
  return () => removeEventListener("resize", listener);
};

/** A plain click navigates in place; a click meant for a new tab or window is left to the browser. */
function inPlace(run: () => void) {
  return (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    run();
  };
}

/** Tiles wait this long before asking for their cover, so scrolling past does not ask at all. */
const COVER_SETTLE = 120;
const COVER_KINDS = new Set(["md", "code", "json", "csv", "text"]);

/** A folder's tile: its first four entries, pictures shown as pictures. */
function FolderCover({ entry }: { entry: Entry }) {
  const { data } = useLoaded<Listing>(urls.list(entry.path, 4), COVER_SETTLE);
  if (entry.count === 0 || !data || data.path !== entry.path || !data.entries.length) {
    return (
      <div class="th th-icon">
        <KindIcon kind="folder" />
        {entry.count === 0 && <span>Empty</span>}
      </div>
    );
  }
  return (
    <div class="th th-folder">
      {[0, 1, 2, 3].map((slot) => {
        const item = data.entries[slot];
        if (!item) return <div />;
        const kind = kindOf(item.n, item.d === true);
        const path = `${entry.path}/${item.n}`;
        return (
          <div>
            {kind === "image" && !item.n.toLowerCase().endsWith(".svg") ? (
              <img src={urls.thumb(path, 160, item.m, item.s)} loading="lazy" alt="" />
            ) : (
              <KindIcon kind={kind} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A text file's tile: its first lines, or for Markdown its title and opening words. */
function TextCover({ entry }: { entry: Entry }) {
  const url = urls.head(entry.path);
  const { data, url: from } = useLoaded<TextPreview>(url, COVER_SETTLE);
  if (data && from === url && data.kind === "doc") {
    return (
      <div class="th th-doc">
        <span class="bar" />
        <span class="t">{data.title}</span>
        <span class="x">{data.text}</span>
      </div>
    );
  }
  if (data && from === url && data.kind === "code") {
    return <div class="th th-code" dangerouslySetInnerHTML={{ __html: data.html }} />;
  }
  return (
    <div class="th th-icon">
      <KindIcon kind={entry.kind} />
      <span class="big">.{entry.ext || "?"}</span>
    </div>
  );
}

/** A zip's tile: the names inside it. */
function ZipCover({ entry }: { entry: Entry }) {
  const url = urls.archive(entry.path);
  const { data, url: from } = useLoaded<Archive>(url, COVER_SETTLE);
  if (data && from === url && data.entries.length) {
    return <div class="th th-code">{data.entries.slice(0, 16).map((item) => `${item.name}\n`)}</div>;
  }
  return (
    <div class="th th-icon">
      <KindIcon kind="archive" />
      <span class="big">.zip</span>
    </div>
  );
}

/** A grid tile's picture. */
function Thumb({ entry, width }: { entry: Entry; width: number }) {
  // 0: the thumbnail, 1: the image itself, 2: give up and show an icon.
  const [stage, setStage] = useState(entry.ext === "svg" ? 1 : 0);
  if (entry.dir) return <FolderCover entry={entry} />;
  if (COVER_KINDS.has(entry.kind)) return <TextCover entry={entry} />;
  if (entry.ext === "zip") return <ZipCover entry={entry} />;
  // The file itself is asked for by an address that moves when it is rewritten, as the thumbnail's does.
  const raw = `${urls.raw(entry.path)}?v=${entry.mtime}.${entry.size}`;
  if (entry.kind === "image" && stage < 2) {
    const wanted = Math.ceil(width * (window.devicePixelRatio || 1));
    const src = stage === 0 ? urls.thumb(entry.path, wanted, entry.mtime, entry.size) : raw;
    return (
      <div class="th">
        <img src={src} loading="lazy" alt="" onError={() => setStage(stage + 1)} />
      </div>
    );
  }
  if (entry.kind === "video" && stage < 2) {
    return (
      <div class="th">
        <video src={`${raw}#t=2`} preload="metadata" muted playsInline onError={() => setStage(2)} />
      </div>
    );
  }
  if (entry.kind === "pdf" && config.pdf && stage === 0) {
    // The first page, drawn by the server. A PDF it cannot draw gets the sheet below, as every PDF did.
    const wanted = Math.ceil(width * (window.devicePixelRatio || 1));
    return (
      <div class="th th-page">
        <img src={urls.thumb(entry.path, wanted, entry.mtime, entry.size)} loading="lazy" alt="" onError={() => setStage(2)} />
      </div>
    );
  }
  if (entry.kind === "pdf") {
    return (
      <div class="th th-sheet">
        <div>
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
    );
  }
  return (
    <div class="th th-icon">
      <KindIcon kind={entry.kind} />
      <span class="big">.{entry.ext || "?"}</span>
    </div>
  );
}

function Crumbs() {
  const { s } = store;
  const parts = s.path ? s.path.split("/") : [];
  const trail = [
    { name: config.root, path: "" },
    ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") })),
  ];
  const parent = parts.slice(0, -1).join("/");
  return (
    <nav class="crumbs" aria-label="Path">
      {s.path && (
        <a class="back" href={urls.view(parent, true)} aria-label="Up one folder" onClick={inPlace(() => store.up())}>
          <Icon name="left" />
        </a>
      )}
      {trail.map((crumb, i) => (
        <>
          {i > 0 && <i>/</i>}
          <a href={urls.view(crumb.path, true)} onClick={inPlace(() => void store.showDir(crumb.path))}>
            {crumb.name}
          </a>
        </>
      ))}
    </nav>
  );
}

function Columns() {
  const { key, dir } = store.s.sort;
  const head = (column: SortKey, label: string, right: boolean) => (
    <button class={right ? "r" : undefined} onClick={() => store.setSort(column)}>
      {label}
      {key === column && <Icon name={dir > 0 ? "up" : "down"} />}
    </button>
  );
  return (
    <div class="cols label">
      <span />
      {head("name", "Name", false)}
      {head("size", "Size", true)}
      {head("time", "Mod.", true)}
    </div>
  );
}

function Empty() {
  const { s } = store;
  if (s.status === "loading" || s.entries.length) return null;
  let body: ComponentChildren;
  if (s.status === "missing") {
    body = (
      <>
        <b>Nothing at this address</b>
        <span class="num">/{s.path}</span>
        <a class="btn btn-line" href="/" onClick={inPlace(() => void store.showDir(""))}>
          Go to the top folder
        </a>
      </>
    );
  } else if (s.filter) {
    body = (
      <>
        <b>No name contains “{s.filter}”</b>
        <span>
          Press <kbd>esc</kbd> to clear, or <kbd>{MOD} K</kbd> to look everywhere.
        </span>
      </>
    );
  } else {
    body = (
      <>
        <b>Nothing in here yet</b>
        <span class="num">/{s.path}</span>
      </>
    );
  }
  return <div class="empty">{body}</div>;
}

export function App() {
  useTick(subscribeStore);
  useTick(onThemeChange);
  useTick(subscribeResize);
  const { s } = store;
  const cut = slots();

  const scroller = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  useSlide(main, s.path);
  const filterInput = useRef<HTMLInputElement>(null);
  const cols = useRef(1);
  const [filtering, setFiltering] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);

  const onCols = useCallback((count: number) => {
    cols.current = count;
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const focusFilter = useCallback(() => {
    setFiltering(true);
    requestAnimationFrame(() => filterInput.current?.focus());
  }, []);

  const here = store.here();
  const flippable = store.flippable();

  // What lies past the cursor, the way it is moving, is asked for before the cursor gets there: the columns
  // of the folders, and the previews of the files only while one is on show.
  const previewing = s.peek || s.open !== null;
  const cursorWas = useRef(s.cursor);
  useLayoutEffect(() => {
    const step = s.cursor >= cursorWas.current ? 1 : -1;
    cursorWas.current = s.cursor;
    if (s.status !== "ready") return;
    lookAhead(s.entries, s.cursor, step, (entry) => store.stamp(entry), previewing);
    if (previewing) pagesAhead(s.entries, s.cursor, step, (entry) => store.stamp(entry));
  }, [s.cursor, s.entries, s.status, previewing, cut]);

  // A name cut short by an ellipsis is shown in full under the pointer. A name that fits has no tip to repeat it.
  useEffect(() => {
    const tip = (event: PointerEvent) => {
      const el = (event.target as Element).closest?.<HTMLElement>(".trunc");
      // A tip of its own, such as a time's date, stays.
      if (!el || (el.title && el.dataset.tip === undefined)) return;
      if (el.scrollWidth > el.clientWidth) {
        el.title = el.textContent ?? "";
        el.dataset.tip = "";
      } else if (el.dataset.tip !== undefined) {
        el.removeAttribute("title");
        delete el.dataset.tip;
      }
    };
    document.addEventListener("pointerover", tip);
    return () => document.removeEventListener("pointerover", tip);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("open", s.open !== null);
  }, [s.open]);

  useEffect(() => {
    document.body.classList.toggle("peek", s.peek);
  }, [s.peek]);

  useEffect(() => {
    const name = s.open?.name ?? (s.path ? s.path.slice(s.path.lastIndexOf("/") + 1) : "");
    document.title = name ? `${name} - ${config.title}` : config.title;
  }, [s.open, s.path]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { s } = store;
      const { key } = event;
      // The delete dialog takes every key while it is up.
      if (s.doomed) return;
      if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "k") {
        event.preventDefault();
        store.setPalette(!s.palette);
        return;
      }
      if (s.help) {
        if (key === "Escape" || key === "?") {
          store.setHelp(false);
          event.preventDefault();
        }
        return;
      }
      if (s.palette) return;
      const host = {
        across: cols.current,
        filter: focusFilter,
        closeMenu: () => setMenu(null),
        flipScheme: () => setScheme(isDark() ? "light" : "dark"),
      };
      // A key the list takes does only what the list does with it: space opens the preview and scrolls nothing.
      const action = keyFor(store, host, pressOf(event));
      if (action) {
        // From here the keys drive the cursor: the pointer does not until it moves again.
        hover.current.keys = true;
        hover.current.byHover = -1;
        event.preventDefault();
        action();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focusFilter]);

  // The pointer drives the cursor, at once, as long as no key has taken over. A pointer on its way to the preview
  // is let past the rows between: see `aim.ts`.
  const hover = useRef({ aim: new Aim(), keys: false, held: -1, byHover: -1, timer: 0, at: { x: -1, y: -1 } });
  const settle = (index: number) => {
    const h = hover.current;
    clearTimeout(h.timer);
    h.held = -1;
    if (index !== store.s.cursor) {
      h.byHover = index;
      store.moveTo(index);
    }
  };
  const aimed = (): boolean => {
    const [list, pane] = [scroller.current, main.current?.querySelector<HTMLElement>(".right")];
    if (!list || !pane) return false;
    return hover.current.aim.aiming(list.getBoundingClientRect(), pane.getBoundingClientRect());
  };
  const onListMove = (event: PointerEvent) => {
    const h = hover.current;
    if (event.pointerType !== "mouse") return;
    // A row that slid under a still pointer, as the keys scroll the list, is not the pointer moving.
    if (event.clientX === h.at.x && event.clientY === h.at.y) return;
    h.at = { x: event.clientX, y: event.clientY };
    h.keys = false;
    h.aim.track({ x: event.clientX, y: event.clientY });
    const { s } = store;
    if (s.open || s.palette || s.help || s.doomed || s.status !== "ready") return;
    const index = indexOf(event);
    if (index === null || !s.entries[index]) return;
    if (index === s.cursor) {
      clearTimeout(h.timer);
      h.held = -1;
      return;
    }
    clearTimeout(h.timer);
    if (!aimed()) {
      settle(index);
      return;
    }
    // On its way to the preview: the row under the pointer waits, and is taken if the pointer stops.
    h.held = index;
    const look = () => {
      if (hover.current.keys || hover.current.held !== index) return;
      if (aimed()) hover.current.timer = window.setTimeout(look, AIM_RECHECK);
      else settle(index);
    };
    h.timer = window.setTimeout(look, AIM_RECHECK);
  };
  const onListLeave = () => {
    clearTimeout(hover.current.timer);
    hover.current.held = -1;
  };

  const indexOf = (event: MouseEvent): number | null => {
    const el = (event.target as Element).closest<HTMLElement>("[data-i]");
    return el ? Number(el.dataset.i) : null;
  };
  const onListClick = (event: MouseEvent) => {
    const index = indexOf(event);
    const entry = index === null ? undefined : s.entries[index];
    if (index === null || !entry) return;
    // One click moves the cursor. A second opens, and so does the first on a phone, which has no keys to open with.
    // A cursor the pointer put there is not a click yet: the first click on it still only selects, as before.
    const placed = hover.current.byHover === index;
    hover.current.byHover = -1;
    if (entry.dir || phone() || (index === s.cursor && !placed)) store.activate(index);
    else store.moveTo(index);
  };
  const onListDoubleClick = (event: MouseEvent) => {
    const index = indexOf(event);
    if (index !== null) store.activate(index);
  };

  const renderCell = (index: number, cell: Cell) => {
    const entry = s.entries[index];
    if (!entry) return null;
    const on = index === s.cursor;
    const style = { top: `${cell.top}px`, left: `${cell.left}px`, width: `${cell.width}px`, height: `${cell.height}px` };
    if (s.view === "grid") {
      return (
        <div class="tile" role="option" aria-selected={on} data-i={index} style={style} key={entry.path}>
          <div class="box">
            {/* A cover that failed while its file was being written is tried again when the file has changed. */}
            <Thumb key={`${entry.mtime} ${entry.size}`} entry={entry} width={cell.width} />
          </div>
          <div class="nm trunc">{entry.name}</div>
        </div>
      );
    }
    return (
      <div class="row" role="option" aria-selected={on} data-i={index} data-dir={entry.dir ? "" : undefined} style={style} key={index}>
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
  };

  const total = s.all.length;
  const info =
    (s.filter ? `${fmt.count(s.entries.length)} of ${fmt.count(total)}` : fmt.items(total)) +
    // The size is of the files right here; a folder of folders has none to add up.
    `${s.all.some((entry) => !entry.dir) ? ` · ${fmt.size(s.bytes)}` : ""} · by ${SORT_LABEL[s.sort.key].toLowerCase()}`;

  return (
    <>
      <Sprite />
      <header class="top">
        <a class="wm" href="/" aria-label={`${config.title}, top folder`} onClick={inPlace(() => void store.showDir(""))}>
          <span class="wm-mark" />
          {config.title}
        </a>
        <Crumbs />
        <div class="tools" onMouseDown={(event) => event.preventDefault()}>
          <button class="btn btn-line find" aria-label="Find anything" onClick={() => store.setPalette(true)}>
            <Icon name="search" />
            <span class="sp">Find anything</span>
            <kbd>{MOD} K</kbd>
          </button>
          {/* A phone has no pane beside the list to hold this, and a tap on a folder goes in. */}
          {here && (
            <button class="btn touch" aria-label="Delete this folder" onClick={() => store.askDelete(here)}>
              <Icon name="trash" />
            </button>
          )}
          <button class="btn" aria-label="List or grid" onClick={() => store.setView()}>
            <Icon name={s.view === "list" ? "grid" : "list"} />
          </button>
          <button class="btn" aria-label="Theme" onClick={(event) => setMenu(menu ? null : event.currentTarget)}>
            <Icon name="swatch" />
          </button>
        </div>
      </header>
      {config.header && <Prose class="note" html={config.header} />}
      <div class="main" ref={main} style={`--slots: ${cut}`}>
        <section class="left" data-pane={s.path} onPointerMove={onListMove} onPointerLeave={onListLeave} onClick={onListClick} onDblClick={onListDoubleClick}>
          <FolderBar
            name={s.path ? nameOf(s.path) : config.root}
            path={s.path}
            count={s.status === "ready" ? s.all.length : undefined}
            mtime={s.status === "ready" ? s.mtime : undefined}
            doomed={here}
          />
          {s.view === "list" && <Columns />}
          <VGrid
            scroller={scroller}
            count={s.entries.length}
            grid={s.view === "grid"}
            cursor={s.cursor}
            caught={s.caught}
            listKey={`${s.path}\n${s.sort.key}${s.sort.dir}\n${s.filter}`}
            render={renderCell}
            onCols={onCols}
            empty={<Empty />}
          >
            {s.readme && !s.filter && (
              <section class="readme">
                <div class="readme-hd label">
                  <KindIcon kind="md" />
                  {s.readme.name}
                </div>
                <Prose html={s.readme.html} />
              </section>
            )}
          </VGrid>
        </section>
        <Side slots={cut} />
      </div>
      <footer class={filtering || s.filter ? "status filtering" : "status"}>
        <span class="mode">{s.open ? "view" : s.filter ? "filter" : "browse"}</span>
        <span class="info num">{s.status === "ready" ? info : ""}</span>
        <label class="fil">
          /
          <input
            ref={filterInput}
            type="text"
            value={s.filter}
            name="filter"
            spellcheck={false}
            autocomplete="off"
            aria-label="Filter this folder"
            onInput={(event) => store.setFilter(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.currentTarget.blur();
                store.setFilter("");
                setFiltering(false);
              } else if (event.key === "Enter" || event.key === "ArrowDown") {
                event.currentTarget.blur();
                event.preventDefault();
              }
            }}
            onBlur={() => setFiltering(false)}
          />
        </label>
        <span class="sp" />
        <span class="hints">
          <span>
            <kbd>j</kbd>
            <kbd>k</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          {!s.open && (
            <span>
              <kbd>space</kbd> preview
            </span>
          )}
          {flippable && (
            <span>
              <kbd>r</kbd> {s.raw === flippable.path ? "rendered" : "source"}
            </span>
          )}
          <span>
            <kbd>/</kbd> filter
          </span>
          <span>
            <kbd>g</kbd> grid
          </span>
          <span>
            <kbd>s</kbd> sort
          </span>
          <span>
            <kbd>?</kbd> keys
          </span>
        </span>
        <button class="btn touch" onClick={focusFilter}>
          <Icon name="search" />
          Filter
        </button>
      </footer>
      {s.palette && <Palette />}
      {s.help && <Help />}
      {s.doomed && <ConfirmDelete key={s.doomed.path} doomed={s.doomed} />}
      {menu && <ThemeMenu anchor={menu} onClose={closeMenu} />}
    </>
  );
}
