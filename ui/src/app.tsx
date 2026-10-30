// Twin Pane: a dense list on the left, what is under the cursor beside it, a status line below.

import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { nameOf, parentOf, urls } from "./api";
import { config } from "./config";
import * as fmt from "./fmt";
import { Icon, KindIcon, Sprite } from "./icons";
import { keyFor, pressOf } from "./keys";
import { copyText } from "./clip";
import { MatchBar, MatchColumns, MatchRow, MatchesEmpty, TrailButton, matchesInfo } from "./matches";
import { ConfirmLeave } from "./editor";
import { ConfirmDelete, Help, ThemeMenu } from "./overlays";
import { MOD, Palette } from "./palette";
import { AGE, DROP_PANE, DROP_ROW, EMPTY, EMPTY_HEAD, HEAD, HEADS, LIST_PAD, LIST_ROW, ROW, ROW_GRID, ROW_ON, ROW_REST, SIZE, nameWeight } from "./look";
import { Prose, lookAhead, pagesAhead } from "./preview";
import { NEEDS_KEY, NOT_ANSWERING, useDown } from "./reach";
import { Aim, AIM_RECHECK } from "./aim";
import { EMPTY_FOLDER, FolderBar, Side } from "./side";
import { useSlide } from "./slide";
import { slots } from "./slots";
import { type Entry, type MenuTarget, SORT_LABEL, type SortKey, refusedName, store } from "./store";
import { isDark, onThemeChange, setScheme } from "./theme";
import { drop, pick, uploads } from "./upload";
import { rowId, rowName } from "./rows";
import { type Cell, VList } from "./vlist";
import { ClashDialog, NameDialog, Tray } from "./write-ui";
import { ContextMenu, Toast } from "./menu";
import { Picker } from "./picker";
import { ConfirmForget, TrashItemPane, TrashList } from "./trash";

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
const subscribeUploads = (listener: () => void) => uploads.subscribe(listener);

/** True for a drag that carries files from outside the page, as opposed to text or a link. */
const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes("Files") === true;

/** The type of a drag of the list's own rows: their paths, a line each. A drop on a folder moves them there. */
const ROWS_TYPE = "application/x-okfs-rows";
const carriesRows = (event: DragEvent): boolean => event.dataTransfer?.types.includes(ROWS_TYPE) === true;
/** The rows being dragged, while a drag of them goes on: a drop is not told what it carries until it lands. */
let dragging: string[] = [];

/**
 * The folder a drag of rows over `target` would move them into: a folder row that is not one of them, or a crumb above
 * the list. `null` when there is none.
 */
function rowsTarget(target: EventTarget | null): string | null {
  const el = target instanceof Element ? target : null;
  const at = el?.closest<HTMLElement>("[data-drop],[data-crumb]");
  const path = at?.dataset.drop ?? at?.dataset.crumb;
  if (path === undefined || path === store.s.path) return null;
  if (dragging.some((from) => path === from || path.startsWith(`${from}/`) || parentOf(from) === path)) return null;
  return path;
}

/** How long a press on a row has to last to open its menu, as a right click does. */
const LONG_PRESS = 480;

/**
 * The folder a drag of files over `target` would upload into: the folder row under it, in the list or in a column,
 * or else the column it is over, or else the folder on screen. `null` when nothing can be added there.
 */
function dropTarget(target: EventTarget | null): string | null {
  const here = store.addsTo();
  if (here === null) return null;
  const el = target instanceof Element ? target : null;
  const row = el?.closest<HTMLElement>("[data-drop]");
  if (row?.dataset.drop !== undefined) return row.dataset.drop;
  const column = el?.closest<HTMLElement>("[data-level][data-pane]");
  return column?.dataset.pane ?? here;
}

/** The slots are cut from the window's width: see `slotsFor`. */
const subscribeResize = (listener: () => void) => {
  addEventListener("resize", listener);
  return () => removeEventListener("resize", listener);
};

/**
 * A plain click navigates in place; a click meant for a new tab or window is left to the browser. One that would leave
 * unsaved changes in the editor asks first.
 */
function inPlace(run: () => void) {
  return (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    store.leave(run);
  };
}

/** The buttons in the top bar sit a little closer than a button's own padding has them. */
const TOOL = "px-[calc(7px*var(--density))]";

function Crumbs() {
  const { s } = store;
  const parts = s.path && !s.trashView ? s.path.split("/") : [];
  const trail = [
    { name: config.root, path: "" },
    ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") })),
  ];
  const parent = parts.slice(0, -1).join("/");
  // Over the matches, the folder they are over is where back goes, and the query is the last crumb.
  const finding = s.finding && s.matches;
  // A phone has room for the last crumb only, and the way back beside it.
  const link = "whitespace-nowrap rounded px-1.5 py-0.75 no-underline hover:bg-hover hover:text-fg";
  const crumb = `${link} last-of-type:overflow-hidden last-of-type:text-ellipsis last-of-type:font-strong last-of-type:text-fg phone:hidden phone:last-of-type:inline-flex`;
  const back = `${link} hidden phone:-ml-1.5 phone:inline-flex phone:p-1.5 phone:text-muted`;
  const slash = "flex-none not-italic text-faint phone:hidden";
  return (
    <nav class="flex min-w-0 flex-1 items-center overflow-hidden text-muted" aria-label="Path">
      {s.trashView ? (
        <a class={back} href={urls.view(s.path, true)} aria-label="Close the Trash" onClick={inPlace(() => store.showTrash(false))}>
          <Icon name="left" />
        </a>
      ) : finding ? (
        <a class={back} href={urls.view(s.path, true)} aria-label="Close the matches" onClick={inPlace(() => store.leaveFind())}>
          <Icon name="left" />
        </a>
      ) : (
        s.path && (
          <a class={back} href={urls.view(parent, true)} aria-label="Up one folder" onClick={inPlace(() => store.up())}>
            <Icon name="left" />
          </a>
        )
      )}
      {trail.map((step, i) => (
        <>
          {i > 0 && <i class={slash}>/</i>}
          <a
            class={`${crumb}${uploads.target === step.path && step.path !== s.path ? ` ${DROP_ROW}` : ""}`}
            href={urls.view(step.path, true)}
            data-crumb={step.path}
            onClick={inPlace(() => {
              if (s.trashView) store.showTrash(false);
              void store.showDir(step.path);
            })}
          >
            {step.name}
          </a>
        </>
      ))}
      {finding && (
        <>
          <i class={slash}>/</i>
          <a class={crumb} href={location.href} onClick={inPlace(() => undefined)}>
            Find “{finding.q}”
          </a>
        </>
      )}
      {s.trashView && (
        <>
          <i class={slash}>/</i>
          <a class={crumb} href={location.href} onClick={inPlace(() => undefined)}>
            Trash
          </a>
        </>
      )}
    </nav>
  );
}

function Columns() {
  const { key, dir } = store.s.sort;
  const head = (column: SortKey, label: string, right: boolean) => (
    <button class={`${HEAD} hover:text-fg ${right ? "justify-end" : ""}`} onClick={() => store.setSort(column)}>
      {label}
      {key === column && <Icon name={dir > 0 ? "up" : "down"} class="size-2.75 text-accent" />}
    </button>
  );
  return (
    <div class={`${HEADS} ${ROW_GRID}`}>
      <span />
      {head("name", "Name", false)}
      {head("size", "Size", true)}
      {head("time", "Mod.", true)}
    </div>
  );
}

/** The tip under the name field: why a name is refused, or the keys. Its pointer is a triangle above it, outside it. */
const TIP =
  "absolute top-[calc(100%+6px)] left-[-6px] z-30 rounded-[min(var(--radius),5px)] px-2 py-1 text-xs whitespace-nowrap shadow before:absolute before:bottom-full before:left-3 before:border-[5px] before:border-t-0 before:border-transparent before:content-['']";
const TIP_ERROR = `${TIP} bg-fg text-bg before:border-b-fg`;
const TIP_KEYS = `${TIP} border border-line bg-surface text-muted [&_kbd]:h-[1.5em] [&_kbd]:min-w-[1.5em] before:-top-[6px] before:left-[11px] before:border-[6px] before:border-t-0 before:border-b-line after:absolute after:bottom-full after:left-3 after:border-[5px] after:border-t-0 after:border-transparent after:border-b-surface after:content-['']`;

/**
 * The field that takes a name in place of the entry's, in its row. A file's name is selected up to its extension, so
 * what is typed keeps it; a folder's is selected whole. Enter saves, Esc puts the old name back, a click elsewhere
 * saves. A name okfs would refuse says so under the field before it is sent.
 */
function RenameField({ entry }: { entry: Entry }) {
  const { s } = store;
  const field = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(entry.name);
  const error = s.renaming?.error;
  useLayoutEffect(() => {
    const input = field.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const dot = entry.dir ? -1 : entry.name.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, [entry.path]);
  const live = value === entry.name ? null : refusedName(value, s.all, entry.name);
  const said = live ?? error;
  return (
    <span class="relative block w-full min-w-0">
      <input
        ref={field}
        class={`-ml-1.5 h-[calc(24px*var(--density))] w-full rounded-[min(var(--radius),5px)] border-[1.5px] border-accent px-1.25 font-medium text-fg shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)] outline-none ${said ? "bg-accent-soft" : "bg-surface"} pointer-coarse:text-[16px]`}
        value={value}
        spellcheck={false}
        autocomplete="off"
        aria-label={`New name for ${entry.name}`}
        aria-invalid={said ? true : undefined}
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void store.rename(event.currentTarget.value);
          else if (event.key === "Escape") void store.rename(null);
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onBlur={(event) => {
          if (store.s.renaming?.path === entry.path) void store.rename(event.currentTarget.value);
        }}
        onClick={(event) => event.stopPropagation()}
        onDblClick={(event) => event.stopPropagation()}
      />
      {said ? (
        <span class={TIP_ERROR} role="alert">
          {said}
        </span>
      ) : (
        <span class={TIP_KEYS}>
          <kbd>↵</kbd> save · <kbd>esc</kbd> cancel
        </span>
      )}
    </span>
  );
}

/** The rows of `list` on screen at once, less one, which a page keeps in sight. Before it is drawn, ten. */
function pageOf(list: HTMLElement | null): number {
  const row = list?.querySelector(".probe")?.getBoundingClientRect().height;
  if (!list || !row) return 10;
  return Math.max(1, Math.floor(list.clientHeight / row) - 1);
}

/** The keys the foot of the page hints at. */
const HINTS = "items-center gap-3 overflow-hidden whitespace-nowrap *:inline-flex *:items-center *:gap-1 phone:hidden";

/** What the foot of the page says for each reason okfs cannot be reached. */
const UNREACHED = {
  [NOT_ANSWERING]: `${NOT_ANSWERING}. Retrying…`,
  [NEEDS_KEY]: `${NEEDS_KEY}: open the address okfs printed`,
};

/**
 * A quiet word at the foot of the page: that okfs is not answering or refuses the key, for as long as it does, or
 * what was just done. It is always in the page, so a screen reader hears it change.
 */
function Notice() {
  const down = useDown();
  const text = down ? UNREACHED[down] : store.s.notice;
  return (
    <div
      class={`fixed bottom-[calc(28px*var(--density)+10px)] left-1/2 z-40 flex max-w-[calc(100vw-32px)] transform-[translateX(-50%)] animate-[notice-in_160ms_var(--ease-out)] items-center gap-2 rounded border border-line bg-surface px-3 py-1.5 text-s whitespace-nowrap text-fg shadow pointer-events-none empty:hidden motion-reduce:animate-none phone:bottom-[calc(44px*var(--density)+env(safe-area-inset-bottom)+10px)] ${down ? "before:size-1.5 before:flex-none before:animate-[notice-wait_1.6s_ease-in-out_infinite] before:rounded-[50%] before:bg-accent before:content-[''] motion-reduce:before:animate-none" : ""}`}
      role="status"
    >
      {text ? <span class="min-w-0 truncate">{text}</span> : null}
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
        <b class={EMPTY_HEAD}>Nothing at this address</b>
        <span class="num">/{s.path}</span>
        <a class="btn btn-line mt-2.5" href="/" onClick={inPlace(() => void store.showDir(""))}>
          Go to the top folder
        </a>
      </>
    );
  } else if (s.filter) {
    body = (
      <>
        <b class={EMPTY_HEAD}>No name contains “{s.filter}”</b>
        <span>
          Press <kbd>esc</kbd> to clear, or <kbd>{MOD} K</kbd> to look everywhere.
        </span>
      </>
    );
  } else {
    body = (
      <>
        <b class={EMPTY_HEAD}>{EMPTY_FOLDER}</b>
        <span class="num">/{s.path}</span>
      </>
    );
  }
  return <div class={EMPTY}>{body}</div>;
}

export function App() {
  useTick(subscribeStore);
  useTick(subscribeUploads);
  useTick(onThemeChange);
  useTick(subscribeResize);
  const { s } = store;
  const cut = slots();

  const scroller = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  // Drawn with the change, before the panes are measured for the slide: a frame later, the slide would start from
  // the layout of a file that no longer has the full width, or not yet has it.
  useLayoutEffect(() => {
    document.body.classList.toggle("open", s.open !== null);
  }, [s.open]);
  useSlide(main, s.path, s.open !== null);
  const filterInput = useRef<HTMLInputElement>(null);
  const queryInput = useRef<HTMLInputElement>(null);
  const [filtering, setFiltering] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);
  const focusFilter = useCallback(() => {
    // Over the matches, what narrows them is their query.
    if (store.s.finding) {
      queryInput.current?.focus();
      queryInput.current?.select();
      return;
    }
    setFiltering(true);
  }, []);
  // The field takes the focus as it is drawn, in the task of the key that asked for it: a key typed right after the /
  // is the filter's, where a frame later the list would have taken it as a move.
  useLayoutEffect(() => {
    if (filtering) filterInput.current?.focus();
  }, [filtering]);
  const finding = s.finding && s.matches !== null;
  const list = store.list();
  const at = store.at();
  // The matches take two slots, for their folders: the pane beside them the rest. With two in all, they take both.
  const wide = finding && cut > 2;
  // The filter's field takes the hints' place while it is in use.
  const filterShown = !finding && (filtering || s.filter !== "");

  const here = store.here();
  const adds = store.addsTo();
  const flippable = store.flippable();
  const wrappable = store.wrappable();

  // What lies past the cursor, the way it is moving, is asked for before the cursor gets there: the previews
  // of the files, and the columns of the folders while no file has the full width.
  const columns = s.open === null;
  const cursorWas = useRef(at);
  useLayoutEffect(() => {
    const step = at >= cursorWas.current ? 1 : -1;
    cursorWas.current = at;
    if (s.status !== "ready") return;
    const source = (entry: Entry) => store.isRaw(entry);
    lookAhead(list, at, step, (entry) => store.stamp(entry), columns ? (path) => store.leftIn(path) : null, source);
    pagesAhead(list, at, step, (entry) => store.stamp(entry), source);
  }, [at, s.entries, s.matches?.list, finding, s.status, columns, cut, s.hidden]);

  // A name cut short by an ellipsis is shown in full under the pointer. A name that fits has no tip to repeat it.
  useEffect(() => {
    const tip = (event: PointerEvent) => {
      const el = (event.target as Element).closest?.<HTMLElement>(".truncate");
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
    const name = s.open?.name ?? (s.path ? s.path.slice(s.path.lastIndexOf("/") + 1) : "");
    document.title = name ? `${name} - ${config.title}` : config.title;
  }, [s.open, s.path]);

  // Listening from the first render, not after the first paint: a key pressed as the page appears is not lost.
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { s } = store;
      const { key } = event;
      // A key the editor took is its own, as Esc is when it leaves.
      if (event.defaultPrevented) return;
      // A dialog takes every key while it is up, and so does the menu.
      if (s.doomed || s.naming || s.leaving || uploads.asking || s.picking || s.forgetting || s.menu) return;
      const typing = pressOf(event).typing;
      // Undo what the toast says was done, while it is up, as long as the keys are not writing text.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && key.toLowerCase() === "z" && !typing && !s.palette) {
        if (store.undo()) event.preventDefault();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && key.toLowerCase() === "a" && !typing && !s.palette && !s.open && !s.finding) {
        event.preventDefault();
        store.selectAll();
        return;
      }
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
        filter: focusFilter,
        closeMenu: () => setMenu(null),
        flipScheme: () => setScheme(isDark() ? "light" : "dark"),
        page: () => pageOf(scroller.current),
        menu: () => {
          // At the row under the cursor, a little in from its left edge, where a pointer would be.
          const row = document.querySelector<HTMLElement>("[data-cursor]");
          const box = row?.getBoundingClientRect();
          store.menuForCursor(box ? { x: box.left + 36, y: box.bottom - 4 } : { x: innerWidth / 3, y: innerHeight / 3 });
        },
        copyPath: () => {
          const paths = store.pickedEntries().map((entry) => `/${entry.path}`);
          if (!paths.length) return;
          copyText(paths.join("\n"))
            .then(() => store.say(paths.length === 1 ? `Copied ${paths[0]}` : `Copied ${paths.length} paths`))
            .catch(() => store.say("The browser would not copy"));
        },
      };
      // A key the list takes does only what the list does with it: an arrow moves the cursor and scrolls nothing.
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

  // A file dropped anywhere else on the page would leave it for the file: it is uploaded where it is let go, or nowhere.
  useEffect(() => {
    if (!config.upload) return;
    const hold = (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    document.addEventListener("dragover", hold);
    document.addEventListener("drop", hold);
    return () => {
      document.removeEventListener("dragover", hold);
      document.removeEventListener("drop", hold);
    };
  }, []);
  const onDragOver = (event: DragEvent) => {
    if (carriesRows(event)) {
      const target = rowsTarget(event.target);
      // Alt copies, as in a file manager: that needs adding, a move needs changing.
      const copying = event.altKey;
      const may = target !== null && (copying ? config.upload : config.edit);
      uploads.aim(may ? target : null);
      if (!may || !event.dataTransfer) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = copying ? "copy" : "move";
      return;
    }
    const target = carriesFiles(event) ? dropTarget(event.target) : null;
    if (target === null || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    uploads.aim(target);
  };
  const onDragLeave = (event: DragEvent) => {
    if (!(event.relatedTarget instanceof Node && main.current?.contains(event.relatedTarget))) uploads.aim(null);
  };
  const onDrop = (event: DragEvent) => {
    if (carriesRows(event)) {
      const target = rowsTarget(event.target);
      uploads.aim(null);
      const copying = event.altKey;
      if (target === null || !(copying ? config.upload : config.edit)) return;
      event.preventDefault();
      const paths = dragging;
      dragging = [];
      void store.transfer(copying ? "copy" : "move", paths, target);
      return;
    }
    const target = carriesFiles(event) ? dropTarget(event.target) : null;
    uploads.aim(null);
    if (target === null || !event.dataTransfer) return;
    event.preventDefault();
    drop(event.dataTransfer, target);
  };

  // The pointer drives the cursor, at once, as long as no key has taken over. A pointer on its way to the preview
  // is let past the rows between: see `aim.ts`.
  const hover = useRef({ aim: new Aim(), keys: false, held: -1, byHover: -1, timer: 0, at: { x: -1, y: -1 } });
  const settle = (index: number) => {
    const h = hover.current;
    clearTimeout(h.timer);
    h.held = -1;
    if (index !== store.at()) {
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
    if (index === null || !store.list()[index]) return;
    if (index === store.at()) {
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
    // The click a long press ends with is the press's: it opened the menu.
    if (performance.now() - pressed.current.fired < 600) {
      pressed.current.fired = 0;
      return;
    }
    const index = indexOf(event);
    const entry = index === null ? undefined : store.list()[index];
    if (index === null || !entry) {
      // A click on the empty space of the list lets the selection go.
      if (!store.s.selecting && (event.target as Element).closest?.(".list")) store.clearPicks();
      return;
    }
    if (store.s.renaming) return;
    // Shift, Ctrl or ⌘, or select mode: the click selects. See pick.ts.
    if (store.pickClick(index, { shift: event.shiftKey, add: event.metaKey || event.ctrlKey })) return;
    if (store.s.picked.sel.size) store.clearPicks();
    // One click moves the cursor. A second opens, and so does the first on a phone, which has no keys to open with.
    // A cursor the pointer put there is not a click yet: the first click on it still only selects, as before.
    const placed = hover.current.byHover === index;
    hover.current.byHover = -1;
    if (entry.dir || phone() || (index === store.at() && !placed)) store.activate(index);
    else store.moveTo(index);
  };
  const onListDoubleClick = (event: MouseEvent) => {
    const index = indexOf(event);
    if (index !== null && !store.s.renaming && !store.s.selecting && !event.shiftKey && !event.metaKey && !event.ctrlKey) store.activate(index);
  };

  /** The menu of a row, of the selection it is part of, or of the folder when it is opened on empty space. */
  const menuAt = (event: MouseEvent | PointerEvent, index: number | null, x: number, y: number) => {
    const { s } = store;
    if (s.status !== "ready") return;
    const entry = index === null ? undefined : store.list()[index];
    let target: MenuTarget;
    if (!entry) {
      if (s.finding) return;
      target = { kind: "folder", path: s.path, name: s.path ? nameOf(s.path) : config.root };
    } else if (!s.finding && s.picked.sel.has(entry.path) && s.picked.sel.size > 1) {
      target = { kind: "entries", entries: store.pickedEntries(), dir: s.path };
    } else {
      // A row outside the selection is the one the menu is about: the cursor goes to it and the selection goes.
      if (!s.selecting) store.clearPicks();
      store.moveTo(index ?? 0);
      target = { kind: "entries", entries: [entry], dir: s.finding ? parentOf(entry.path) : s.path };
    }
    event.preventDefault();
    store.openMenu(target, x, y);
  };
  const onListMenu = (event: MouseEvent) => {
    // Shift and a right click: the browser's own menu, for what it offers on a page.
    if (event.shiftKey || store.s.renaming) return;
    menuAt(event, indexOf(event), event.clientX, event.clientY);
  };

  // A long press on a touch screen opens the menu, as a right click does. A press that moves is a scroll.
  const pressed = useRef({ timer: 0, x: 0, y: 0, fired: 0 });
  const onPressStart = (event: PointerEvent) => {
    if (event.pointerType === "mouse" || store.s.renaming) return;
    const p = pressed.current;
    clearTimeout(p.timer);
    p.fired = 0;
    p.x = event.clientX;
    p.y = event.clientY;
    const index = indexOf(event);
    p.timer = window.setTimeout(() => {
      p.fired = performance.now();
      navigator.vibrate?.(8);
      menuAt(event, index, p.x, p.y);
    }, LONG_PRESS);
  };
  const onPressMove = (event: PointerEvent) => {
    const p = pressed.current;
    if (Math.hypot(event.clientX - p.x, event.clientY - p.y) > 8) clearTimeout(p.timer);
  };
  const onPressEnd = () => clearTimeout(pressed.current.timer);

  // A drag of rows: the selection when the row is part of it, or the row alone.
  const onRowDrag = (event: DragEvent) => {
    const index = indexOf(event);
    const entry = index === null ? undefined : store.s.entries[index];
    if (!entry || !event.dataTransfer || store.s.finding || !(config.edit || config.upload)) return;
    const picked = store.s.picked.sel;
    dragging = picked.has(entry.path) ? store.pickedEntries().map((one) => one.path) : [entry.path];
    event.dataTransfer.setData(ROWS_TYPE, dragging.join("\n"));
    event.dataTransfer.effectAllowed = "copyMove";
  };

  const renderCell = (index: number, cell: Cell) => {
    const match = finding ? s.matches?.list[index] : undefined;
    if (match) return <MatchRow match={match} index={index} cell={cell} on={index === at} key={index} />;
    const entry = s.entries[index];
    if (!entry) return null;
    const on = index === s.cursor;
    const style = { top: `${cell.top}px`, left: `${cell.left}px`, width: `${cell.width}px`, height: `${cell.height}px` };
    // While rows are selected, a selected row is filled and the cursor is its bar alone. See pick.ts.
    const picking = s.picked.sel.size > 0 || s.selecting;
    const chosen = s.picked.sel.has(entry.path);
    const renaming = s.renaming?.path === entry.path;
    const menued = s.menu?.target.kind === "entries" && s.menu.target.entries.length === 1 && s.menu.target.entries[0]?.path === entry.path;
    const marks = `${chosen ? " bg-accent-soft" : ""}${picking && on && !s.selecting ? " shadow-[inset_3px_0_0_var(--accent)]" : ""}${menued ? " outline-[1.5px] outline-accent -outline-offset-[1.5px] rounded" : ""}`;
    return (
      <div
        class={`${ROW} ${ROW_GRID} ${ROW_REST} ${ROW_ON} ${LIST_ROW}${entry.dir && uploads.target === entry.path ? ` ${DROP_ROW}` : ""}${marks}`}
        id={rowId(index)}
        role="option"
        aria-label={rowName(entry)}
        aria-selected={on && !picking}
        data-i={index}
        data-cursor={on ? "" : undefined}
        data-dir={entry.dir ? "" : undefined}
        data-drop={entry.dir ? entry.path : undefined}
        draggable={(config.edit || config.upload) && !renaming ? true : undefined}
        style={style}
        key={index}
      >
        {chosen ? (
          <span class="grid size-4 place-items-center rounded-[4px] bg-accent text-accent-fg">
            <Icon name="check" class="size-3 [stroke-width:2]" />
          </span>
        ) : s.selecting ? (
          <span class="size-4 rounded-[50%] border-[1.5px] border-line-strong" />
        ) : (
          <KindIcon kind={entry.kind} />
        )}
        {renaming ? (
          <RenameField entry={entry} key={entry.path} />
        ) : (
          <span class="min-w-0 truncate">
            <b class={nameWeight(entry.dir)}>{entry.name}</b>
          </span>
        )}
        <span class={SIZE}>{entry.dir ? (entry.count === undefined ? "" : fmt.count(entry.count)) : fmt.size(entry.size)}</span>
        <span class={AGE} title={fmt.abs(entry.mtime)}>
          {fmt.rel(entry.mtime)}
        </span>
      </div>
    );
  };

  const total = s.all.length;
  const info =
    (s.filter ? `${fmt.count(s.entries.length)} of ${fmt.count(total)}` : fmt.items(total)) +
    (s.unlisted ? ` · ${fmt.count(s.unlisted)} hidden` : "") +
    (s.unreadable ? ` · ${fmt.unreadable(s.unreadable)}` : "") +
    // The size is of the files right here; a folder of folders has none to add up.
    `${s.all.some((entry) => !entry.dir) ? ` · ${fmt.size(s.bytes)}` : ""} · by ${SORT_LABEL[s.sort.key].toLowerCase()}`;

  // While rows are selected: how many, and how large the files among them are.
  const selected = s.picked.sel.size > 0 && !finding;
  const chosen = selected ? s.entries.filter((entry) => s.picked.sel.has(entry.path)) : [];
  const pickedInfo = `${fmt.count(chosen.length)} selected${chosen.some((entry) => !entry.dir) ? ` · ${fmt.size(chosen.reduce((sum, entry) => sum + (entry.dir ? 0 : entry.size), 0))}` : ""}`;
  const trashed = s.trash?.items ?? [];
  const trashInfo = `${fmt.items(trashed.length)} · ${fmt.size(trashed.reduce((sum, item) => sum + item.size, 0))} · each kept ${s.trash?.days ?? 30} days`;

  return (
    <>
      <Sprite />
      <header
        class={`flex h-[calc(46px*var(--density))] min-w-0 items-center gap-3.5 border-b border-b-line ${LIST_PAD}`}
        onDragOver={(event) => carriesRows(event) && onDragOver(event)}
        onDrop={(event) => carriesRows(event) && onDrop(event)}
      >
        <a
          class="inline-flex items-center gap-[0.5em] font-display text-[length:calc(var(--text)*1.08)] leading-none font-strong tracking-[-0.02em] text-fg no-underline phone:gap-0 phone:text-[0px]"
          href="/"
          aria-label={`${config.title}, top folder`}
          onClick={inPlace(() => void store.showDir(""))}
        >
          <span class="relative size-[1.05em] flex-none rounded-[min(var(--radius),0.26em)] border-[length:max(1.5px,var(--line-w))] border-current after:absolute after:right-[0.14em] after:bottom-[0.14em] after:size-[0.36em] after:rounded-[min(var(--radius),0.08em)] after:bg-accent after:content-[''] phone:text-[15px]" />
          {config.title}
        </a>
        <TrailButton />
        <Crumbs />
        <div class="flex flex-none items-center gap-1" onMouseDown={(event) => event.preventDefault()}>
          <button class={`btn btn-line w-[210px] justify-start text-faint hover:text-fg phone:w-auto ${TOOL}`} aria-label="Find anything" onClick={() => store.setPalette(true)}>
            <Icon name="search" />
            <span class="flex-1 text-left phone:hidden">Find anything</span>
            <kbd class="phone:hidden">{MOD} K</kbd>
          </button>
          {/* A phone has no folder bar above the list to hold these, and a tap on a folder goes in. */}
          {adds !== null && !s.trashView && (
            <>
              <button class={`btn hidden phone:inline-flex ${TOOL}`} aria-label="Upload files here" onClick={() => pick(adds)}>
                <Icon name="upload" />
              </button>
              <button class={`btn hidden phone:inline-flex ${TOOL}`} aria-label="New file" onClick={() => store.setNaming("file")}>
                <Icon name="plus" />
              </button>
            </>
          )}
          {here && !s.trashView && (
            <button class={`btn hidden phone:inline-flex ${TOOL}`} aria-label={config.trash ? "Move this folder to Trash" : "Delete this folder"} onClick={() => store.askDelete(here)}>
              <Icon name="trash" />
            </button>
          )}
          {s.trash && (
            <button
              class={`btn ${TOOL}`}
              aria-label={`Trash, ${fmt.items(s.trash.items.length)}`}
              aria-pressed={s.trashView}
              title={`Trash: what is deleted stays ${s.trash.days} days`}
              onClick={() => store.showTrash()}
            >
              <Icon name="bin" />
              {s.trash.items.length > 0 && (
                <span
                  class={`num inline-grid h-[1.6em] min-w-[1.6em] place-items-center rounded-[99px] px-[0.35em] text-[length:calc(var(--text)*0.72)] leading-none font-medium tracking-[0] ${s.trashView ? "bg-accent text-accent-fg" : "bg-sunken text-muted shadow-[0_0_0_var(--line-w)_var(--line)]"}`}
                >
                  {fmt.count(s.trash.items.length)}
                </span>
              )}
            </button>
          )}
          <button
            class={`btn ${TOOL}`}
            aria-label="Show hidden files"
            aria-pressed={s.hidden}
            title={s.hidden ? "Hide hidden files (.)" : "Show hidden files (.)"}
            onClick={() => store.setHidden()}
          >
            <Icon name={s.hidden ? "eye" : "eye-off"} />
          </button>
          <button class={`btn ${TOOL}`} aria-label="Theme" onClick={(event) => setMenu(menu ? null : event.currentTarget)}>
            <Icon name="swatch" />
          </button>
        </div>
      </header>
      {config.header && (
        <Prose
          class={`note m-0 max-h-[30vh] max-w-none overflow-auto overscroll-contain border-b border-b-line bg-surface py-[calc(var(--pad)*0.6)] ${LIST_PAD} text-s leading-[1.5] text-muted viewing:hidden`}
          html={config.header}
        />
      )}
      <div
        class="main relative grid min-h-0 grid-cols-[repeat(var(--slots,4),minmax(0,1fr))] overflow-clip viewing:grid-cols-[minmax(0,1fr)] phone:grid-cols-[minmax(0,1fr)]"
        ref={main}
        style={`--slots: ${cut}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {s.trashView ? (
          <>
            <section
              class={`left flex min-h-0 min-w-0 flex-col border-r border-r-line phone:border-r-0 ${cut > 2 ? "col-[span_2]" : "col-span-full"}`}
              data-pane="trash"
              onPointerDown={(event) => {
                const row = (event.target as Element).closest<HTMLElement>("[data-t]");
                const item = row ? s.trash?.items[Number(row.dataset.t)] : undefined;
                if (event.pointerType === "mouse" || !item) return;
                const p = pressed.current;
                clearTimeout(p.timer);
                p.x = event.clientX;
                p.y = event.clientY;
                p.timer = window.setTimeout(() => {
                  store.trashMoveTo(Number(row?.dataset.t));
                  store.openMenu({ kind: "trash", item }, p.x, p.y);
                }, LONG_PRESS);
              }}
              onPointerMove={onPressMove}
              onPointerUp={onPressEnd}
              onPointerCancel={onPressEnd}
            >
              <TrashList
                onMenu={(event, item) => {
                  if (event.shiftKey) return;
                  event.preventDefault();
                  store.openMenu({ kind: "trash", item }, event.clientX, event.clientY);
                }}
              />
            </section>
            {cut > 2 && (
              <section class="right flex min-h-0 min-w-0 col-[3/-1] phone:hidden">
                <TrashItemPane />
              </section>
            )}
          </>
        ) : (
          <>
        <section
          class={`left flex min-h-0 min-w-0 flex-col ghost:pointer-events-none ghost:absolute ghost:z-1 ghost:bg-bg viewing:not-ghost:hidden ${
            // The matches take two slots, or all of them when the window has two. A phone draws each in two lines.
            finding ? `phone:[--row-h:calc(52px*var(--density))] ${wide ? "col-[span_2] border-r border-r-line phone:border-r-0" : "col-span-full"}` : "border-r border-r-line phone:border-r-0"
          }${uploads.target !== null && uploads.target === s.path ? ` ${DROP_PANE}` : ""}`}
          data-pane={s.path}
          onPointerMove={(event) => {
            onListMove(event);
            onPressMove(event);
          }}
          onPointerLeave={onListLeave}
          onPointerDown={onPressStart}
          onPointerUp={onPressEnd}
          onPointerCancel={onPressEnd}
          onClick={onListClick}
          onDblClick={onListDoubleClick}
          onContextMenu={onListMenu}
          onDragStart={onRowDrag}
          onDragEnd={() => {
            dragging = [];
            uploads.aim(null);
          }}
        >
          {finding ? (
            <MatchBar input={queryInput} />
          ) : (
            <FolderBar
              inList
              name={s.path ? nameOf(s.path) : config.root}
              path={s.path}
              count={s.status === "ready" ? s.all.length : undefined}
              mtime={s.status === "ready" ? s.mtime : undefined}
              doomed={here}
              adds={adds !== null}
              missing={s.status === "missing"}
            />
          )}
          {finding ? <MatchColumns /> : <Columns />}
          <VList
            scroller={scroller}
            count={list.length}
            cursor={at}
            caught={s.caught}
            listKey={finding ? `find\n${s.matches?.q}\n${s.matches?.sort.key}${s.matches?.sort.rev}` : `${s.path}\n${s.sort.key}${s.sort.dir}\n${s.filter}`}
            render={renderCell}
            empty={finding ? <MatchesEmpty /> : <Empty />}
            onShown={finding ? (last) => store.more(last) : undefined}
          >
            {!finding && s.readme && !s.filter && (
              <section class="border-t border-t-line [.rows:empty+&]:border-t-0">
                <div class={`label flex h-[calc(30px*var(--density))] items-center gap-2 border-b border-b-line normal-case ${LIST_PAD}`}>
                  <KindIcon kind="md" />
                  {s.readme.name}
                </div>
                <Prose class="m-0 max-w-[46em] px-[calc(var(--pad)*1.25)] pt-[calc(var(--pad)*1.6)] pb-12 text-base" html={s.readme.html} />
              </section>
            )}
          </VList>
        </section>
        {(!finding || wide) && <Side slots={finding ? cut - 1 : cut} matches={finding} />}
          </>
        )}
      </div>
      <footer
        class={`flex h-[calc(28px*var(--density))] min-w-0 items-center gap-3.5 border-t border-t-line ${LIST_PAD} text-xs text-muted phone:h-[calc(44px*var(--density))] phone:pb-[env(safe-area-inset-bottom)] [&_kbd]:h-[1.55em] [&_kbd]:min-w-[1.55em] [&_kbd]:border-b`}
      >
        <span
          class={`inline-flex flex-none items-center font-mono text-[length:calc(var(--text)*0.72)] font-medium tracking-[0] uppercase before:size-1.5 before:rounded-[50%] before:bg-accent before:content-[''] phone:hidden ${
            // Loud while it is not plain browsing: a filled chip, and no dot.
            finding || s.open || s.filter || s.trashView || selected ? "gap-0 rounded-[min(var(--radius),3px)] bg-accent px-1.75 py-px text-accent-fg before:hidden" : "gap-1.5 text-muted"
          }`}
        >
          {s.trashView ? "trash" : finding ? "find" : s.editing ? "edit" : s.open ? "view" : selected ? "select" : s.filter ? "filter" : "browse"}
        </span>
        <span class="num whitespace-nowrap">{s.trashView ? trashInfo : finding ? matchesInfo() : selected ? pickedInfo : s.status === "ready" ? info : ""}</span>
        <label class={`min-w-0 flex-1 items-center gap-1 font-mono tracking-[0] text-fg ${filterShown ? "flex" : "hidden"}`}>
          /
          <input
            class="min-w-0 flex-1 border-0 bg-transparent p-0 text-s pointer-coarse:text-[16px]"
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
        <span class="flex-1" />
        {s.editing ? (
          <span class={`${HINTS} flex`}>
            <span>
              <kbd>{MOD} S</kbd> save
            </span>
            <span>
              <kbd>{MOD} F</kbd> find in the file
            </span>
            <span>
              <kbd>esc</kbd> leave
            </span>
          </span>
        ) : (
          <span class={`${HINTS} ${filterShown || s.trashView || selected ? "hidden" : "flex"}`}>
            <span>
              <kbd>j</kbd>
              <kbd>k</kbd> move
            </span>
            <span>
              <kbd>↵</kbd> open
            </span>
            {!finding && !s.open && (
              <span>
                <kbd>a</kbd> actions
              </span>
            )}
            {!finding && !s.open && store.trail() && (
              <span>
                <kbd>esc</kbd> matches
              </span>
            )}
            {flippable && (
              <span>
                <kbd>r</kbd> {store.isRaw(flippable) ? "rendered" : "source"}
              </span>
            )}
            {wrappable && (
              <span>
                <kbd>w</kbd> {store.wraps(wrappable) ? "unwrap" : "wrap"}
              </span>
            )}
            <span>
              <kbd>/</kbd> {finding ? "refine" : "filter"}
            </span>
            <span>
              <kbd>s</kbd> sort
            </span>
            {finding ? (
              <>
                <span>
                  <kbd>{MOD} K</kbd> palette
                </span>
                <span>
                  <kbd>esc</kbd> back
                </span>
              </>
            ) : (
              <>
                <span>
                  <kbd>.</kbd> {s.hidden ? "hide hidden" : "show hidden"}
                </span>
                <span>
                  <kbd>?</kbd> keys
                </span>
              </>
            )}
          </span>
        )}
        {s.trashView && (
          <span class={`${HINTS} flex`}>
            <span>
              <kbd>a</kbd> actions
            </span>
            {s.trash?.items.length ? (
              <>
                <span>
                  <kbd>⇧</kbd>
                  <kbd>R</kbd> put back
                </span>
                <span>
                  <kbd>⇧</kbd>
                  <kbd>⌫</kbd> delete forever
                </span>
              </>
            ) : null}
            <span>
              <kbd>esc</kbd> back
            </span>
          </span>
        )}
        {selected && !s.trashView && !s.editing && (
          <span class={`${HINTS} flex`}>
            <span>
              <kbd>a</kbd> actions
            </span>
            <span>
              <kbd>space</kbd> select
            </span>
            {config.edit && (
              <span>
                <kbd>m</kbd> move
              </span>
            )}
            {config.upload && (
              <span>
                <kbd>c</kbd> copy
              </span>
            )}
            {config.delete && (
              <span>
                <kbd>⇧</kbd>
                <kbd>D</kbd> {s.trash ? "trash" : "delete"}
              </span>
            )}
            <span>
              <kbd>esc</kbd> clear
            </span>
          </span>
        )}
        {s.selecting && (
          // A phone's select mode: what to do with the ticked rows, in reach of a thumb.
          <span class="flex items-center gap-1 [&_.btn]:h-auto [&_.btn]:flex-col [&_.btn]:gap-0.5 [&_.btn]:px-2 [&_.btn]:py-1 [&_.btn]:text-xs [&_.ic]:size-4.5 [&_.ic]:text-fg">
            {config.edit && (
              <button class="btn" disabled={!s.picked.sel.size} onClick={() => store.startPicking("move")}>
                <Icon name="move" />
                Move
              </button>
            )}
            {config.upload && (
              <button class="btn" disabled={!s.picked.sel.size} onClick={() => store.startPicking("copy")}>
                <Icon name="copy" />
                Copy
              </button>
            )}
            {config.delete && (
              <button class="btn" disabled={!s.picked.sel.size} onClick={() => store.askDelete(store.pickedEntries()[0] ?? null)}>
                <Icon name="trash" />
                {s.trash ? "Trash" : "Delete"}
              </button>
            )}
            <button class="btn" onClick={() => store.clearPicks()}>
              <Icon name="close" />
              Done
            </button>
          </span>
        )}
        <button class={`btn hidden phone:h-8 ${s.selecting || s.trashView ? "" : "phone:inline-flex"}`} onClick={focusFilter}>
          <Icon name="search" />
          {finding ? "Refine" : "Filter"}
        </button>
      </footer>
      <Notice />
      {s.palette && <Palette />}
      {s.help && <Help />}
      {s.doomed && <ConfirmDelete key={s.doomed.path} doomed={s.doomed} />}
      <Tray />
      {uploads.asking && <ClashDialog />}
      {s.naming && <NameDialog kind={s.naming.kind} dir={s.naming.dir} />}
      {s.leaving && <ConfirmLeave />}
      {menu && <ThemeMenu anchor={menu} onClose={closeMenu} />}
      {s.menu && <ContextMenu />}
      {s.picking && <Picker key={s.picking.paths.join("\n")} />}
      {s.forgetting && <ConfirmForget />}
      <Toast />
    </>
  );
}
