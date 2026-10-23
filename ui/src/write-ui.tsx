// What a page that can write shows: the tray of uploads, the dialog for a name that is taken, and the one that names a
// new file or folder. None of it is drawn unless the server has uploading on.

import { useEffect, useRef, useState } from "preact/hooks";
import { WriteError, joinPath, makeFolder, nameOf, putFile } from "./api";
import { config } from "./config";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { kindOf } from "./kinds";
import { ASK, ASK_BTN, ASK_DO, ASK_IN, DIALOG_HEAD } from "./look";
import { store } from "./store";
import { type Job, numbered, reasonOf, replaceable, uploads } from "./upload";

/** The two buttons of a dialog that a Tab goes back and forth between, and Escape that closes it. */
function useDialogKeys(close: () => void, ring: () => (HTMLElement | null)[], busy = false): void {
  // The latest of each, as they change with every draw: a choice the dialog holds, such as its checkbox.
  const latest = useRef({ close, ring, busy });
  latest.current = { close, ring, busy };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { close, ring, busy } = latest.current;
      if (event.key === "Escape") {
        if (!busy) close();
      } else if (event.key === "Tab") {
        const all = ring().filter((el): el is HTMLElement => el !== null && !(el as HTMLButtonElement).disabled);
        if (!all.length) return;
        const at = all.indexOf(document.activeElement as HTMLElement);
        all[(at + (event.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
      } else {
        return;
      }
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** How one file in the tray is doing, in a few words. */
function progressOf(job: Job, now: number): string {
  switch (job.state) {
    case "waiting":
      return "waiting";
    case "asking":
      return "name taken";
    case "done":
      return job.path && nameOf(job.path) !== job.name ? `done, as ${nameOf(job.path)}` : "done";
    case "skipped":
      return "skipped";
    case "failed":
      return job.why ?? "failed";
    case "sending": {
      const share = job.file.size ? Math.min(99, Math.floor((job.sent / job.file.size) * 100)) : 0;
      const seconds = (now - job.started) / 1000;
      const rate = seconds > 0.5 ? ` · ${fmt.size(job.sent / seconds)}/s` : "";
      return `${share}%${rate}`;
    }
  }
}

/** The tray: over the page's foot, at its corner, and across a phone's screen. */
const TRAY =
  "fixed right-3.5 bottom-[calc(28px*var(--density)+10px)] z-35 grid w-[min(320px,calc(100vw-28px))] gap-2 rounded-lg border border-line bg-surface px-3 pt-2.5 pb-2.75 text-s shadow transition-[opacity,transform] duration-160 ease-out starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none phone:right-2.5 phone:bottom-[calc(44px*var(--density)+env(safe-area-inset-bottom)+10px)] phone:left-2.5 phone:w-auto";

/** The color of what a file in the tray says, by how it is doing. */
const SAYS: Record<Job["state"], string> = {
  waiting: "text-muted",
  sending: "text-muted",
  asking: "text-fg",
  done: "text-kind-code",
  failed: "text-accent",
  skipped: "text-faint",
};

/** The heads and the labels of the table that sets what is there beside what is coming. */
const CMP_HEAD = "font-ui text-s font-strong text-muted";
const CMP_LABEL = "font-ui text-faint";

/** Rows the tray shows at most. The rest are counted under them. */
const TRAY_ROWS = 6;

/** The uploads, at the foot of the page while they go and a moment after: one row a file, with how far it got. */
export function Tray() {
  const { jobs } = uploads;
  if (!jobs.length) return null;
  const { done, all } = uploads.progress();
  const dirs = new Set(jobs.map((job) => job.dir));
  const where = dirs.size === 1 ? nameOf([...dirs][0] ?? "") || config.root : `${fmt.count(dirs.size)} folders`;
  // Those on their way and those that failed first: they are what to look at.
  const order = (job: Job): number => ({ asking: 0, sending: 0, failed: 1, waiting: 2, done: 3, skipped: 3 })[job.state];
  const shown = [...jobs].sort((a, b) => order(a) - order(b)).slice(0, TRAY_ROWS);
  const now = performance.now();
  const busy = uploads.busy();
  return (
    <section class={TRAY} aria-label="Uploads" role="status">
      <div class="flex min-w-0 items-center gap-2">
        <b class="min-w-0 flex-1 truncate font-strong">{busy ? `Uploading to ${where}` : `Uploaded to ${where}`}</b>
        <span class="num text-xs text-muted">
          {fmt.count(done)} of {fmt.count(all)}
        </span>
        {!busy && (
          <button class="btn -my-0.75 -mr-1.5 h-5.5 px-1" aria-label="Close" onClick={() => uploads.clear()}>
            <Icon name="close" />
          </button>
        )}
      </div>
      {shown.map((job) => {
        const share = job.state === "sending" && job.file.size ? job.sent / job.file.size : job.state === "done" ? 1 : 0;
        return (
          <div class="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2.5 gap-y-1" key={job.id}>
            <span class="min-w-0 truncate">{job.name}</span>
            <span class={`num max-w-[14em] truncate text-right text-xs ${SAYS[job.state]}`} title={job.why}>
              {progressOf(job, now)}
            </span>
            <span class="col-span-full h-0.75 overflow-hidden rounded-[2px] bg-line">
              <i
                class={`block h-full transition-[width] duration-120 ease-linear motion-reduce:transition-none ${job.state === "done" ? "bg-kind-code" : "bg-accent"}`}
                style={{ width: `${Math.round(share * 100)}%` }}
              />
            </span>
          </div>
        );
      })}
      {jobs.length > shown.length && <div class="label text-muted">and {fmt.count(jobs.length - shown.length)} more</div>}
      {uploads.leftOut > 0 && (
        <div class="label text-muted">
          {fmt.count(uploads.leftOut)} hidden {uploads.leftOut === 1 ? "entry" : "entries"} left out
        </div>
      )}
    </section>
  );
}

/**
 * Asks what to do with a file whose name is taken. It sets what is there beside what is coming, and the focus starts
 * on Keep both: Enter keeps both and never replaces a file. Replace is offered only when changing files is on.
 */
export function ClashDialog() {
  const asking = uploads.asking;
  const keep = useRef<HTMLButtonElement>(null);
  const skip = useRef<HTMLButtonElement>(null);
  const replace = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    keep.current?.focus();
    setAll(false);
  }, [asking?.job.id]);
  useDialogKeys(() => uploads.choose("skip", all), () => [box.current, skip.current, replace.current, keep.current]);
  if (!asking) return null;
  const { job, clash } = asking;
  const others = uploads.others();
  const folder = nameOf(job.dir) || config.root;
  const known = job.dir === store.s.path ? new Set(store.s.all.map((entry) => entry.name)) : new Set<string>();
  let copy = 1;
  while (known.has(numbered(job.name, copy))) copy++;
  const choose = (choice: "keep" | "skip" | "replace") => () => uploads.choose(choice, all);
  return (
    <div class={ASK_IN} onPointerDown={(event) => event.target === event.currentTarget && uploads.choose("skip", false)}>
      <div class={ASK} role="alertdialog" aria-modal="true" aria-labelledby="clash-title" aria-describedby="clash-what">
        <h2 id="clash-title" class={`m-0 truncate ${DIALOG_HEAD}`}>
          {job.name} is already here
        </h2>
        <p id="clash-what" class="m-0 text-muted">
          The folder <code class="rounded-[4px] bg-sunken px-1.25 py-px font-mono text-s text-fg wrap-anywhere">{folder}</code> has {clash.d ? "a folder" : "a file"} of that name.
        </p>
        {!clash.d && (
          <div class="num grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] gap-x-3.5 gap-y-1.25 rounded border border-line px-2.75 py-2.25 text-s">
            <span />
            <b class={CMP_HEAD}>Here now</b>
            <b class={CMP_HEAD}>Uploading</b>
            <span class={CMP_LABEL}>Size</span>
            <span>{clash.s === undefined ? "" : fmt.size(clash.s)}</span>
            <span>{fmt.size(job.file.size)}</span>
            <span class={CMP_LABEL}>Changed</span>
            <span>{clash.m === undefined ? "" : fmt.abs(clash.m)}</span>
            <span>{fmt.abs(Math.floor(job.file.lastModified / 1000))}</span>
          </div>
        )}
        {others > 0 && (
          <label class="flex items-center gap-2 text-s text-muted">
            <input class="m-0 accent-accent" type="checkbox" ref={box} checked={all} onChange={(event) => setAll(event.currentTarget.checked)} />
            Do the same for the {others === 1 ? "other name" : `${fmt.count(others)} other names`} that {others === 1 ? "is" : "are"} taken
          </label>
        )}
        <div class={ASK_DO}>
          <button class={`btn ${ASK_BTN}`} ref={skip} onClick={choose("skip")}>
            Skip
          </button>
          {replaceable(clash) && (
            <button class={`btn btn-line ${ASK_BTN}`} ref={replace} onClick={choose("replace")}>
              Replace it
            </button>
          )}
          <button class={`btn btn-fill ${ASK_BTN}`} ref={keep} title={`Keep both: ${numbered(job.name, copy)}`} onClick={choose("keep")}>
            <span class="min-w-0 truncate">Keep both: {numbered(job.name, copy)}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Asks for the name of a new file or folder in the folder on screen, and makes it. */
export function NameDialog({ kind, dir }: { kind: "file" | "folder"; dir: string }) {
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const make = useRef<HTMLButtonElement>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    input.current?.focus();
  }, []);
  const close = () => store.setNaming(null);
  useDialogKeys(close, () => [input.current, cancel.current, make.current], busy);
  const trimmed = name.trim();
  const wrong = !trimmed
    ? ""
    : trimmed.includes("/") || trimmed === "." || trimmed === ".."
      ? "A name is one name, with no slash in it."
      : trimmed.startsWith(".") && !config.hidden
        ? "okfs does not show names that start with a dot."
        : "";
  const run = async (event: Event) => {
    event.preventDefault();
    if (!trimmed || wrong || busy) return;
    setBusy(true);
    setFailure("");
    const path = joinPath(dir, trimmed);
    try {
      if (kind === "folder") {
        const clash = await makeFolder(path);
        if (clash) throw new WriteError(`There is already ${clash.d ? "a folder" : "a file"} named “${trimmed}”.`, 412, clash);
      } else {
        await putFile(path, new Blob([]), { new: true });
      }
      store.setNaming(null);
      await store.made(path);
      // A new file is there to be written in.
      if (kind === "file") store.edit(store.s.entries.find((entry) => entry.path === path) ?? null);
    } catch (error) {
      setBusy(false);
      const taken = error instanceof WriteError && error.clash ? `There is already ${error.clash.d ? "a folder" : "a file"} named “${trimmed}”.` : "";
      setFailure(taken || `Not made: ${reasonOf(error)}.`);
      input.current?.focus();
    }
  };
  const where = nameOf(dir) || config.root;
  return (
    <div
      class={ASK_IN}
      role="dialog"
      aria-modal="true"
      aria-labelledby="name-title"
      onPointerDown={(event) => event.target === event.currentTarget && !busy && close()}
    >
      <form class={ASK} onSubmit={run}>
        <h2 id="name-title" class={`m-0 truncate ${DIALOG_HEAD}`}>
          New {kind} in {where}
        </h2>
        <label class="flex h-[calc(34px*var(--density))] items-center gap-2.25 rounded bg-sunken px-2.75 text-s focus-within:shadow-[0_0_0_var(--line-w)_var(--accent)] phone:h-11">
          <KindIcon kind={kind === "folder" ? "folder" : kindOf(trimmed || "untitled.txt", false)} />
          <input
            class="min-w-0 flex-1 border-0 bg-transparent p-0 text-fg outline-none"
            ref={input}
            type="text"
            name="name"
            value={name}
            placeholder={kind === "folder" ? "Folder name" : "File name, such as notes.md"}
            spellcheck={false}
            autocomplete="off"
            aria-label={`Name of the new ${kind}`}
            disabled={busy}
            onInput={(event) => {
              setName(event.currentTarget.value);
              setFailure("");
            }}
          />
        </label>
        {(wrong || failure) && (
          <p class="m-0 font-strong text-fg" role="alert">
            {wrong || failure}
          </p>
        )}
        <div class={ASK_DO}>
          <button type="button" class={`btn btn-line ${ASK_BTN}`} ref={cancel} disabled={busy} onClick={close}>
            Cancel
          </button>
          <button type="submit" class={`btn btn-fill ${ASK_BTN}`} ref={make} disabled={busy || !trimmed || wrong !== ""}>
            {busy ? "Making" : `Make ${kind}`}
          </button>
        </div>
      </form>
    </div>
  );
}
