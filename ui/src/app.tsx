// Twin Pane: a dense list on the left, the file under the cursor on the right, a status line below.

import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { type Archive, type Listing, type TextPreview, urls } from "./api";
import { config } from "./config";
import * as fmt from "./fmt";
import { Icon, KindIcon, Sprite } from "./icons";
import { kindOf } from "./kinds";
import { Help, ThemeMenu } from "./overlays";
import { MOD, Palette } from "./palette";
import { Preview, Prose, useLoaded } from "./preview";
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
              <img src={urls.thumb(path, 160, item.m)} loading="lazy" alt="" />
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
  if (entry.kind === "image" && stage < 2) {
    const wanted = Math.ceil(width * (window.devicePixelRatio || 1));
    const src = stage === 0 ? urls.thumb(entry.path, wanted, entry.mtime) : urls.raw(entry.path);
    return (
      <div class="th">
        <img src={src} loading="lazy" alt="" onError={() => setStage(stage + 1)} />
      </div>
    );
  }
  if (entry.kind === "video" && stage < 2) {
    return (
      <div class="th">
        <video src={`${urls.raw(entry.path)}#t=2`} preload="metadata" muted playsInline onError={() => setStage(2)} />
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
  const { s } = store;

  const scroller = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  const cols = useRef(1);
  const [filtering, setFiltering] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [facts, setFacts] = useState<{ path: string; list: string[] }>({ path: "", list: [] });

  const report = useCallback((path: string, list: string[]) => {
    setFacts((old) => (old.path === path && old.list.join() === list.join() ? old : { path, list }));
  }, []);
  const onCols = useCallback((count: number) => {
    cols.current = count;
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const focusFilter = useCallback(() => {
    setFiltering(true);
    requestAnimationFrame(() => filterInput.current?.focus());
  }, []);

  const shown = s.open ?? store.cur();

  useEffect(() => {
    document.body.classList.toggle("open", s.open !== null);
  }, [s.open]);

  useEffect(() => {
    const name = s.open?.name ?? (s.path ? s.path.slice(s.path.lastIndexOf("/") + 1) : "");
    document.title = name ? `${name} - ${config.title}` : config.title;
  }, [s.open, s.path]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { s } = store;
      const { key } = event;
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
      const typing = (event.target as Element).closest("input, textarea, select");
      if (s.palette || typing || event.ctrlKey || event.metaKey || event.altKey) return;

      // With a file open, the keys that move the cursor step from file to file instead.
      const modal = s.open !== null;
      const across = s.view === "grid" ? cols.current : 1;
      const down = () => (modal ? store.step(1) : store.move(across));
      const up = () => (modal ? store.step(-1) : store.move(-across));
      const left = () => (modal ? store.step(-1) : across > 1 ? store.move(-1) : store.up());
      const right = () => (modal ? store.step(1) : across > 1 ? store.move(1) : store.activate());
      const actions: Record<string, () => void> = {
        j: down,
        ArrowDown: down,
        k: up,
        ArrowUp: up,
        h: left,
        ArrowLeft: left,
        l: right,
        ArrowRight: right,
        Enter: () => store.activate(),
        Backspace: () => store.up(),
        "-": () => store.up(),
        Escape: () => {
          if (s.open) store.close();
          else if (s.filter) store.setFilter("");
          setMenu(null);
        },
        Home: () => store.moveTo(0),
        End: () => store.moveTo(s.entries.length - 1),
        "/": focusFilter,
        g: () => store.setView(),
        s: () => store.setSort(),
        t: () => setScheme(isDark() ? "light" : "dark"),
        "?": () => store.setHelp(true),
      };
      const action = actions[key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focusFilter]);

  const indexOf = (event: MouseEvent): number | null => {
    const el = (event.target as Element).closest<HTMLElement>("[data-i]");
    return el ? Number(el.dataset.i) : null;
  };
  const onListClick = (event: MouseEvent) => {
    const index = indexOf(event);
    const entry = index === null ? undefined : s.entries[index];
    if (index === null || !entry) return;
    // One click moves the cursor, which is already the preview. A second opens.
    if (entry.dir || phone() || index === s.cursor) store.activate(index);
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
            <Thumb entry={entry} width={cell.width} />
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
    ` · ${fmt.size(s.bytes)} · by ${SORT_LABEL[s.sort.key].toLowerCase()}`;

  let header: ComponentChildren = null;
  if (shown) {
    const learned = facts.path === shown.path ? facts.list : [];
    const known = shown.dir ? (learned.length || shown.count === undefined ? learned : [fmt.items(shown.count)]) : [...learned, fmt.size(shown.size)];
    const files = s.open ? store.files() : [];
    header = (
      <>
        <button class="btn only-open" aria-label="Back to the list" onClick={() => store.close()}>
          <Icon name="left" />
        </button>
        <KindIcon kind={shown.kind} />
        <span class="nm trunc">{shown.name}</span>
        <span class="facts trunc num">{[...known, fmt.abs(shown.mtime)].join(" · ")}</span>
        {!shown.dir && (
          <>
            <span class="pos num only-open">
              {files.indexOf(shown) + 1} / {files.length}
            </span>
            <button class="btn only-open" aria-label="Previous file" onClick={() => store.step(-1)}>
              <Icon name="up" />
            </button>
            <button class="btn only-open" aria-label="Next file" onClick={() => store.step(1)}>
              <Icon name="down" />
            </button>
          </>
        )}
        <a
          class="btn"
          href={shown.dir ? urls.zip(shown.path) : urls.raw(shown.path)}
          download
          aria-label={shown.dir ? "Download as a zip" : "Download"}
          title={shown.dir ? "Download as a zip" : "Download"}
        >
          <Icon name="download" />
        </a>
        {!shown.dir && (
          <button
            class="btn widen"
            aria-label={s.open ? "Back to two panes" : "Full width"}
            onClick={() => (s.open ? store.close() : store.activate())}
          >
            <Icon name={s.open ? "pane" : "expand"} />
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <Sprite />
      <header class="top">
        <a class="wm" href="/" aria-label={`${config.title}, top folder`} onClick={inPlace(() => void store.showDir(""))}>
          <span class="wm-mark" />
          {config.title}
        </a>
        <Crumbs />
        <div class="tools">
          <button class="btn btn-line find" aria-label="Find anything" onClick={() => store.setPalette(true)}>
            <Icon name="search" />
            <span class="sp">Find anything</span>
            <kbd>{MOD} K</kbd>
          </button>
          <button class="btn" aria-label="List or grid" onClick={() => store.setView()}>
            <Icon name={s.view === "list" ? "grid" : "list"} />
          </button>
          <button class="btn" aria-label="Theme" onClick={(event) => setMenu(menu ? null : event.currentTarget)}>
            <Icon name="swatch" />
          </button>
        </div>
      </header>
      {config.header && <Prose class="note" html={config.header} />}
      <div class="main">
        <section class="left" onClick={onListClick} onDblClick={onListDoubleClick}>
          {s.view === "list" && <Columns />}
          <VGrid
            scroller={scroller}
            count={s.entries.length}
            grid={s.view === "grid"}
            cursor={s.cursor}
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
        <section class="right">
          <div class="ph">{header}</div>
          <div class="pv">{shown && <Preview entry={shown} report={report} />}</div>
        </section>
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
      {menu && <ThemeMenu anchor={menu} onClose={closeMenu} />}
    </>
  );
}
