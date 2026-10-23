// The editor in the pane, in place of a file's preview: its bar, which says whether the text is saved, a bar when the
// file changes on disk meanwhile, and CodeMirror under them, fetched the first time a file is edited.

import { useEffect, useRef, useState } from "preact/hooks";
import { WriteError, putFile, urls } from "./api";
import type { Editing } from "./cm";
import { config } from "./config";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { ASK, ASK_BTN, ASK_DO, ASK_IN, BAR, BAR_BTN, BAR_FACTS, BAR_NAME, DIALOG_HEAD } from "./look";
import { MOD } from "./palette";
import { call } from "./reach";
import { type Entry, store } from "./store";
import { type Form, linesChanged, readText, writeText } from "./text";
import { reasonOf } from "./upload";

/** Whether the text is saved, beside the file's name. */
const STATE = "inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted";
/** A button of the bar that says the file changed on disk. */
const DISK_BTN = "h-[calc(26px*var(--density))] px-2.5 phone:h-9";

/** What the editor started from: the file as it was read or last saved, and the tag of that version. */
interface Base {
  text: string;
  form: Form;
  etag: string;
}

/** A version of the file on disk that is not the one the editor started from. `gone`: there is none any more. */
interface Theirs {
  etag: string;
  gone: boolean;
  at: number;
}

/** The file as it is on disk now, for the editor. Fails when it is not UTF-8 text. */
async function fetchText(path: string): Promise<Base> {
  const response = await call(urls.raw(path), { cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 404 ? "the file is no longer there" : `the server answered ${response.status}`);
  const read = readText(new Uint8Array(await response.arrayBuffer()));
  if (!read) throw new Error("this file is not text okfs can edit");
  return { ...read, etag: response.headers.get("etag") ?? "" };
}

/** The tag of the file as it is on disk now, or `null` when it is gone. */
async function tagOf(path: string): Promise<string | null> {
  const response = await call(urls.raw(path), { method: "HEAD", cache: "no-store" });
  return response.ok ? (response.headers.get("etag") ?? "") : null;
}

export function Editor({ file }: { file: Entry }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editing | null>(null);
  const base = useRef<Base | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState("");
  const [changed, setChanged] = useState(0);
  const [saving, setSaving] = useState(false);
  const [theirs, setTheirs] = useState<Theirs | null>(null);
  const counting = useRef(0);
  const unsaved = () => editor.current !== null && base.current !== null && editor.current.text() !== base.current.text;

  // How many lines differ from what was read, counted once a frame at most: a file may be long.
  const count = () => {
    cancelAnimationFrame(counting.current);
    counting.current = requestAnimationFrame(() => {
      const text = editor.current?.text();
      if (text !== undefined && base.current) setChanged(linesChanged(base.current.text, text));
    });
  };

  const save = async (over?: string) => {
    const now = editor.current;
    const from = base.current;
    if (!now || !from || saving) return;
    setSaving(true);
    const text = now.text();
    try {
      const want = over === undefined || over === "" ? (from.etag ? { over: from.etag } : { new: true as const }) : { over };
      const written = await putFile(file.path, new Blob([writeText(text, from.form)]), want);
      // The live feed tells of this save too: it carries this tag, and the editor knows it as its own.
      base.current = { text, form: from.form, etag: written.etag };
      setTheirs(null);
      count();
      store.say(`Saved “${file.name}”`);
    } catch (error) {
      if (error instanceof WriteError && error.clash) {
        setTheirs({ etag: error.clash.etag ?? "", gone: error.clash.gone === true, at: Date.now() });
      } else {
        store.say(`Not saved: ${reasonOf(error)}`);
      }
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // The file is read, and CodeMirror fetched, when the editor opens.
  useEffect(() => {
    let gone = false;
    Promise.all([fetchText(file.path), import("./cm")])
      .then(([read, cm]) => {
        if (gone || !host.current) return;
        base.current = read;
        editor.current = cm.mount(host.current, read.text, {
          ext: file.ext,
          nonce: config.nonce,
          wrap: store.wraps(file),
          changed: count,
          save: () => void saveRef.current(),
        });
        editor.current.focus();
        setReady(true);
      })
      .catch((error: unknown) => !gone && setFailed(reasonOf(error)));
    const stop = store.watchUnsaved(unsaved);
    return () => {
      gone = true;
      stop();
      cancelAnimationFrame(counting.current);
      editor.current?.destroy();
      editor.current = null;
    };
  }, [file.path]);

  // A file written on disk while it is open: with nothing unsaved it is read again, and otherwise a bar says so.
  const stamp = store.stamp(file);
  useEffect(() => {
    if (!ready) return;
    let gone = false;
    void tagOf(file.path)
      .then(async (tag) => {
        const from = base.current;
        if (gone || !from || tag === from.etag) return;
        if (tag !== null && !unsaved()) {
          const read = await fetchText(file.path);
          if (gone || unsaved()) return;
          base.current = read;
          editor.current?.replace(read.text);
          count();
          return;
        }
        setTheirs({ etag: tag ?? "", gone: tag === null, at: Date.now() });
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [stamp, ready]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (unsaved()) event.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, []);

  useEffect(() => editor.current?.wrap(store.wraps(file)), [store.wraps(file)]);

  /** Their version in place of the text in the editor. Undo brings back what was there. */
  const showTheirs = async () => {
    try {
      const read = await fetchText(file.path);
      base.current = read;
      editor.current?.replace(read.text);
      setTheirs(null);
      count();
      editor.current?.focus();
    } catch (error) {
      store.say(`Could not read it: ${reasonOf(error)}`);
    }
  };

  const discard = () => {
    if (base.current) editor.current?.replace(base.current.text);
    store.stopEdit();
  };

  // Esc leaves the editor, and asks first when something is unsaved. One that CodeMirror took, as to close its
  // search, does not.
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    store.leave(() => undefined);
  };

  const form = base.current?.form;
  const facts = form ? [form.crlf ? "CRLF" : "LF", form.bom ? "UTF-8 with BOM" : "UTF-8"].join(" · ") : "";
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={onKey}>
      <div class={BAR}>
        <button class={`btn ${BAR_BTN}`} aria-label="Leave the editor" title="Leave the editor (esc)" onClick={() => store.leave(() => undefined)}>
          <Icon name="left" />
        </button>
        <KindIcon kind={file.kind} />
        <span class={BAR_NAME}>{file.name}</span>
        {changed > 0 ? (
          <span class={STATE}>
            <i class="size-1.75 flex-none rounded-[50%] bg-accent" title="Unsaved" />
            <span class="phone:hidden">
              Unsaved · {fmt.count(changed)} {changed === 1 ? "line" : "lines"} changed
            </span>
          </span>
        ) : (
          <span class={`${STATE} phone:hidden`}>{ready ? "Saved" : failed ? "" : "Opening"}</span>
        )}
        <span class={`${BAR_FACTS} text-right`}>{facts}</span>
        <button class={`btn ${BAR_BTN}`} disabled={!ready} onClick={discard}>
          Discard
        </button>
        <button class={`btn btn-fill ${BAR_BTN} gap-2 px-2.5`} disabled={!ready || saving || changed === 0} onClick={() => void save()}>
          {saving ? "Saving" : "Save"}
          <kbd class="h-auto min-w-0 border-0 bg-transparent p-0 text-inherit opacity-75 phone:hidden">{MOD === "⌘" ? "⌘S" : "Ctrl S"}</kbd>
        </button>
      </div>
      {theirs && (
        <div
          class="flex flex-none items-center gap-2.5 border-b border-b-line bg-[color-mix(in_srgb,var(--kind-data)_12%,var(--surface))] px-3 py-1.75 text-s phone:flex-wrap"
          role="alert"
        >
          <span class="min-w-0 flex-1 phone:basis-full">
            <b class="font-strong">{file.name}</b> {theirs.gone ? "was deleted on disk" : "changed on disk"} while you were editing.
          </span>
          {!theirs.gone && (
            <button class={`btn btn-line ${DISK_BTN}`} title="Their version in place of yours: undo brings yours back" onClick={() => void showTheirs()}>
              Show theirs
            </button>
          )}
          <button class={`btn btn-line ${DISK_BTN}`} disabled={saving} onClick={() => void save(theirs.gone ? undefined : theirs.etag)}>
            {theirs.gone ? "Save mine again" : "Save mine over it"}
          </button>
        </div>
      )}
      {failed ? (
        <div class="px-[calc(var(--pad)*1.25)] py-4 text-muted">Not opened: {failed}.</div>
      ) : (
        <div class="min-h-0 flex-1 overflow-hidden [&>.cm-editor]:h-full" ref={host} />
      )}
    </div>
  );
}

/** Asks whether to leave unsaved changes. Staying is where the focus starts: Enter never throws work away. */
export function ConfirmLeave() {
  const stay = useRef<HTMLButtonElement>(null);
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => stay.current?.focus(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") store.leaveAnyway(false);
      else if (event.key === "Tab") (document.activeElement === stay.current ? go : stay).current?.focus();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const name = store.s.editing?.name ?? "this file";
  return (
    <div class={ASK_IN} onPointerDown={(event) => event.target === event.currentTarget && store.leaveAnyway(false)}>
      <div class={ASK} role="alertdialog" aria-modal="true" aria-labelledby="leave-title" aria-describedby="leave-what">
        <h2 id="leave-title" class={`m-0 truncate ${DIALOG_HEAD}`}>
          Leave “{name}” unsaved?
        </h2>
        <p id="leave-what" class="m-0 text-muted">The changes you made are lost if you leave now.</p>
        <div class={ASK_DO}>
          <button class={`btn btn-line ${ASK_BTN}`} ref={go} onClick={() => store.leaveAnyway(true)}>
            Leave without saving
          </button>
          <button class={`btn btn-fill ${ASK_BTN}`} ref={stay} onClick={() => store.leaveAnyway(false)}>
            Keep editing
          </button>
        </div>
      </div>
    </div>
  );
}
