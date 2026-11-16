// What a page in the preview asks okfs to keep of its controls, written into the page's own file. Only with
// `--allow-edit`. A page says what its controls show as they change; okfs waits for a pause, then reads the file,
// changes what the controls say in it (see `setControls`) and writes it over the version it read.

import { WriteError, putFile, tagIn, urls } from "./api";
import { type Control, setControls } from "./controls";
import { NoAnswer, call } from "./reach";
import { store } from "./store";
import { MAX_EDIT, readText } from "./text";

/** How long a page's controls must rest before they are written, in ms: typing in a field is one write, not one a key. */
const PAUSE = 400;

interface Due {
  controls: Control[];
  timer: ReturnType<typeof setTimeout> | undefined;
  /** A write of this file is on its way: the next one waits for it. */
  busy: boolean;
  /** The controls changed again while a write was on its way. */
  again: boolean;
}

const due = new Map<string, Due>();

const reasonOf = (error: unknown): string =>
  error instanceof NoAnswer ? error.why : error instanceof Error ? error.message : String(error);

/** Keeps what a page's controls show in its file, once they have rested. The newest word from the page wins. */
export function saveControls(path: string, controls: Control[]): void {
  let one = due.get(path);
  if (!one) {
    one = { controls, timer: undefined, busy: false, again: false };
    due.set(path, one);
  }
  one.controls = controls;
  clearTimeout(one.timer);
  const it = one;
  it.timer = setTimeout(() => {
    it.timer = undefined;
    void run(path, it);
  }, PAUSE);
}

async function run(path: string, one: Due): Promise<void> {
  if (one.busy) {
    one.again = true;
    return;
  }
  one.busy = true;
  try {
    await write(path, one.controls);
  } catch (error) {
    store.say(`Not saved: ${reasonOf(error)}`);
  } finally {
    one.busy = false;
  }
  if (one.again) {
    one.again = false;
    await run(path, one);
  } else if (due.get(path) === one && one.timer === undefined) due.delete(path);
}

/** One read and one write. A file changed on disk in between is read again once, and the controls set in that. */
async function write(path: string, controls: Control[], tries = 2): Promise<void> {
  const response = await call(urls.raw(path), { cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 404 ? "the file is no longer there" : `the server answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_EDIT) throw new Error("the page is too large to keep its controls");
  const read = readText(bytes);
  if (!read) throw new Error("the page is not UTF-8 text");
  const etag = tagIn(response);
  if (!etag) throw new Error("the server did not say which version of the page it sent");
  const next = setControls(read.found, controls, read.form.crlf ? "\r\n" : "\n");
  if (next === read.found) return;
  const done = putFile(path, new Blob([(read.form.bom ? "﻿" : "") + next]), { over: etag });
  store.ownWrite(path, done);
  try {
    await done;
  } catch (error) {
    if (error instanceof WriteError && error.status === 412 && tries > 1) return write(path, controls, tries - 1);
    throw error;
  }
}
