// The theme switcher, the list of keys and the delete dialog.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { DeleteError } from "./api";
import { config } from "./config";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { ASK, ASK_BTN, ASK_DO, ASK_IN, DIALOG, DIALOG_HEAD, MENU_ROW, POP_IN, SCRIM } from "./look";
import { DELETE_KEY, MOD } from "./palette";
import { type Doomed, store } from "./store";
import { type Scheme, active, isDark, setScheme, setTheme } from "./theme";

const SCHEMES: Scheme[] = ["light", "dark", "auto"];
const WIDTH = 248;

/** A popover under (or over) the button that opened it. */
export function ThemeMenu({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const pop = useRef<HTMLDivElement>(null);
  const [, redraw] = useState(0);

  useLayoutEffect(() => {
    const el = pop.current;
    if (!el) return;
    const box = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(box.right - WIDTH, innerWidth - WIDTH - 8));
    const above = box.top > innerHeight / 2;
    el.style.left = `${left}px`;
    // It ends 8px short of the window's edge and scrolls, so a short window still reaches every theme.
    if (above) {
      el.style.bottom = `${innerHeight - box.top + 8}px`;
      el.style.maxHeight = `${box.top - 16}px`;
    } else {
      el.style.top = `${box.bottom + 8}px`;
      el.style.maxHeight = `calc(100dvh - ${box.bottom + 16}px)`;
    }
    // It grows out of the button: from the button's middle, at the edge nearest it.
    el.style.transformOrigin = `${box.left + box.width / 2 - left}px ${above ? "100%" : "0"}`;
  }, [anchor]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!pop.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [anchor, onClose]);

  // The panel takes the focus when it opens and gives it back to its button when it closes. Opened with a key, the
  // focus is on the scheme in use. Opened with a pointer, it is on the panel itself, which shows no ring.
  // A click on another control closes the panel too: then the focus stays where the click put it.
  useEffect(() => {
    const el = pop.current;
    ((anchor.matches(":focus-visible") && el?.querySelector<HTMLElement>('[aria-pressed="true"]')) || el)?.focus();
    return () => {
      const at = document.activeElement;
      if (!at || at === document.body || el?.contains(at)) anchor.focus();
    };
  }, [anchor]);

  // The keys are the panel's while it is up: none reaches the list behind it, and Tab stays inside.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.stopPropagation();
    const { key } = event;
    const stops = [...(pop.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const tab = key === "Tab" ? (event.shiftKey ? -1 : 1) : 0;
    const by = tab || { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[key];
    let to: HTMLElement | undefined;
    if (key === "Escape") onClose();
    else if (key === "Home") to = stops[0];
    else if (key === "End") to = stops.at(-1);
    else if (by !== undefined) to = stops[at < 0 ? (by > 0 ? 0 : stops.length - 1) : (at + by + stops.length) % stops.length];
    else return;
    event.preventDefault();
    to?.focus();
  };

  const dark = isDark();
  const then = (change: () => void) => () => {
    change();
    redraw((n) => n + 1);
  };
  return (
    // It grows out of the button that opened it, which sets its origin. It is opened by a click, now and then.
    <div class={`fixed z-60 w-[248px] overflow-y-auto overscroll-contain rounded-lg bg-surface p-1.5 shadow outline-none ${POP_IN}`} role="dialog" aria-modal="true" aria-label="Theme" tabIndex={-1} onKeyDown={onKeyDown} ref={pop}>
      <div class="mb-1.5 grid auto-cols-[1fr] grid-flow-col gap-0.5 rounded bg-sunken p-0.5">
        {SCHEMES.map((scheme) => (
          <button
            class="h-[calc(26px*var(--density))] rounded-[max(0px,calc(var(--radius)-2px))] text-s text-muted transition-[transform] duration-160 ease-out active:[transform:scale(0.97)] aria-pressed:bg-surface aria-pressed:text-fg aria-pressed:shadow-[0_0_0_var(--line-w)_var(--line)]"
            aria-pressed={active.scheme === scheme}
            onClick={then(() => setScheme(scheme))}
          >
            {scheme[0]?.toUpperCase() + scheme.slice(1)}
          </button>
        ))}
      </div>
      {config.themes.map((theme) => (
        <button class={MENU_ROW} aria-pressed={active.theme === theme.id} onClick={then(() => setTheme(theme.id))}>
          <span class="inline-flex flex-none overflow-hidden rounded-[99px] shadow-[0_0_0_1px_var(--line-strong)] *:h-4 *:w-2.5">
            {(dark ? theme.dark : theme.light).map((color) => (
              <i style={{ background: color }} />
            ))}
          </span>
          <span class="flex-1">{theme.name}</span>
        </button>
      ))}
      <div class="mt-1 border-t border-t-line px-2 pt-2 pb-1 text-xs leading-[1.4] text-faint">A theme is one file that sets tokens. Layout never changes.</div>
    </div>
  );
}


type Key = [string[], string];

/** The keys as they work now: the one that flips a file to its source is listed only on a file that has one. */
const keys = (): Key[] => [
  [["j", "k"], "Move down and up (arrows work too)"],
  [["↵"], "Open the folder, or the file at full width"],
  [["a"], "The menu of the row or the selection (also Shift F10)"],
  [["space"], "Select or unselect the row"],
  [["⇧", "↑ ↓"], "Select from the anchor, as Shift and a click do"],
  [[`${MOD} A`], "Select every row of the folder"],
  ...(store.flippable() ? [[["r"], "The code, or what is made from it"] satisfies Key] : []),
  ...(store.s.open && !store.s.editing ? [[["f"], "Only the open file, or okfs around it again"] satisfies Key] : []),
  ...(store.wrappable() ? [[["w"], "Wrap long lines or not"] satisfies Key] : []),
  [["⌫", "-"], "Up one folder"],
  [["h", "←"], "Out of the folder, or from a file back to its list"],
  [["l", "→"], "Into the folder, or the file at full width"],
  [["home", "end"], "First and last in the folder"],
  [["pgup", "pgdn"], "Up and down one page"],
  [["/"], "Filter this folder"],
  [[`${MOD} K`], "Find anything in the tree"],
  [["s"], "Change the sort"],
  [["y"], "Copy a link to the file or folder"],
  [["t"], "Light or dark"],
  [["."], store.s.hidden ? "Hide hidden files" : "Show hidden files"],
  [["esc"], store.trail() ? "Back to the matches" : "Close the file or the filter"],
  [["Y"], "Copy the path"],
  ...(config.edit ? [[["e"], "Edit the text file"] satisfies Key] : []),
  ...(config.edit ? [[["F2", "R"], "Rename in place"] satisfies Key, [["m"], "Move to…"] satisfies Key] : []),
  ...(config.upload ? [[["c"], "Copy to…"] satisfies Key] : []),
  ...(store.addsTo() !== null
    ? [
        [["u"], "Upload files into this folder"] satisfies Key,
        [["n"], "New file in this folder"] satisfies Key,
        [["N"], "New folder in this folder"] satisfies Key,
      ]
    : []),
  ...(config.delete ? [[[DELETE_KEY, "del", ...(MOD === "⌘" ? ["⌘ ⌫"] : [])], config.trash ? "Move to the Trash" : "Delete the file or folder"] satisfies Key] : []),
  ...(config.trash ? [[[`${MOD} Z`], "Undo the last change while its note is up"] satisfies Key] : []),
  [["?"], "This list"],
];

export function Help() {
  const card = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  // The list takes the focus, so the arrows, the page keys and Space scroll it when the window is too short for it.
  // The focus goes back to where it was when the list closes.
  useEffect(() => {
    const before = document.activeElement;
    card.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  // Tab goes between the list and its close button and never walks the page behind it.
  // On the document, as in the delete dialog, so it holds wherever the focus is.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      event.preventDefault();
      (document.activeElement === close.current ? card.current : close.current)?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div class={SCRIM} onPointerDown={(event) => event.target === event.currentTarget && store.setHelp(false)}>
      <div class={`${DIALOG} px-5 py-4.5 outline-none`} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex={-1} ref={card}>
        <div class="mb-2.5 flex items-center justify-between gap-3">
          <h2 class={`m-0 ${DIALOG_HEAD}`}>Keyboard</h2>
          <button class="btn -my-1 -mr-2 px-1.5" aria-label="Close" title="Close (esc)" ref={close} onClick={() => store.setHelp(false)}>
            <Icon name="close" />
          </button>
        </div>
        <dl class="m-0 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.75">
          {keys().map(([caps, what]) => (
            <>
              <dt class="flex gap-1">
                {caps.map((key) => (
                  <kbd>{key}</kbd>
                ))}
              </dt>
              <dd class="m-0 text-muted">{what}</dd>
            </>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** Asks before a delete. It names what goes, and Enter does not confirm: the focus starts on Cancel. */
export function ConfirmDelete({ doomed }: { doomed: Doomed }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  // At the start, and again after a failure: Enter on a dialog just put up never deletes.
  useEffect(() => {
    if (!busy) cancel.current?.focus();
  }, [busy]);

  const close = () => {
    if (!busy) store.cancelDelete();
  };
  // On the document, so the keys still work after a click on the dialog's text took the focus away.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!busy) store.cancelDelete();
      } else if (event.key === "Tab") {
        // Two buttons and nothing else: the focus goes back and forth and never leaves the dialog.
        (document.activeElement === cancel.current ? confirm : cancel).current?.focus();
      } else {
        return;
      }
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy]);
  const run = () => {
    setBusy(true);
    setFailure("");
    store.remove(doomed).catch((error: unknown) => {
      const stopped = error instanceof DeleteError && error.partial ? "Stopped part way" : "Not deleted";
      setBusy(false);
      setFailure(`${stopped}: ${error instanceof Error ? error.message : String(error)}.`);
    });
  };
  // The selected entries are asked about together: each is named, and the button says how many go.
  const all = doomed.all ?? [doomed];
  const many = all.length > 1;
  const noun = many ? fmt.items(all.length) : doomed.link ? "link" : doomed.dir ? "folder" : "file";
  let what = "This file will be removed.";
  if (many) {
    what = `These ${noun} will be removed${all.some((one) => one.dir && !one.link) ? ", each folder with everything in it" : ""}.`;
  } else if (doomed.link) {
    what = `This is a link to a ${doomed.dir ? "folder" : "file"}. Only the link will be removed: what it points at stays as it is.`;
  } else if (doomed.dir) {
    // Hidden entries go with it whether or not they are shown, so they are counted.
    const hidden = doomed.unlisted ? `, and ${fmt.count(doomed.unlisted)} hidden` : "";
    if (doomed.count === undefined) what = "This folder will be removed with everything in it.";
    else if (doomed.count === 0 && !hidden) what = "This empty folder will be removed.";
    else what = `This folder holds ${fmt.items(doomed.count)}${hidden}. It will be removed with everything in it.`;
  }
  // With a Trash, this dialog only comes up for what cannot go there.
  if (config.trash && doomed.forever) what = `This is on another disk than the Trash, so it cannot go there. ${what}`;
  return (
    // The delete dialog is rare and asks for a decision: it comes up over a fading backdrop rather than appearing.
    <div class={ASK_IN} onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <div
        class={ASK}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ask-title"
        aria-describedby="ask-what"
      >
        <h2 id="ask-title" class={`m-0 ${DIALOG_HEAD}`}>
          {`Delete ${many ? "these" : "this"} ${noun}${config.trash ? " for good" : ""}?`}
        </h2>
        <div class="grid max-h-[8.5em] gap-1 overflow-auto overscroll-contain rounded bg-sunken px-2.75 py-2.25 text-s wrap-anywhere">
          {all.map((one) => (
            <div key={one.path} class="flex gap-2.25">
              <KindIcon kind={one.kind} class="mt-[0.14em]" />
              <span class="num">/{one.path}</span>
            </div>
          ))}
        </div>
        <p id="ask-what" class="m-0 text-muted">
          {what} <b class="font-strong text-fg">There is no undo.</b>
        </p>
        {failure && (
          <p class="m-0 font-strong text-fg" role="alert">
            {failure}
          </p>
        )}
        <div class={ASK_DO}>
          <button class={`btn btn-line ${ASK_BTN}`} ref={cancel} disabled={busy} onClick={close}>
            Cancel
          </button>
          <button class={`btn btn-fill ${ASK_BTN}`} ref={confirm} disabled={busy} onClick={run}>
            {busy ? "Deleting" : `Delete ${noun}`}
          </button>
        </div>
      </div>
    </div>
  );
}
