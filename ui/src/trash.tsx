// The Trash: what a delete moved aside, the last first, with where each came from and how long it has left. In place
// of the folder's list, with the entry under the cursor beside it: where it goes back to, when it goes for good, and
// the two things to do with it. And the dialog that asks before anything leaves it for good.

import { useEffect, useRef, useState } from "preact/hooks";
import { type TrashItem, nameOf, parentOf } from "./api";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { kindOf } from "./kinds";
import { ASK, ASK_BTN, ASK_DO, ASK_IN, BAR, BAR_FACTS, BAR_NAME, DIALOG_HEAD, EMPTY, EMPTY_HEAD, EMPTY_HINT, LIST_PAD } from "./look";
import { store } from "./store";

const DAY = 24 * 60 * 60;

/** Whole days until `gone`, from now: 1 on its last day. */
export const daysLeft = (gone: number): number => Math.max(0, Math.ceil((gone - Date.now() / 1000) / DAY));

/** A day as a date, without the time: `21 Nov`. */
const day = (seconds: number): string => new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** The Trash's rows and heads: icon, name, the folder it was in, when it was deleted, and the days it has left. */
export const TRASH_GRID = `grid items-center gap-2.5 ${LIST_PAD} grid-cols-[16px_minmax(0,1fr)_minmax(0,0.9fr)_64px_52px] phone:grid-cols-[16px_minmax(0,1fr)_minmax(0,0.7fr)_44px]`;

const kindOfItem = (item: TrashItem) => kindOf(nameOf(item.path), item.dir);

/** The Trash's list, in place of the folder's. */
export function TrashList({ onMenu }: { onMenu: (event: MouseEvent, item: TrashItem) => void }) {
  const { s } = store;
  const trash = s.trash;
  const items = trash?.items ?? [];
  const bytes = items.reduce((sum, item) => sum + item.size, 0);
  const list = useRef<HTMLDivElement>(null);
  // The cursor's row stays in sight as the keys move it.
  useEffect(() => {
    list.current?.querySelector(`[data-t="${s.trashCursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [s.trashCursor]);
  return (
    <>
      <div class={BAR}>
        <Icon name="bin" class="text-muted" />
        <span class={BAR_NAME}>Trash</span>
        <span class={BAR_FACTS}>
          {fmt.items(items.length)} · {fmt.size(bytes)} · each kept {trash?.days ?? 30} days, then deleted for good
        </span>
        {items.length > 0 && (
          <button class="btn btn-line h-[calc(24px*var(--density))] px-2 phone:h-[34px]" onClick={() => store.askForget("all")}>
            Empty Trash…
          </button>
        )}
      </div>
      <div class={`label h-[calc(30px*var(--density))] flex-none border-b border-b-line text-muted ${TRASH_GRID}`}>
        <span />
        <span>Name</span>
        <span>Was in</span>
        <span class="text-right phone:hidden">Deleted</span>
        <span class="text-right">Left</span>
      </div>
      <div class="list relative min-h-0 flex-1 overflow-auto overscroll-contain" role="listbox" aria-label="Trash" ref={list}>
        {items.map((item, at) => {
          const left = daysLeft(item.gone);
          const ago = Math.floor((Date.now() / 1000 - item.deleted) / DAY);
          return (
            <div
              class={`row cursor-default touch-manipulation hover:bg-hover h-(--row-h) ${TRASH_GRID} shadow-[inset_0_calc(var(--line-w)*-1)_0_transparent] aria-selected:bg-accent-soft aria-selected:shadow-[inset_3px_0_0_var(--accent)]`}
              role="option"
              aria-selected={at === s.trashCursor}
              data-t={at}
              key={item.id}
              onClick={() => store.trashMoveTo(at)}
              onContextMenu={(event) => {
                store.trashMoveTo(at);
                onMenu(event, item);
              }}
            >
              <KindIcon kind={kindOfItem(item)} />
              <span class="min-w-0 truncate">
                <b class={item.dir ? "font-medium" : "font-regular"}>{nameOf(item.path)}</b>
              </span>
              <span class="min-w-0 truncate text-s text-muted [direction:rtl] text-left">
                <bdi class="[direction:ltr]">/{parentOf(item.path)}</bdi>
              </span>
              <span class="num text-right text-s whitespace-nowrap text-muted phone:hidden" title={fmt.abs(item.deleted)}>
                {ago ? `${ago}d ago` : "today"}
              </span>
              <span class={`num text-right text-s ${left <= 3 ? "font-medium text-accent" : "text-muted"}`} title={`Deleted for good on ${day(item.gone)}`}>
                {left}d
              </span>
            </div>
          );
        })}
        {trash?.loaded && items.length === 0 && (
          <div class={EMPTY}>
            <Icon name="bin" class="size-6 text-faint" />
            <b class={EMPTY_HEAD}>The Trash is empty</b>
            <span class={EMPTY_HINT}>What you delete stays here for {trash.days} days, then goes for good.</span>
          </div>
        )}
      </div>
    </>
  );
}

/** The entry under the Trash's cursor: where it goes back to, when it goes for good, and what to do with it. */
export function TrashItemPane() {
  const item = store.trashCur();
  if (!item) return <div class="order-1 min-h-0 min-w-0 flex-1 bg-surface" />;
  const days = store.s.trash?.days ?? 30;
  const left = daysLeft(item.gone);
  const used = Math.min(1, Math.max(0, (Date.now() / 1000 - item.deleted) / (days * DAY)));
  const name = nameOf(item.path);
  const taken = store.s.status === "ready" && parentOf(item.path) === store.s.path && store.s.all.some((entry) => entry.name === name);
  return (
    <div class="order-1 flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
      <div class={BAR}>
        <KindIcon kind={kindOfItem(item)} />
        <span class={BAR_NAME}>{name}</span>
        <span class={BAR_FACTS}>in the Trash</span>
      </div>
      <div class="grid content-start gap-3.5 overflow-auto p-[calc(var(--pad)*1.6)]">
        <div class="flex items-center gap-2.5 text-[length:calc(var(--text)*1.15)] font-strong">
          <KindIcon kind={kindOfItem(item)} class="size-5.5" />
          <span class="min-w-0 truncate">{name}</span>
        </div>
        <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-s">
          <dt class="text-faint">Was at</dt>
          <dd class="num m-0 wrap-anywhere">/{item.path}</dd>
          <dt class="text-faint">Deleted</dt>
          <dd class="num m-0">{fmt.abs(item.deleted)}</dd>
          <dt class="text-faint">Gone for good</dt>
          <dd class="num m-0">
            {day(item.gone)} · in {left} {left === 1 ? "day" : "days"}
          </dd>
          <dt class="text-faint">Size</dt>
          <dd class="num m-0">
            {item.dir ? `${fmt.items(item.count)} · ` : ""}
            {fmt.size(item.size)}
          </dd>
        </dl>
        <div class="h-1 overflow-hidden rounded-[99px] bg-sunken shadow-[inset_0_0_0_var(--line-w)_var(--line)]" title={`${Math.round(used * days)} of ${days} days`}>
          <i class="block h-full rounded-[inherit] bg-accent" style={{ width: `${used * 100}%` }} />
        </div>
        <div class="flex flex-wrap gap-2">
          <button class="btn btn-fill h-[calc(30px*var(--density))] px-[calc(12px*var(--density))]" onClick={() => void store.restore(item)}>
            <Icon name="restore" />
            Put back
          </button>
          <button class="btn btn-line h-[calc(30px*var(--density))] px-[calc(12px*var(--density))]" onClick={() => store.askForget(item)}>
            Delete forever…
          </button>
        </div>
        <p class="m-0 max-w-[44ch] text-xs leading-normal text-faint">
          Put back returns it to where it was, and makes that folder again if it is gone.
          {taken ? " The name is taken there now, so it comes back under the next free name." : " If the name is taken there by then, it comes back under the next free name."}
        </p>
      </div>
    </div>
  );
}

/** Asks before an entry of the Trash, or all of them, is deleted for good. The focus starts on Cancel. */
export function ConfirmForget() {
  const what = store.s.forgetting;
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    if (!busy) cancel.current?.focus();
  }, [busy]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!busy) store.askForget(null);
      } else if (event.key === "Tab") {
        (document.activeElement === cancel.current ? confirm : cancel).current?.focus();
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [busy]);
  if (!what) return null;
  const items = store.s.trash?.items ?? [];
  const all = what === "all";
  const close = () => !busy && store.askForget(null);
  const run = () => {
    setBusy(true);
    setFailure("");
    store.forget().catch((error: unknown) => {
      setBusy(false);
      setFailure(`Not deleted: ${error instanceof Error ? error.message : String(error)}.`);
    });
  };
  const noun = all ? "" : what.dir ? "folder" : "file";
  return (
    <div class={ASK_IN} onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <div class={ASK} role="alertdialog" aria-modal="true" aria-labelledby="forget-title" aria-describedby="forget-what">
        <h2 id="forget-title" class={`m-0 ${DIALOG_HEAD}`}>
          {all ? "Empty the Trash?" : `Delete this ${noun} forever?`}
        </h2>
        <div class="flex max-h-[8.5em] gap-2.25 overflow-auto overscroll-contain rounded bg-sunken px-2.75 py-2.25 text-s wrap-anywhere">
          {all ? <Icon name="bin" class="mt-[0.14em] text-muted" /> : <KindIcon kind={kindOfItem(what)} class="mt-[0.14em]" />}
          <span class="num">{all ? `${fmt.items(items.length)} · ${fmt.size(items.reduce((sum, item) => sum + item.size, 0))}` : `Trash/${nameOf(what.path)}`}</span>
        </div>
        <p id="forget-what" class="m-0 text-muted">
          {all ? "Everything in the Trash goes now, instead of when its days are up." : `It goes now, instead of in ${daysLeft(what.gone)} days.`}{" "}
          <b class="font-strong text-fg">There is no undo.</b>
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
            {busy ? "Deleting" : all ? "Empty Trash" : "Delete forever"}
          </button>
        </div>
      </div>
    </div>
  );
}
