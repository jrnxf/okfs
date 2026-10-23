// Uploads: files dropped on the list or picked, sent a few at a time into their folder, each with how far it got.
// A file never lands on a name that is taken: the server refuses it, and the visitor chooses what happens instead.

import { type Clash, WriteError, joinPath, makeFolder, putFile } from "./api";
import { config } from "./config";
import { type Plan, heldIn, heldPicked, plan } from "./drop";
import * as fmt from "./fmt";
import { NoAnswer } from "./reach";
import { store } from "./store";

/** Files sent at once. More only share the same line. */
const AT_ONCE = 3;
/** How long the tray stays once every file is done, when none failed. */
const LINGER_MS = 4000;

/** `asking`: its name is taken, and it waits for the visitor to choose. */
export type JobState = "waiting" | "sending" | "asking" | "done" | "failed" | "skipped";

/** One file on its way. */
export interface Job {
  id: number;
  /** The folder it goes into, and its name there. */
  dir: string;
  name: string;
  file: File;
  state: JobState;
  /** Bytes sent so far, and when sending started, for the rate. */
  sent: number;
  started: number;
  /** Why it failed. */
  why?: string;
  /** Where it landed: its own name, or the next free one when both were kept. */
  path?: string;
}

/** What the visitor can do with a file whose name is taken. */
export type Choice = "keep" | "skip" | "replace";

/** A file whose name is taken, with what is there now. */
export interface Asking {
  job: Job;
  clash: Clash;
}

/** A file to send, and where. */
export interface Picked {
  file: File;
  dir: string;
  name: string;
}

let next = 0;

export class Uploads {
  jobs: Job[] = [];
  /** The file whose name is taken that the dialog asks about, and the ones waiting after it. */
  asking: Asking | null = null;
  private waiting: Asking[] = [];
  /** The choice made for every name that is taken, until the files picked with it are done. */
  private always: Choice | null = null;
  /** Folders and files a drop left out, as okfs would not take them: dotfiles while hidden files are not served. */
  leftOut = 0;
  /** The folder a drag is over, by its path, while one is. */
  target: string | null = null;
  private readonly listeners = new Set<() => void>();
  private linger: ReturnType<typeof setTimeout> | undefined;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Marks the folder a drag is over, or none. */
  aim(target: string | null): void {
    if (this.target === target) return;
    this.target = target;
    this.emit();
  }

  /** How many files are done, of all picked since the tray last emptied. */
  progress(): { done: number; all: number } {
    const done = this.jobs.filter((job) => !going(job)).length;
    return { done, all: this.jobs.length };
  }

  /** True while a file is waiting or on its way. */
  busy(): boolean {
    return this.jobs.some(going);
  }

  /**
   * Sends files, after making the folders they go in, one level at a time: `folders` are paths, a folder before
   * what is in it. A folder that is there already is gone into. Files in a folder that could not be made fail with it.
   */
  async add(picked: Picked[], folders: string[] = []): Promise<void> {
    clearTimeout(this.linger);
    const jobs = picked.map((pick): Job => ({ id: ++next, ...pick, state: "waiting", sent: 0, started: 0 }));
    if (!this.busy()) this.always = null;
    this.jobs.push(...jobs);
    this.emit();
    const failed = new Map<string, string>();
    for (const folder of folders) {
      const above = [...failed.keys()].find((dir) => folder.startsWith(`${dir}/`));
      if (above) {
        failed.set(folder, failed.get(above) ?? "");
        continue;
      }
      try {
        const clash = await makeFolder(folder);
        if (clash && !clash.d) failed.set(folder, "a file has the folder's name");
      } catch (error) {
        failed.set(folder, reasonOf(error));
      }
    }
    for (const job of jobs) {
      // Refused here, before it is sent: the server would refuse it by its length and close the connection on it.
      if (config.max_upload !== undefined && job.file.size > config.max_upload) {
        this.finish(job, "failed", `larger than the ${fmt.size(config.max_upload)} --max-upload allows`);
        continue;
      }
      const dir = [...failed.keys()].find((folder) => job.dir === folder || job.dir.startsWith(`${folder}/`));
      if (dir !== undefined) this.finish(job, "failed", `its folder was not made: ${failed.get(dir)}`);
    }
    this.pump();
  }

  /** Starts files while fewer than `AT_ONCE` are on their way. */
  private pump(): void {
    const sending = this.jobs.filter((job) => job.state === "sending").length;
    for (const job of this.jobs.filter((job) => job.state === "waiting").slice(0, Math.max(0, AT_ONCE - sending))) {
      void this.send(job, { new: true });
    }
    this.settle();
  }

  private async send(job: Job, want: { new: true; keep?: boolean } | { over: string }): Promise<void> {
    job.state = "sending";
    job.sent = 0;
    job.started = performance.now();
    this.emit();
    try {
      const written = await putFile(joinPath(job.dir, job.name), job.file, want, (sent) => {
        job.sent = sent;
        this.emit();
      });
      job.path = written.path;
      this.finish(job, "done");
    } catch (error) {
      if (error instanceof WriteError && error.clash && !error.clash.gone) this.clashed(job, error.clash);
      else this.finish(job, "failed", reasonOf(error));
    }
    this.pump();
  }

  /** A name that is taken: the choice made for all of them, or the dialog. */
  private clashed(job: Job, clash: Clash): void {
    job.state = "waiting";
    // A folder of that name, or a file without --allow-edit, cannot be replaced.
    const choice = this.always === "replace" && !replaceable(clash) ? null : this.always;
    if (choice) {
      this.answer(job, clash, choice);
      return;
    }
    job.state = "asking";
    job.sent = 0;
    const ask = { job, clash };
    if (this.asking) this.waiting.push(ask);
    else this.asking = ask;
    this.emit();
  }

  /** How many more names that are taken wait behind the one asked about. */
  others(): number {
    return this.waiting.length;
  }

  /** The visitor's choice for the name asked about, and with `all` for every other one that is taken. */
  choose(choice: Choice, all: boolean): void {
    const asked = this.asking;
    if (!asked) return;
    if (all) this.always = choice;
    this.asking = null;
    const waiting = this.waiting;
    this.waiting = [];
    this.answer(asked.job, asked.clash, choice);
    for (const ask of waiting) {
      if (all) this.clashed(ask.job, ask.clash);
      else if (this.asking) this.waiting.push(ask);
      else this.asking = ask;
    }
    this.emit();
  }

  private answer(job: Job, clash: Clash, choice: Choice): void {
    if (choice === "skip") {
      this.finish(job, "skipped");
      this.pump();
    } else if (choice === "replace" && clash.etag) {
      void this.send(job, { over: clash.etag });
    } else {
      void this.send(job, { new: true, keep: true });
    }
  }

  private finish(job: Job, state: JobState, why?: string): void {
    job.state = state;
    job.why = why;
    this.emit();
  }

  /** Once every file is done, the tray goes after a moment. One that failed keeps it until it is closed. */
  private settle(): void {
    if (this.busy() || !this.jobs.length) return;
    clearTimeout(this.linger);
    if (this.jobs.some((job) => job.state === "failed")) return;
    this.linger = setTimeout(() => this.clear(), LINGER_MS);
  }

  /** Empties the tray of what is done. */
  clear(): void {
    clearTimeout(this.linger);
    this.jobs = this.jobs.filter(going);
    if (!this.jobs.length) this.leftOut = 0;
    this.emit();
  }
}

/** True for a file that is not done: waiting, on its way, or waiting for a choice. */
const going = (job: Job): boolean => job.state === "waiting" || job.state === "sending" || job.state === "asking";

/** `name` with a number before its extension, as the server names a file kept beside one: `tides (1).csv`. */
export function numbered(name: string, copy: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${copy})${name.slice(dot)}` : `${name} (${copy})`;
}

/** True when a name that is taken can be replaced: it is a file, and changing files is on. */
export const replaceable = (clash: Clash): boolean => config.edit === true && !clash.d && clash.etag !== undefined;

/** A failure in words, for the tray. */
export function reasonOf(error: unknown): string {
  if (error instanceof NoAnswer) return error.why;
  return error instanceof Error ? error.message : String(error);
}

export const uploads = new Uploads();

/** Uploads what a plan holds, and counts what it left out. */
export function start({ picked, folders, leftOut }: Plan): void {
  uploads.leftOut += leftOut;
  if (picked.length || folders.length) void uploads.add(picked, folders);
  else if (leftOut) store.say("okfs does not take names that start with a dot");
}

/** Uploads what was dropped into the folder `dir`, folders and all. */
export function drop(data: DataTransfer, dir: string): void {
  heldIn(data).then(
    ({ held, empty }) => start(plan(held, dir, config.hidden === true, empty)),
    () => store.say("The browser would not hand over what was dropped"),
  );
}

/** Opens the system's file picker, for files or for one folder, and uploads what is picked into the folder `dir`. */
export function pick(dir: string, folder = false): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.webkitdirectory = folder;
  input.hidden = true;
  const done = () => input.remove();
  input.addEventListener("change", () => {
    if (input.files) start(plan(heldPicked(input.files), dir, config.hidden === true));
    done();
  });
  input.addEventListener("cancel", done);
  // In the page: some browsers open no picker for an input that is not.
  document.body.append(input);
  input.click();
}
