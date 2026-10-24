// The menu a right click, a long press or `a` opens on a row, on the selection, on the empty space of a list or on a
// row of the Trash, with what can be done there. A phone has it as a sheet from the foot of the screen. And the
// toast that says what was just done, with Undo.

import { Fragment } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { nameOf, urls } from "./api";
import { copyText } from "./clip";
import { config } from "./config";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { kindOf } from "./kinds";
import { POP_IN } from "./look";
import { DELETE_KEY, MOD } from "./palette";
import { type Entry, type MenuTarget, SORT_KEYS, SORT_LABEL, store } from "./store";
import { pick } from "./upload";

/** The flag an action needs, and what is off without it. */
type Need = "edit" | "upload" | "delete";
const FLAG: Record<Need, string> = { edit: "--allow-edit", upload: "--allow-upload", delete: "--allow-delete" };
const OFF: Record<Need, string> = { edit: "rename and move", upload: "add and copy", delete: "delete" };

interface Action {
  label: string;
  icon: string;
  key?: string;
  /** It deletes: set apart at the foot, in the accent color. */
  danger?: boolean;
  need?: Need;
  run?: () => void;
  /** A list that opens beside it, in place of running. */
  sub?: Action[];
  /** Ticked, in a list of choices. */
  on?: boolean;
}

/** The width a phone and smaller have: the menu is a sheet there. */
const PHONE = 760;
const phone = (): boolean => innerWidth <= PHONE;

const can = (need: Need | undefined): boolean => !need || config[need] === true;

/** Saves what is at an address, as a link with `download` does. */
function download(href: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await copyText(text);
    store.say(`Copied ${what}`);
  } catch {
    store.say("The browser would not copy");
  }
}

/** What the menu offers on its target, in groups: open, change, share, and the delete apart at the foot. */
function groupsOf(target: MenuTarget): Action[][] {
  const { s } = store;
  const small = phone();
  if (target.kind === "trash") {
    const { item } = target;
    return [
      [
        { label: "Put back", icon: "restore", key: "⇧ R", need: "delete", run: () => void store.restore(item) },
        { label: "Delete forever…", icon: "trash", key: "⇧ ⌫", need: "delete", danger: true, run: () => store.askForget(item) },
      ],
      [{ label: "Copy where it was", icon: "path", run: () => void copy(`/${item.path}`, `/${item.path}`) }],
    ];
  }
  if (target.kind === "folder") {
    const adds = store.addsTo() !== null;
    const trash = s.trash;
    return [
      adds
        ? [
            { label: "New file", icon: "plus", key: "n", need: "upload", run: () => void store.newHere("file") },
            { label: "New folder", icon: "folder-plus", key: "N", need: "upload", run: () => void store.newHere("folder") },
            { label: "Upload files…", icon: "upload", key: "u", need: "upload", run: () => pick(target.path) },
          ]
        : [],
      [
        ...(small ? [] : [{ label: "Select all", icon: "select", key: `${MOD} A`, run: () => store.selectAll() }]),
        {
          label: "Sort by",
          icon: "sort",
          sub: SORT_KEYS.map((key) => ({ label: SORT_LABEL[key], icon: "blank", on: s.sort.key === key, run: () => store.setSort(key) })),
        },
        { label: s.hidden ? "Hide hidden files" : "Show hidden files", icon: s.hidden ? "eye-off" : "eye", key: ".", run: () => store.setHidden() },
      ],
      [
        { label: "Download as zip", icon: "download", run: () => download(urls.zip(target.path)) },
        { label: "Copy link", icon: "link", run: () => void store.copyLink({ path: target.path, dir: true, name: target.name } as Entry) },
      ],
      trash ? [{ label: `Open Trash${trash.items.length ? ` (${fmt.count(trash.items.length)})` : ""}`, icon: "bin", need: "delete", run: () => store.showTrash(true) }] : [],
    ];
  }
  const { entries } = target;
  const trashing = s.trash ? "Move to Trash" : "Delete…";
  if (entries.length > 1) {
    const n = `${fmt.count(entries.length)} items`;
    return [
      [
        { label: `Move ${n} to…`, icon: "move", key: "m", need: "edit", run: () => store.startPicking("move", entries, target.dir) },
        { label: `Copy ${n} to…`, icon: "copy", key: "c", need: "upload", run: () => store.startPicking("copy", entries, target.dir) },
      ],
      [{ label: "Copy paths", icon: "path", key: "Y", run: () => void copy(entries.map((entry) => `/${entry.path}`).join("\n"), `${n}' paths`) }],
      [{ label: s.trash ? `Move ${n} to Trash` : `Delete ${n}…`, icon: "trash", key: DELETE_KEY, need: "delete", danger: true, run: () => store.askDelete(entries[0] ?? null) }],
      [{ label: "Clear selection", icon: "close", key: "esc", run: () => store.clearPicks() }],
    ];
  }
  const entry = entries[0];
  if (!entry) return [];
  const opening: Action[] = small
    ? []
    : [
        {
          label: "Open",
          icon: "open",
          key: "↵",
          run: () => {
            const at = s.finding ? -1 : s.entries.indexOf(entry);
            if (at >= 0) store.activate(at);
            else void store.go(entry.path, entry.dir);
          },
        },
        { label: "Open in a new tab", icon: "newtab", run: () => window.open(store.linkTo(entry) ?? "", "_blank", "noopener") },
        ...(store.editable(entry) ? [{ label: "Edit", icon: "pen", key: "e", run: () => store.edit(entry) }] : []),
      ];
  const sharing: Action[] = [
    entry.dir
      ? { label: "Download as zip", icon: "download", run: () => download(urls.zip(entry.path)) }
      : { label: "Download", icon: "download", run: () => download(urls.raw(entry.path)) },
    { label: "Copy link", icon: "link", key: "y", run: () => void store.copyLink(entry) },
    ...(small ? [] : [{ label: "Copy path", icon: "path", key: "Y", run: () => void copy(`/${entry.path}`, `/${entry.path}`) }]),
  ];
  // A match is changed from its own folder, where the list shows what is left: over the matches, the menu only reads.
  if (s.finding) return [opening, sharing];
  return [
    opening,
    [
      { label: "Rename", icon: "rename", key: "F2", need: "edit", run: () => store.startRename(entry) },
      { label: "Move to…", icon: "move", key: "m", need: "edit", run: () => store.startPicking("move", [entry], target.dir) },
      { label: "Copy to…", icon: "copy", key: "c", need: "upload", run: () => store.startPicking("copy", [entry], target.dir) },
      { label: "Duplicate", icon: "dup", need: "upload", run: () => void store.duplicate(entry) },
    ],
    sharing,
    small ? [{ label: "Select", icon: "select", run: () => store.startSelecting([entry]) }] : [],
    [{ label: trashing, icon: "trash", key: DELETE_KEY, need: "delete", danger: true, run: () => store.askDelete(entry) }],
  ];
}

/** The groups with what the server does not allow left out, and what was left out, for a line at the foot. */
function shown(target: MenuTarget): { groups: Action[][]; off: Need[] } {
  const off = new Set<Need>();
  const groups = groupsOf(target)
    .map((group) =>
      group.filter((action) => {
        if (can(action.need)) return true;
        if (action.need) off.add(action.need);
        return false;
      }),
    )
    .filter((group) => group.length);
  return { groups, off: [...off] };
}

/** What a menu is about, at the top of a sheet: the entry, the selection or the folder. */
function Head({ target }: { target: MenuTarget }) {
  if (target.kind === "trash") {
    const days = Math.max(0, Math.ceil((target.item.gone - Date.now() / 1000) / 86400));
    return (
      <>
        <KindIcon kind={kindOf(nameOf(target.item.path), target.item.dir)} />
        <div class="grid min-w-0">
          <b class="truncate font-strong">{nameOf(target.item.path)}</b>
          <span class="num truncate text-xs text-muted">{fmt.items(days).replace("item", "day")} left in the Trash</span>
        </div>
      </>
    );
  }
  if (target.kind === "folder") {
    return (
      <>
        <KindIcon kind="folder" />
        <div class="grid min-w-0">
          <b class="truncate font-strong">{target.name}</b>
          <span class="num text-xs text-muted">this folder</span>
        </div>
      </>
    );
  }
  const [only] = target.entries;
  if (target.entries.length > 1 || !only) {
    return (
      <>
        <Icon name="select" />
        <b class="font-strong">{fmt.items(target.entries.length)} selected</b>
      </>
    );
  }
  return (
    <>
      <KindIcon kind={only.kind} />
      <div class="grid min-w-0">
        <b class="truncate font-strong">{only.name}</b>
        <span class="num text-xs text-muted">
          {only.dir ? (only.count === undefined ? "folder" : fmt.items(only.count)) : fmt.size(only.size)} · {fmt.rel(only.mtime)}
        </span>
      </div>
    </>
  );
}

const ITEM =
  "flex h-[calc(28px*var(--density))] w-full items-center gap-2.25 rounded px-2 text-left text-s whitespace-nowrap aria-selected:bg-accent-soft [&_kbd]:h-[1.55em] [&_kbd]:min-w-[1.55em] [&_kbd]:bg-transparent phone:h-11 phone:gap-3 phone:text-base phone:[&_kbd]:hidden";
const WIDTH = 248;

export function ContextMenu() {
  const menu = store.s.menu;
  const pop = useRef<HTMLDivElement>(null);
  const [hi, setHi] = useState(-1);
  const [sub, setSub] = useState<number | null>(null);
  const sheet = phone();
  const { groups, off } = menu ? shown(menu.target) : { groups: [], off: [] };
  const flat = groups.flat();

  // Opened from the keys, the first action starts highlighted; opened by the pointer, none is.
  useEffect(() => {
    setHi(menu?.keys ? 0 : -1);
    setSub(null);
  }, [menu]);

  useLayoutEffect(() => {
    const el = pop.current;
    if (!el || !menu || sheet) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    // Flipped to the other side of the pointer where it would leave the window.
    const left = menu.x + width + 8 > innerWidth ? Math.max(8, menu.x - width) : menu.x;
    const top = menu.y + height + 8 > innerHeight ? Math.max(8, menu.y - height >= 8 ? menu.y - height : innerHeight - height - 8) : menu.y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.transformOrigin = `${left < menu.x ? "100%" : "0"} ${top < menu.y ? "100%" : "0"}`;
  }, [menu, sheet]);

  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!pop.current?.contains(event.target as Node)) store.closeMenu();
    };
    const run = (action: Action | undefined, at: number) => {
      if (!action) return;
      if (action.sub) return setSub(sub === at ? null : at);
      store.closeMenu();
      action.run?.();
    };
    const onKey = (event: KeyboardEvent) => {
      const step = (by: number) => setHi((at) => (at + by + flat.length) % Math.max(1, flat.length));
      if (event.key === "Escape") store.closeMenu();
      else if (event.key === "ArrowDown") step(1);
      else if (event.key === "ArrowUp") step(-1);
      else if (event.key === "ArrowRight" && flat[hi]?.sub) setSub(hi);
      else if (event.key === "ArrowLeft") setSub(null);
      else if (event.key === "Enter" || event.key === " ") run(flat[hi], hi);
      else if (event.key === "Tab") store.closeMenu();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    const close = () => store.closeMenu();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
    addEventListener("resize", close);
    addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", onKey, true);
      removeEventListener("resize", close);
      removeEventListener("blur", close);
    };
  }, [menu, hi, sub, flat]);

  if (!menu) return null;
  let at = 0;
  const row = (action: Action) => {
    const index = at++;
    return (
      <div class="relative" key={index}>
        <button
          class={`${ITEM} ${action.danger ? "text-accent [&_.ic]:text-accent" : "text-fg [&_.ic]:text-muted"}`}
          role="menuitem"
          aria-selected={index === hi}
          aria-haspopup={action.sub ? "menu" : undefined}
          aria-expanded={action.sub ? sub === index : undefined}
          onPointerEnter={() => setHi(index)}
          onClick={() => {
            if (action.sub) return setSub(sub === index ? null : index);
            store.closeMenu();
            action.run?.();
          }}
        >
          <Icon name={action.on ? "check" : action.icon} />
          <span class="min-w-0 flex-1 truncate">{action.label}</span>
          {action.sub ? <Icon name="right" class="text-faint" /> : action.key ? <kbd>{action.key}</kbd> : null}
        </button>
        {action.sub && sub === index && (
          <div
            class={`absolute top-[-5px] left-[calc(100%+4px)] z-1 w-[170px] rounded-lg bg-surface p-1.25 shadow ${POP_IN} phone:static phone:w-auto phone:p-0 phone:pl-6 phone:shadow-none`}
            role="menu"
          >
            {action.sub.map((choice) => (
              <button
                class={`${ITEM} text-fg`}
                role="menuitemradio"
                aria-checked={choice.on === true}
                onClick={() => {
                  store.closeMenu();
                  choice.run?.();
                }}
                key={choice.label}
              >
                <Icon name={choice.on ? "check" : "blank"} class="text-muted" />
                <span class="flex-1">{choice.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };
  const foot = off.length ? (
    <div class="mx-0.5 mt-1 border-t border-t-line px-1.5 pt-1.75 pb-0.75 text-xs leading-[1.4] whitespace-normal text-faint">
      Off on this server:{" "}
      {off.map((need, i) => (
        <Fragment key={need}>
          {i > 0 && ", "}
          {OFF[need]} (<code class="font-mono">{FLAG[need]}</code>)
        </Fragment>
      ))}
      .
    </div>
  ) : null;
  const body = groups.map((group, i) => (
    <Fragment key={i}>
      {i > 0 && <div class="mx-0.5 my-1 h-(--line-w) bg-line" />}
      {group.map(row)}
    </Fragment>
  ));
  if (sheet) {
    return (
      <div class="fixed inset-0 z-60" onContextMenu={(event) => event.preventDefault()}>
        <div class="absolute inset-0 bg-scrim transition-opacity duration-150 starting:opacity-0" />
        <div
          ref={pop}
          class="absolute right-0 bottom-0 left-0 max-h-[82vh] overflow-auto overscroll-contain rounded-t-[14px] bg-surface px-2 pt-1.5 pb-[calc(10px+env(safe-area-inset-bottom))] shadow transition-transform duration-260 ease-out starting:translate-y-full motion-reduce:transition-none"
          role="menu"
        >
          <div class="mx-auto mt-0.5 mb-2 h-1 w-9 rounded-[99px] bg-line-strong" />
          <div class="mb-1 flex items-center gap-2.5 border-b border-b-line px-2 pt-1 pb-2.5">
            <Head target={menu.target} />
          </div>
          {body}
          {foot}
        </div>
      </div>
    );
  }
  return (
    <div ref={pop} class={`fixed z-60 rounded-lg bg-surface p-1.25 shadow ${POP_IN}`} style={{ width: `${WIDTH}px` }} role="menu" onContextMenu={(event) => event.preventDefault()}>
      {menu.target.kind !== "entries" || menu.target.entries.length > 1 ? (
        <div class="label truncate px-2 pt-1.5 pb-1">
          {menu.target.kind === "trash"
            ? nameOf(menu.target.item.path)
            : menu.target.kind === "folder"
              ? menu.target.name
              : `${fmt.items(menu.target.entries.length)} selected`}
        </div>
      ) : null}
      {body}
      {foot}
    </div>
  );
}

/** The toast: what was just done, with Undo and its key while it can be undone. It stays while the pointer is on it. */
export function Toast() {
  const toast = store.s.toast;
  if (!toast) return null;
  return (
    <div
      class="fixed bottom-[calc(28px*var(--density)+12px)] left-1/2 z-45 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-2.5 overflow-hidden rounded border border-line bg-surface py-1.5 pr-1.5 pl-3 text-s whitespace-nowrap text-fg shadow transition-[opacity,translate] duration-180 ease-out starting:translate-y-1.5 starting:opacity-0 motion-reduce:transition-none phone:bottom-[calc(44px*var(--density)+env(safe-area-inset-bottom)+12px)]"
      role="status"
      key={toast.id}
      onPointerEnter={() => store.holdToast(true)}
      onPointerLeave={() => store.holdToast(false)}
    >
      <span class="min-w-0 truncate">{toast.text}</span>
      {toast.undo && (
        <>
          <button class="btn h-[calc(24px*var(--density))] font-strong text-accent hover:text-accent" onClick={() => store.undo()}>
            Undo
          </button>
          <kbd class="phone:hidden">{MOD} Z</kbd>
        </>
      )}
      <button class="btn h-[calc(24px*var(--density))] px-1.5" aria-label="Dismiss" onClick={() => store.dropToast()}>
        <Icon name="close" />
      </button>
    </div>
  );
}
