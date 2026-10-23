// The theme switcher, the list of keys and the delete dialog.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { DeleteError } from "./api";
import { config } from "./config";
import * as fmt from "./fmt";
import { KindIcon } from "./icons";
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
    if (above) el.style.bottom = `${innerHeight - box.top + 8}px`;
    else el.style.top = `${box.bottom + 8}px`;
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

  const dark = isDark();
  const then = (change: () => void) => () => {
    change();
    redraw((n) => n + 1);
  };
  return (
    // It grows out of the button that opened it, which sets its origin. It is opened by a click, now and then.
    <div class={`fixed z-60 w-[248px] rounded-lg bg-surface p-1.5 shadow ${POP_IN}`} role="dialog" aria-label="Theme" ref={pop}>
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
  ...(store.flippable() ? [[["r"], "Rendered or source"] satisfies Key] : []),
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
  ...(config.edit ? [[["e"], "Edit the text file"] satisfies Key] : []),
  ...(store.addsTo() !== null
    ? [[["u"], "Upload files into this folder"] satisfies Key, [["n"], "New file in this folder"] satisfies Key]
    : []),
  ...(config.delete ? [[[DELETE_KEY], "Delete the file or folder"] satisfies Key] : []),
  [["?"], "This list"],
];

export function Help() {
  return (
    <div class={SCRIM} onPointerDown={(event) => event.target === event.currentTarget && store.setHelp(false)}>
      <div class={`${DIALOG} px-5 py-4.5`} role="dialog" aria-label="Keyboard shortcuts">
        <h2 class={`mt-0 mb-2.5 ${DIALOG_HEAD}`}>Keyboard</h2>
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
  const noun = doomed.link ? "link" : doomed.dir ? "folder" : "file";
  let what = "This file will be removed.";
  if (doomed.link) {
    what = `This is a link to a ${doomed.dir ? "folder" : "file"}. Only the link will be removed: what it points at stays as it is.`;
  } else if (doomed.dir) {
    // Hidden entries go with it whether or not they are shown, so they are counted.
    const hidden = doomed.unlisted ? `, and ${fmt.count(doomed.unlisted)} hidden` : "";
    if (doomed.count === undefined) what = "This folder will be removed with everything in it.";
    else if (doomed.count === 0 && !hidden) what = "This empty folder will be removed.";
    else what = `This folder holds ${fmt.items(doomed.count)}${hidden}. It will be removed with everything in it.`;
  }
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
          Delete this {noun}?
        </h2>
        <div class="flex max-h-[8.5em] gap-2.25 overflow-auto overscroll-contain rounded bg-sunken px-2.75 py-2.25 text-s wrap-anywhere">
          <KindIcon kind={doomed.kind} class="mt-[0.14em]" />
          <span class="num">/{doomed.path}</span>
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
