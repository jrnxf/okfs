// What the pane shows for a file: the one under the cursor while the preview is open, or the one given the
// full width.

import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type Archive, type TextPreview, getAnswer, getJson, pathOf, urls } from "./api";
import { config } from "./config";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { LABEL, decodedByServer, hasSource } from "./kinds";
import { NoAnswer, type Unreached, useDown } from "./reach";
import { COLUMN_ROWS, type Left, followOf, slots } from "./slots";
import type { Entry } from "./store";

/**
 * Frames and players cost a lot to start. Under a held key, which passes a file faster than one can start,
 * they wait until the key is up or the cursor has stopped for this long.
 */
const SETTLE_HEAVY = 90;
/**
 * An HTML page smaller than this starts its frame as the cursor reaches it, even under a held key, so small
 * pages show as they pass. A larger page would start a download of megabytes for each page passed, so it waits
 * like a PDF does.
 */
const EAGER_FRAME_BYTES = 256 * 1024;
/** After this long without an answer, the previous file's preview is cleared instead of kept. */
const STALE = 250;
/**
 * A page, or the preview before a video, stays in the pane this long after the cursor has left it, while the
 * next one gets ready. Past it the pane shows what main always did: under a held key it would otherwise show
 * a file from several back.
 */
const KEEP = 100;
/**
 * HTML pages past the cursor that are loaded before it gets there, each in a frame of its own that is not on
 * screen, and how many the cursor has left are kept in case it turns back.
 */
const AHEAD_PAGES = 5;
const BEHIND_PAGES = 1;
/** PDFs are loaded ahead with them, fewer: each brings the browser's whole viewer. */
const AHEAD_PDFS = 2;
/** A page larger than this is not loaded ahead, and all that are loaded ahead stay under the second number. */
const AHEAD_PAGE_BYTES = 4 * 1024 * 1024;
const AHEAD_PAGES_BYTES = 32 * 1024 * 1024;
/** A key repeating faster than this many ms a move passes pages faster than any can load: none are started. */
const AHEAD_PAGES_PACE = 50;
/**
 * The page on screen is given this long, loaded, before the pages after it are started. All frames share one
 * process: started with it, they made a 49 KB page 20 to 30 ms late to the screen.
 */
const AHEAD_PAGES_REST = 50;
/** A PDF says it has loaded when its viewer has, 150 ms and more before its first page is drawn: it is given longer. */
const AHEAD_PDF_REST = 300;
/**
 * The picture of a PDF's first page stays over its frame this long after the frame says it has loaded: the
 * viewer has not drawn its first page by then.
 */
const SHEET_KEEP = 200;
/**
 * Videos past the cursor whose picture is taken before it gets there, how many are loading at once, and how
 * many pictures are kept. Each costs a request or two for a part of the file.
 */
const AHEAD_STILLS = 6;
const STILLS_AT_ONCE = 2;
const STILLS_KEPT = 24;
/** Where in a video its picture is taken, in seconds: where the grid takes a tile's. */
const STILL_AT = 2;
/** A video that has given no picture after this long is given up. */
const STILL_WAIT = 5000;
/** A picture is no wider than this: a frame of a 4K video takes a tenth of a second to pack. */
const STILL_WIDTH = 1920;
/** Children of one JSON object or array shown before "show more". */
const JSON_PAGE = 200;
/**
 * Lines of a source file asked for first: a screen or two of them. Coloring costs by the line, and so does
 * drawing, so the start of a file can be on screen in the frame the cursor reaches it.
 */
const FIRST_LINES = 80;
/**
 * The whole of a file is asked for once the cursor has rested on it this long. Longer than a keyboard waits
 * before a held key repeats: at 150 a walk began by drawing the whole of the file it started on, which stalls
 * the page for half a second on a file of 1 MB.
 */
const WHOLE_REST = 500;
/**
 * Rows of a table or of an archive's listing drawn first. Drawing costs by the row, 2,000 of them a tenth of
 * a second or two, so the rest wait for the cursor to rest, as the rest of a source file does.
 */
const FIRST_ROWS = 100;
/** Entries past the cursor, in the direction it moves, that are asked for before the cursor gets there. */
const AHEAD = 16;
/** Pictures cost more to hold than text does: fewer of them are loaded ahead. */
const AHEAD_PICTURES = 10;
/**
 * The nearest of those are also unpacked, so they are drawn in the frame the cursor reaches them. An unpacked
 * picture takes four bytes a pixel, so only a few are, and none larger than this many pixels.
 */
const AHEAD_UNPACKED = 3;
const UNPACK_PIXELS = 8_000_000;
/** Requests of the pane on their way at once. Past this the oldest gives way. */
const FLIGHTS = 12;

/** Reports facts learned by showing a file, such as an image's size, for the pane's header. */
export type Report = (path: string, facts: string[]) => void;

const answers = new Map<string, unknown>();
/** One for each `useLoaded` on screen: the address it shows, and what to call when its answer is dropped. */
const askers = new Set<{ url: string; again: () => void }>();
function remember(url: string, data: unknown): void {
  answers.delete(url);
  answers.set(url, data);
  // Oldest first out: a Map keeps insertion order.
  if (answers.size > 200) answers.delete(answers.keys().next().value as string);
}

/**
 * Drops the answers kept about the paths that `stale` picks, or every answer, and asks again for those
 * on screen. After a delete or a change on disk, some of them describe what is gone or was rewritten.
 */
export function forgetAnswers(stale: (path: string) => boolean = () => true): void {
  const dropped = (url: string): boolean => {
    const path = pathOf(url);
    return path === null || stale(path);
  };
  for (const url of [...answers.keys()]) if (dropped(url)) answers.delete(url);
  // A request on its way was made before the change: its answer is not kept, and what is on screen asks again.
  for (const url of [...flights.keys()]) if (dropped(url)) flights.delete(url);
  for (const asker of askers) if (dropped(asker.url)) asker.again();
}

/** Requests on their way that a move of the cursor does not cancel, oldest first. */
const flights = new Map<string, { abort: AbortController; done: Promise<unknown> }>();

function land(url: string, flight: { abort: AbortController }): void {
  if (flights.get(url)?.abort === flight.abort) flights.delete(url);
}

/**
 * Asks for an address once, however many ask and whether or not the cursor stays, and keeps the answer.
 * Holding an arrow key passes a file in a thirtieth of a second: a request cancelled on the way past would
 * never be answered, and one that is answered is wanted again as soon as the cursor comes back.
 */
function ask<T>(url: string): Promise<T> {
  const known = answers.get(url);
  if (known !== undefined) return Promise.resolve(known as T);
  const going = flights.get(url);
  if (going) return going.done as Promise<T>;
  if (flights.size >= FLIGHTS) {
    const [oldest, flight] = flights.entries().next().value as [string, { abort: AbortController }];
    flights.delete(oldest);
    flight.abort.abort();
  }
  const flight = { abort: new AbortController(), done: Promise.resolve() as Promise<unknown> };
  flight.done = getAnswer<T>(url, flight.abort.signal)
    .then((data) => {
      // An answer to a request that was dropped describes a file that has changed since.
      if (flights.get(url)?.abort === flight.abort) remember(url, data);
      return data;
    })
    .finally(() => land(url, flight));
  flights.set(url, flight);
  return flight.done as Promise<T>;
}

/** Asks for an answer about to be drawn, as `ask` does. Settles once it is kept, or is not coming. */
export const preload = (url: string): Promise<void> =>
  ask(url).then(
    () => undefined,
    () => undefined,
  );

/** The start of a text file, by the address of the whole of it: what the pane asks for first. */
const startOf = (whole: string): string => `${whole}&lines=${FIRST_LINES}`;
const startUrl = (path: string, source = false): string => startOf(source ? urls.source(path) : urls.preview(path));

/** Pictures loaded ahead of the cursor, held so the browser keeps them. */
const pictures: HTMLImageElement[] = [];

/** Pictures that have been unpacked, or are being. */
const unpacked = new WeakSet<HTMLImageElement>();

/** Unpacks a picture loaded ahead once its size is known, unless it is too large to hold unpacked. */
function unpack(picture: HTMLImageElement): void {
  if (unpacked.has(picture)) return;
  unpacked.add(picture);
  const sized = () => {
    if (picture.naturalWidth * picture.naturalHeight <= UNPACK_PIXELS) picture.decode().catch(() => undefined);
  };
  if (picture.complete) sized();
  else picture.addEventListener("load", sized, { once: true });
}

/**
 * Where the columns of the folder at `path` are had: its listing, and in the same answer the listing of each
 * folder its focused entry leads to, for the slots past its own: the entry `picks` names for that level, or the
 * one `left` names for its folder, or its first. See `focusOf`. One answer, so every column is drawn together.
 * It holds names, sizes and times, and nothing read from a file.
 */
export const columnsUrl = (path: string, picks: string[] = [], left?: Left): string => {
  const depth = slots() - 2;
  return urls.list(path, COLUMN_ROWS, depth, followOf(path, picks, depth, left));
};

/** The JSON the pane asks for when it shows the file `entry`, if it asks for any. `source`: as its source. */
function addressOf(entry: Entry, source: boolean): string | null {
  if (source && hasSource(entry)) return startUrl(entry.path, true);
  switch (entry.kind) {
    case "folder":
    case "image":
    case "video":
    case "audio":
    case "pdf":
    case "html":
      return null;
    case "archive":
      return entry.ext === "zip" ? urls.archive(entry.path) : null;
    default:
      return startUrl(entry.path);
  }
}

/** One frame of each video the cursor is about to reach, by the address its player loads: see `Media`. */
const stills = new Map<string, string>();
/** Videos a picture is being taken of, each with what stops it. */
const filming = new Map<string, () => void>();

/** Stops every picture being taken, so a player that starts has the line and the decoder to itself. */
function hush(): void {
  for (const end of [...filming.values()]) end();
}

/**
 * Takes the picture of the video at `src` that stands in for its player under a held key. The video is loaded
 * as far as one frame in an element that is never shown, and that frame is kept as a JPEG.
 */
function film(src: string): void {
  if (stills.has(src) || filming.has(src) || filming.size >= STILLS_AT_ONCE) return;
  const video = document.createElement("video");
  const end = () => {
    clearTimeout(timer);
    filming.delete(src);
    video.onloadeddata = video.onerror = null;
    // Lets go of the file: what is still on its way is dropped.
    video.removeAttribute("src");
    video.load();
  };
  const timer = setTimeout(end, STILL_WAIT);
  filming.set(src, end);
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.onerror = end;
  video.onloadeddata = () => {
    const scale = Math.min(1, STILL_WIDTH / (video.videoWidth || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const pen = canvas.getContext("2d");
    if (!pen || !canvas.width || !canvas.height) return end();
    try {
      pen.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      return end();
    }
    end();
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        stills.set(src, URL.createObjectURL(blob));
        if (stills.size > STILLS_KEPT) {
          const [oldest, url] = stills.entries().next().value as [string, string];
          stills.delete(oldest);
          URL.revokeObjectURL(url);
        }
      },
      "image/jpeg",
      0.85,
    );
  };
  video.src = `${src}#t=${STILL_AT}`;
}

/** The pictures of first pages that have arrived, by address: one of these is drawn in the frame it is asked for. */
const sheets = new Set<string>();

/** The pictures of first pages that the server could not draw because the PDF is damaged, by address. */
const damaged = new Set<string>();
const asked = new Set<string>();
/** Told when a verdict on a first page comes in: see `Page`. */
const verdicts = new Set<() => void>();

/**
 * Learns whether a first page that did not arrive is for a damaged PDF: the server says so in a header on its
 * empty answer. A damaged PDF is shown as a card, and the browser's viewer is never started on it, since the
 * viewer's own error dialog takes the focus and the keys with it.
 */
function learnDamaged(sheet: string): void {
  if (!sheet || asked.has(sheet)) return;
  asked.add(sheet);
  fetch(sheet)
    .then((response) => {
      if (response.headers.get("x-okfs-pdf") !== "damaged") return;
      damaged.add(sheet);
      for (const heard of verdicts) heard();
    })
    .catch(() => undefined);
}

/**
 * A frame never takes the focus from the list by itself. The viewer of a PDF can do it, when it shows an error,
 * and every key then goes into the frame. Focus that moves into a frame without a click in it or a Tab is
 * taken back. A touch screen has no keys to lose.
 */
let tabbed = 0;
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Tab") tabbed = event.timeStamp;
  },
  true,
);
if (typeof window !== "undefined") {
  window.addEventListener("blur", () => {
    const frame = document.activeElement;
    if (!(frame instanceof HTMLIFrameElement) || !frame.classList.contains("pv-frame")) return;
    if (frame.matches(":hover") || matchMedia("(pointer: coarse)").matches || performance.now() - tabbed < 500) return;
    // Not within the blur itself: the focus is still on its way into the frame then.
    setTimeout(() => {
      if (document.activeElement !== frame) return;
      frame.blur();
      window.focus();
    }, 0);
  });
}

/**
 * Where the first page of a PDF is had as a picture, wide enough for the pane, or nothing when the server
 * draws none. The address moves when the file is rewritten, as a thumbnail's does.
 */
function sheetOf(entry: Entry): string {
  if (!config.pdf || entry.kind !== "pdf") return "";
  const pane = document.querySelector(".pv")?.clientWidth ?? 0;
  return urls.thumb(entry.path, pane * (window.devicePixelRatio || 1) > 800 ? 1280 : 640, entry.mtime, entry.size);
}

/**
 * Asks for what lies past the cursor in the direction it moves, so that it is here before the cursor is: the
 * preview of each file, in the form `source` says it is shown in. With `columns` it is also the columns of each
 * folder, as `columns` says where the cursor was in the folders it left. `stamp` gives the stamp a picture is
 * loaded under.
 */
export function lookAhead(
  entries: Entry[],
  cursor: number,
  step: 1 | -1,
  stamp: (entry: Entry) => string,
  columns: Left | null,
  source: (entry: Entry) => boolean,
): void {
  // Text files whose start is not known and not on its way, nearest first.
  const unknown: { url: string; path: string; source: boolean }[] = [];
  let nearest = 0;
  for (let i = 1; i <= AHEAD; i++) {
    const entry = entries[cursor + step * i];
    if (!entry) break;
    if (entry.dir) {
      if (columns && flights.size < FLIGHTS) ask(columnsUrl(entry.path, [], columns)).catch(() => undefined);
      continue;
    }
    const raw = source(entry);
    const url = addressOf(entry, raw);
    if (url !== null && url === startUrl(entry.path, raw && hasSource(entry))) {
      if (answers.get(url) !== undefined || flights.has(url)) continue;
      if (!unknown.length) nearest = i;
      unknown.push({ url, path: entry.path, source: raw && hasSource(entry) });
    } else if (url) {
      if (flights.size < FLIGHTS) ask(url).catch(() => undefined);
    } else if (entry.kind === "video") {
      if (i <= AHEAD_STILLS) film(`${urls.raw(entry.path)}?v=${stamp(entry)}`);
    } else if ((entry.kind === "image" || sheetOf(entry)) && i <= AHEAD_PICTURES) {
      // A PDF's first page is a picture like any other: see `Page`.
      const sheet = sheetOf(entry);
      const src = sheet || pictureSrc(entry, stamp(entry));
      let picture = pictures.find((kept) => kept.getAttribute("src") === src);
      if (!picture) {
        picture = new Image();
        if (sheet) {
          picture.onload = () => sheets.add(sheet);
          picture.onerror = () => learnDamaged(sheet);
        }
        picture.src = src;
        pictures.push(picture);
        if (pictures.length > AHEAD_PICTURES * 2) pictures.shift();
      }
      if (i <= AHEAD_UNPACKED) unpack(picture);
    }
  }
  // One request for all of them, once half of what lies ahead is unknown or the cursor is about to reach
  // it. A request for each file needs several turns of the page to land, and a held key leaves it few.
  if (!unknown.length || (unknown.length < AHEAD / 2 && nearest > 3)) return;
  // The files shown as their source are asked for in a request of their own: a request has one form.
  for (const sources of [false, true]) {
    const group = unknown.filter((file) => file.source === sources);
    if (!group.length) continue;
    const flight = { abort: new AbortController(), done: Promise.resolve() as Promise<unknown> };
    const all = getJson<Record<string, unknown>>(urls.previews(group.map((file) => file.path), FIRST_LINES, sources), flight.abort.signal);
    for (const file of group) {
      const one = { abort: flight.abort, done: flight.done };
      one.done = all
        .then((found) => {
          const data = found[file.path];
          if (data === undefined) throw new Error("no preview");
          if (flights.get(file.url)?.abort === one.abort) remember(file.url, data);
          return data;
        })
        .finally(() => land(file.url, one));
      one.done.catch(() => undefined);
      flights.set(file.url, one);
    }
  }
}

interface Loaded<T> {
  /** The address `data` came from. It trails `url` while a newer answer is on its way. */
  url: string;
  data?: T;
  failed?: boolean;
  /** It failed because okfs did not answer, or refused the key, and which: the file may be fine. */
  unanswered?: Unreached;
}

/**
 * Fetches JSON for the pane. Keeps the last answer on screen until the next one arrives.
 *
 * Without `wait` the request goes out in the task of the move that asked for it, and outlives the move: see
 * `ask`. With `wait` it goes out that many ms later and is cancelled when the address changes first. That is
 * for what is costly and seldom wanted twice: a tile scrolled past, the whole of a large file.
 *
 * Without an address nothing is asked for and nothing is kept on screen.
 */
export function useLoaded<T>(address: string | null, wait?: number): Loaded<T> {
  const url = address ?? "";
  const [state, setState] = useState<Loaded<T>>({ url, data: answers.get(url) as T | undefined });
  // Counts the times the answers were dropped while this was on screen. Each one asks again.
  const [dropped, setDropped] = useState(0);
  const asker = useRef({ url, again: () => setDropped((count) => count + 1) });
  asker.current.url = url;
  useEffect(() => {
    const self = asker.current;
    askers.add(self);
    return () => {
      askers.delete(self);
    };
  }, []);
  // A layout effect runs with the draw that changed the address. A plain effect waits for the next paint,
  // which is half of the time a file has under a held key.
  useLayoutEffect(() => {
    if (!url) {
      setState((old) => (old.url || old.data !== undefined ? { url } : old));
      return;
    }
    const known = answers.get(url) as T | undefined;
    if (known !== undefined) {
      setState({ url, data: known });
      return;
    }
    let here = true;
    const abort = new AbortController();
    const take = (asked: Promise<T>) =>
      asked.then(
        (data) => {
          if (here) setState({ url, data });
        },
        (error: unknown) => {
          // A request that was cancelled or pushed out says nothing about the file.
          if (here && !abort.signal.aborted && answers.get(url) === undefined && !flights.has(url)) {
            setState({ url, failed: true, unanswered: error instanceof NoAnswer ? error.why : undefined });
          }
        },
      );
    const timer =
      wait === undefined
        ? (take(ask<T>(url)), undefined)
        : setTimeout(() => {
            take(
              getJson<T>(url, abort.signal).then((data) => {
                remember(url, data);
                return data;
              }),
            );
          }, wait);
    const clear = setTimeout(() => setState((old) => (old.url === url ? old : { url: old.url })), STALE);
    return () => {
      here = false;
      clearTimeout(timer);
      clearTimeout(clear);
      abort.abort();
    };
  }, [url, wait, dropped]);
  // An answer that is kept is drawn with the move itself, not one draw later.
  const known = answers.get(url) as T | undefined;
  if (known !== undefined && state.url !== url) return { url, data: known };
  return state;
}

/** True once `key` has stayed the same for a moment. */
export function useSettled(key: string, delay: number): boolean {
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettled(key), delay);
    return () => clearTimeout(timer);
  }, [key, delay]);
  return settled === key;
}

/** True while a key is held down and repeating: the cursor is passing files, not stopping on them. */
let held = false;
/** True while a key is held down and repeating, as `held` is: the panes do not slide under it. */
export const keyHeld = (): boolean => held;
/** True while it repeats faster than `AHEAD_PAGES_PACE`. */
let racing = false;
let pressed = 0;
// Heard on the way down, before the key moves the cursor: what it brings on screen then knows.
document.addEventListener(
  "keydown",
  (event) => {
    held = event.repeat;
    racing = held && event.timeStamp - pressed < AHEAD_PAGES_PACE;
    pressed = event.timeStamp;
  },
  true,
);
document.addEventListener(
  "keyup",
  () => {
    held = false;
    racing = false;
  },
  true,
);

/** Where the cursor is in its folder and which way it last moved: what `Page` loads ahead from. */
let near: { entries: Entry[]; cursor: number; step: 1 | -1; stamp: (entry: Entry) => string; source: (entry: Entry) => boolean } | null = null;
const nearby = new Set<() => void>();

/** Tells the pane where the cursor is, so the pages past it can be loaded before it gets there. */
export function pagesAhead(entries: Entry[], cursor: number, step: 1 | -1, stamp: (entry: Entry) => string, source: (entry: Entry) => boolean): void {
  near = { entries, cursor, step, stamp, source };
  for (const heard of nearby) heard();
}

/**
 * True once a frame or a player may start. That is with the move itself, by a click or one press of a key.
 * Under a held key it waits: see `SETTLE_HEAVY`. For a component that is made anew for each file.
 */
function useUnhurried(): boolean {
  const [go, setGo] = useState(!held);
  useEffect(() => {
    if (go) return;
    const start = () => setGo(true);
    const timer = setTimeout(start, SETTLE_HEAVY);
    document.addEventListener("keyup", start);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keyup", start);
    };
  }, [go]);
  return go;
}

/**
 * The same for a component that goes from file to file: true once what is heavy for the file at `path` may
 * start. `eager` starts it with the move even under a held key. What has started stays started.
 */
export function useStarted(path: string, eager: boolean): boolean {
  const started = useRef("");
  const [released, setReleased] = useState("");
  if (!held || eager) started.current = path;
  const go = started.current === path || released === path;
  useEffect(() => {
    if (go) return;
    const start = () => setReleased(path);
    const timer = setTimeout(start, SETTLE_HEAVY);
    document.addEventListener("keyup", start);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keyup", start);
    };
  }, [go, path]);
  return go;
}

/** A picture or a player, in the middle of the pane on a sunken ground. */
const CENTER = "grid min-h-0 flex-1 place-items-center overflow-hidden bg-sunken p-[calc(var(--pad)*1.5)]";
const SHOWN_BOX = "block min-h-0 rounded-[min(var(--radius),4px)] object-contain";
const SHOWN = `${SHOWN_BOX} max-h-full max-w-full`;
/** A line under a preview: what of the file it leaves out. */
const NOTE = "flex-none border-t border-t-line px-(--pad) py-1.75 text-xs text-muted";
/** The rows of a table or an archive. The heads stay at the top as the rows scroll under them. */
const TABLE = "min-w-full border-separate border-spacing-0 text-s";
const CELL = "h-[calc(30px*var(--density))] px-(--pad) py-0 whitespace-nowrap";
const TH = `${CELL} sticky top-0 z-1 border-b border-b-line-strong bg-surface text-xs font-regular text-muted [text-transform:var(--label-case)]`;
const TD = `${CELL} border-b border-b-line`;
const TR = "hover:*:bg-hover";

/** `unreached` says the line is why okfs cannot be reached, and not something about the file. */
function Card({ entry, line, unreached }: { entry: Entry; line: string; unreached?: boolean }) {
  return (
    <div class={CENTER}>
      <div class="grid justify-items-center gap-1.5 text-center text-muted">
        <KindIcon kind={entry.kind} class="mb-2 size-10" />
        <b class="font-strong text-fg">{entry.name}</b>
        <span>
          {LABEL[entry.kind]} · {fmt.size(entry.size)}
        </span>
        <span>{line}</span>
        {/* Nothing downloads while okfs cannot be reached. */}
        {!unreached && (
          <a class="btn btn-line mt-3 no-underline" href={urls.raw(entry.path)} download>
            <Icon name="download" />
            Download
          </a>
        )}
      </div>
    </div>
  );
}

function Scroll({ id, children }: { id: string; children: ComponentChildren }) {
  // Keyed by what is shown, so each file starts scrolled to its top.
  return (
    <div class="pv-scroll min-h-0 flex-1 overflow-auto overscroll-contain" key={id}>
      {children}
    </div>
  );
}

/**
 * Where a picture is loaded from: the file itself, or what the server makes of it for a format a browser
 * cannot show. The stamp makes a rewritten picture a new address: a page keeps the pictures it has loaded by
 * address.
 */
const pictureSrc = (entry: Entry, stamp: string): string =>
  decodedByServer(entry) ? `${urls.picture(entry.path)}&v=${stamp}` : `${urls.raw(entry.path)}?v=${stamp}`;

/** How long the picture of the last file stays up while the next one loads: a held key does not flash. */
const PICTURE_KEEP = 150;
/** The smallest thumbnail: a few KB, so it lands in one round trip. */
const THUMB_WIDTH = 160;

function Picture({ entry, stamp, report }: Shown) {
  const src = pictureSrc(entry, stamp);
  const [broken, setBroken] = useState("");
  // The picture that has loaded last, and the one that has been waited for longer than `PICTURE_KEEP`.
  const [ready, setReady] = useState("");
  const [late, setLate] = useState("");
  const [thumbless, setThumbless] = useState("");
  useEffect(() => {
    if (ready === src) return;
    const timer = setTimeout(() => setLate(src), PICTURE_KEEP);
    return () => clearTimeout(timer);
  }, [src, ready]);
  // A picture that failed while okfs did not answer is asked for again once it does.
  const down = useDown();
  useEffect(() => {
    if (!down) setBroken("");
  }, [down]);
  if (broken === src) return <Card entry={entry} line={down ?? "This image could not be shown"} unreached={!!down} />;
  // The element is reused from file to file: the browser keeps the old picture up until the new one is ready.
  // That is for a moment only. Past it the old picture would sit under the new name, so it is hidden, and the
  // thumbnail of the right file stands in until the picture arrives.
  const waiting = ready !== src && late === src;
  const thumb = urls.thumb(entry.path, THUMB_WIDTH, entry.mtime, entry.size);
  return (
    <div class={CENTER}>
      {/* The last file's picture, held back once it would sit under the next file's name; the thumbnail of the right
          file takes its place. */}
      <img
        class={`${SHOWN} shadow-[0_1px_3px_rgb(0_0_0/0.2)] ${waiting ? "invisible [grid-area:1/1]" : ""}`}
        src={src}
        alt={entry.name}
        onLoad={(event) => {
          if (event.currentTarget.getAttribute("src") !== src) return;
          setReady(src);
          const { naturalWidth, naturalHeight } = event.currentTarget;
          if (naturalWidth) report(entry.path, [`${naturalWidth} × ${naturalHeight}`]);
        }}
        onError={() => setBroken(src)}
      />
      {waiting && thumbless !== thumb && <img class={`${SHOWN_BOX} size-full blur-[6px] [grid-area:1/1]`} src={thumb} alt="" aria-hidden="true" onError={() => setThumbless(thumb)} />}
    </div>
  );
}

/**
 * `waiting` keeps a video off screen until it has its first picture; it says so through `onReady`. `left` is
 * set on a player the cursor has left, kept up while the next preview gets ready.
 */
function Media({ entry, stamp, report, waiting, left, onReady }: Shown & { waiting: boolean; left?: boolean; onReady: () => void }) {
  const [broken, setBroken] = useState("");
  // A player the cursor left before it started stays as it is, a picture and no more: its file is not
  // asked for, which would take the line from the player the cursor is on.
  const unhurried = useUnhurried();
  const begun = useRef(false);
  if (unhurried && !left) begun.current = true;
  const settled = begun.current;
  // A rewritten file is loaded again only once nothing is playing: a player is never cut off.
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(stamp);
  useEffect(() => {
    if (!playing) setLoaded(stamp);
  }, [stamp, playing]);
  const address = `${urls.raw(entry.path)}?v=${loaded}`;
  const src = settled ? address : undefined;
  // A frame taken ahead of the cursor stands in the player until the player has a picture of its own: under
  // a held key, where the file is not loaded at all, and for the moment it takes to load after that.
  const [own, setOwn] = useState("");
  const still = own === address ? undefined : stills.get(address);
  // With the draw that starts the player, before its file is asked for.
  useLayoutEffect(() => {
    if (settled) hush();
  }, [settled]);
  // A file that failed while okfs did not answer is asked for again once it does.
  const down = useDown();
  useEffect(() => {
    if (!down) setBroken("");
  }, [down]);
  if (broken === src) return <Card entry={entry} line={down ?? "This browser cannot play this file"} unreached={!!down} />;
  // A player getting ready behind the preview before it, at the size it will be shown at.
  const center = waiting ? `${CENTER} invisible absolute inset-0` : CENTER;
  const state = { onPlay: () => setPlaying(true), onPause: () => setPlaying(false), onEnded: () => setPlaying(false) };
  const onError = () => {
    setPlaying(false);
    setBroken(src ?? "");
    onReady();
  };
  const onMeta = (event: { currentTarget: HTMLMediaElement }) => {
    const media = event.currentTarget;
    const frame = media instanceof HTMLVideoElement && media.videoWidth ? [`${media.videoWidth} × ${media.videoHeight}`] : [];
    report(entry.path, Number.isFinite(media.duration) ? [...frame, fmt.duration(media.duration)] : frame);
  };
  if (entry.kind === "audio") {
    return (
      <div class={center}>
        <div class="grid w-[min(100%,420px)] justify-items-center gap-5.5">
          <KindIcon kind="audio" class="size-11" />
          <audio class="w-full" src={src} controls preload="metadata" onLoadedMetadata={onMeta} onError={onError} {...state} />
        </div>
      </div>
    );
  }
  return (
    <div class={center}>
      <video
        class={SHOWN}
        src={src}
        poster={still}
        controls
        playsInline
        preload="metadata"
        onLoadedMetadata={onMeta}
        onLoadedData={() => {
          setOwn(address);
          onReady();
        }}
        onError={onError}
        {...state}
      />
    </div>
  );
}

/** One frame of the pane and the page it holds. */
interface Slot {
  id: number;
  path: string;
  size: number;
  /** A PDF, in the browser's own viewer: it needs no sandbox, and a frame is not passed on to or from one. */
  pdf: boolean;
  /** The address and stamp the frame was last sent to, or nothing while it is still empty. */
  sent: string;
  loaded: boolean;
  /** When its page loaded. */
  since: number;
  /** Since when the frame's picture may be of a page the cursor has left. */
  left: number;
  /** Since when it has been on screen with its page loaded, or 0. */
  rested: number;
}

const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms";

/**
 * Where a frame is sent for a file: the file itself, and for a PDF how its viewer opens. A sandboxed page sends
 * no cookie with what it asks for, so while okfs asks for a key a page goes by `urls.frame`, which sends it on
 * to an address that lets in the files beside it.
 */
const frameUrl = (entry: { path: string; kind: string }): string => {
  if (entry.kind === "pdf") return `${urls.raw(entry.path)}#navpanes=0&view=FitH`;
  return config.key ? urls.frame(entry.path) : urls.raw(entry.path);
};

/**
 * A PDF that the server found damaged is a card with a way to download it, and no frame: the browser's viewer
 * would show its own error dialog and keep the keys. Anything else is `Frames`.
 */
function Page({ entry, stamp }: { entry: Entry; stamp: string }) {
  const [, heard] = useState(0);
  useEffect(() => {
    const again = () => heard((count) => count + 1);
    verdicts.add(again);
    return () => {
      verdicts.delete(again);
    };
  }, []);
  if (damaged.has(sheetOf(entry))) return <Card entry={entry} line="This PDF could not be read" />;
  return <Frames entry={entry} stamp={stamp} />;
}

/**
 * An HTML page, live in a sandboxed frame, or a PDF in the browser's viewer.
 *
 * The frame on screen serves page after page: it is told to replace its page with the next, and the browser
 * keeps the old page's picture up until the new one has something to draw. So there is no empty pane between
 * two pages, and nothing here waits before the new page is shown.
 *
 * The pages just past the cursor are loaded ahead, each in a frame of its own that is hidden, not see-through:
 * exactly one frame is ever visible. When the cursor reaches such a page its frame is shown and the one before
 * is hidden in the same draw. A page loaded ahead runs its scripts before it is looked at.
 *
 * A PDF is loaded ahead the same way. Its frame is its own from start to end: a rewritten PDF loads in a second
 * frame behind the first and takes its place once it is ready, so a save never shows an empty pane.
 *
 * A PDF's viewer takes longer to start than a held key takes to pass it. Where the server draws first pages,
 * the picture of this one lies over the frames from the move itself until the viewer has drawn its own: it
 * is see-through until it has arrived, so nothing is shown later than it would be without it.
 */
function Frames({ entry, stamp }: { entry: Entry; stamp: string }) {
  const pdf = entry.kind === "pdf";
  const address = frameUrl(entry);
  // A rewritten file is the same address with a new stamp: it is loaded again.
  const want = `${address}\n${stamp}`;
  // Under a held key a large page waits, as a PDF does: see `EAGER_FRAME_BYTES`.
  const go = useStarted(entry.path, !pdf && entry.size < EAGER_FRAME_BYTES);

  const [drawn, draw] = useState(0);
  const again = () => draw((count) => count + 1);
  // True once the list has said where the cursor is since the last look: until then `near` may be a move old.
  const told = useRef(false);
  useEffect(() => {
    const heard = () => {
      told.current = true;
      again();
    };
    nearby.add(heard);
    return () => {
      nearby.delete(heard);
    };
  }, []);
  /** Every frame there is, in the order they were made: a frame that is moved loads its page again. */
  const slots = useRef<Slot[]>([]);
  const made = useRef(0);
  /** The frame on screen, if any. */
  const shown = useRef(-1);
  const frames = useRef(new Map<number, HTMLIFrameElement>());

  // With the draw that moved the cursor, as `useLoaded` asks: a plain effect would wait for the next paint.
  useLayoutEffect(() => {
    const now = performance.now();
    const before = slots.current.map((slot) => slot.id).join() + shown.current;
    const add = (file: Entry): Slot => {
      const slot = { id: made.current++, path: file.path, size: file.size, pdf: file.kind === "pdf", sent: "", loaded: false, since: 0, left: 0, rested: 0 };
      slots.current.push(slot);
      return slot;
    };
    const drop = (gone: Slot) => {
      slots.current = slots.current.filter((slot) => slot !== gone);
    };
    // `replace` takes the place of the page in a frame without adding to the back button's history, which
    // setting the frame's address would do.
    const send = (slot: Slot, to: string): boolean => {
      const frame = frames.current.get(slot.id);
      if (!frame) return false;
      const url = to.slice(0, to.indexOf("\n"));
      try {
        if (slot.sent) frame.contentWindow?.location.replace(new URL(url, location.href).href);
        else frame.src = url;
      } catch {
        return false;
      }
      slot.sent = to;
      slot.loaded = false;
      slot.rested = 0;
      return true;
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let later: ReturnType<typeof setTimeout> | undefined;
    let cur = slots.current.find((slot) => slot.id === shown.current);
    // A frame for the file on screen that is not the one on screen holds its rewritten self: it waits to be ready.
    const ahead = slots.current.find((slot) => slot !== cur && slot.path === entry.path && (cur?.path !== entry.path || slot.loaded));
    if (ahead) {
      // This page was loaded ahead: its frame is shown, whether or not a key is held.
      if (cur && cur.path !== entry.path) cur.left = 0;
      else if (cur) drop(cur);
      shown.current = ahead.id;
      cur = ahead;
      cur.rested = cur.loaded ? now : 0;
    } else if (!cur) {
      if (go) {
        cur = add(entry);
        shown.current = cur.id;
      }
    } else if (cur.path === entry.path) {
      // The file on screen was rewritten. A page loads again in its frame, which keeps the old picture up
      // until then. A PDF loads in a second frame, behind this one.
      if (cur.sent && cur.sent !== want) {
        if (!pdf) send(cur, want);
        else {
          // One frame behind it for the newest stamp: a frame for a stamp since passed is dropped.
          for (const slot of slots.current) if (slot !== cur && slot.path === entry.path && slot.sent && slot.sent !== want) drop(slot);
          if (!slots.current.some((slot) => slot !== cur && slot.path === entry.path)) add(entry);
        }
      }
    } else if (pdf || cur.pdf) {
      // To or from a PDF there is nothing to pass a frame on to: a new one, as ever.
      if (go) {
        drop(cur);
        cur = add(entry);
        shown.current = cur.id;
      } else {
        if (!cur.left) cur.left = now;
        timer = setTimeout(again, Math.max(0, cur.left + KEEP - now) + 1);
        if (now - cur.left > KEEP) {
          drop(cur);
          shown.current = -1;
          cur = undefined;
        }
      }
    } else {
      if (!cur.left) cur.left = now;
      if (!go) {
        // Nothing is on its way to take the old page's place: it goes when its time is up.
        timer = setTimeout(again, Math.max(0, cur.left + KEEP - now) + 1);
        if (now - cur.left > KEEP) {
          drop(cur);
          shown.current = -1;
          cur = undefined;
        }
      } else if (now - cur.left > KEEP) {
        drop(cur);
        cur = add(entry);
        shown.current = cur.id;
      } else if (send(cur, want)) {
        cur.path = entry.path;
        cur.size = entry.size;
      } else {
        drop(cur);
        cur = add(entry);
        shown.current = cur.id;
      }
    }

    // The pages to hold besides the one on screen: those just past the cursor, and the one it came from.
    const here = near && near.entries[near.cursor]?.path === entry.path ? near : null;
    if (here) {
      const keep = new Map<string, Entry>();
      let bytes = 0;
      let pdfs = 0;
      for (let i = 1; i <= AHEAD_PAGES; i++) {
        const next = here.entries[here.cursor + here.step * i];
        if (!next) break;
        if ((next.kind !== "html" && next.kind !== "pdf") || next.size > AHEAD_PAGE_BYTES) continue;
        // A page that is shown as its source is no page to load.
        if (next.kind === "html" && here.source(next)) continue;
        if (next.kind === "pdf" && damaged.has(sheetOf(next))) continue;
        if (next.kind === "pdf" && ++pdfs > AHEAD_PDFS) continue;
        if (bytes + next.size > AHEAD_PAGES_BYTES) break;
        bytes += next.size;
        keep.set(next.path, next);
      }
      const back = new Set<string>();
      for (let i = 1; i <= BEHIND_PAGES; i++) {
        const last = here.entries[here.cursor - here.step * i];
        if (last) back.add(last.path);
      }
      for (const slot of slots.current) {
        if (slot === cur || slot.path === entry.path) continue;
        const next = keep.get(slot.path);
        if (!next && !back.has(slot.path)) drop(slot);
        // A file loaded ahead that has been rewritten since is loaded again: a page in its frame, a PDF in a
        // new one, since its viewer would take the same address for the same file.
        else if (next && slot.sent && slot.sent !== `${frameUrl(next)}\n${here.stamp(next)}`) {
          if (slot.pdf) drop(slot);
          else send(slot, `${frameUrl(next)}\n${here.stamp(next)}`);
        }
      }
      // None are started before the page on screen has had its time: see `AHEAD_PAGES_REST`. And none while
      // the cursor is passing pages faster than they load.
      const missing = [...keep.values()].filter((next) => !slots.current.some((slot) => slot.path === next.path));
      if (missing.length && cur?.rested && !racing) {
        const wait = cur.rested + (cur.pdf ? AHEAD_PDF_REST : AHEAD_PAGES_REST) - now;
        if (wait > 0) later = setTimeout(again, wait + 1);
        else for (const next of missing) add(next);
      }
    } else if (told.current) {
      // The cursor is somewhere this folder's list does not say: only the page on screen is kept.
      for (const slot of slots.current) if (slot !== cur && slot.path !== entry.path) drop(slot);
    }
    told.current = false;

    // A frame that is new is sent to its page once it is in the document.
    for (const slot of slots.current) {
      if (slot.sent) continue;
      if (slot === cur || slot.path === entry.path) send(slot, want);
      else {
        const next = here?.entries.find((file) => file.path === slot.path);
        if (next && here) send(slot, `${frameUrl(next)}\n${here.stamp(next)}`);
      }
    }
    if (slots.current.map((slot) => slot.id).join() + shown.current !== before) again();
    return () => {
      clearTimeout(timer);
      clearTimeout(later);
    };
  }, [want, go, drawn, entry.path, entry.size]);

  const sheet = sheetOf(entry);
  const [torn, setTorn] = useState("");
  const [, arrived] = useState("");
  const on = slots.current.find((slot) => slot.id === shown.current);
  // A rewritten PDF keeps its old self up while the new one loads behind it: no picture goes over that.
  const viewed = on?.path === entry.path && on.loaded && performance.now() - on.since >= SHEET_KEEP;
  return (
    <>
      {sheet && sheet !== torn && !viewed && (
        // The first page of a PDF as a picture, over the frames until the viewer has drawn its own. As wide as the
        // pane, as the viewer shows it. See-through until the picture has arrived, and never in the way of the pointer.
        <div class={`pointer-events-none absolute inset-0 z-1 overflow-hidden p-2 ${sheets.has(sheet) ? "bg-sunken" : ""}`}>
          <img
            class="block w-full shadow-[0_1px_3px_rgb(0_0_0/0.2)]"
            key={sheet}
            src={sheet}
            alt=""
            onLoad={() => {
              sheets.add(sheet);
              arrived(sheet);
            }}
            onError={() => {
              setTorn(sheet);
              learnDamaged(sheet);
            }}
          />
        </div>
      )}
      {slots.current.map((slot) => (
        <iframe
          key={slot.id}
          ref={(frame) => {
            if (frame) frames.current.set(slot.id, frame);
            else frames.current.delete(slot.id);
          }}
          // A frame is see-through until its page has loaded, then white behind a page that sets no background. The
          // light scheme keeps the browser from painting a backdrop of its own behind the page in a dark theme. A page
          // loaded ahead of the cursor, or a PDF loading behind the one on screen, is in the pane and not visible.
          class={`pv-frame block min-h-0 w-full flex-1 border-0 scheme-light ${slot.id !== shown.current ? "pv-ahead invisible absolute inset-0 h-full" : slot.loaded ? "bg-[#fff]" : ""}`}
          // A served page runs in a sandbox: it gets an origin of its own and cannot reach the app.
          // The server sends the same restriction as a header, so it holds when the page is opened directly too.
          sandbox={slot.pdf ? undefined : SANDBOX}
          title={slot.path.slice(slot.path.lastIndexOf("/") + 1)}
          onLoad={() => {
            // An empty frame reports a load of its own, before it is sent anywhere.
            if (!slot.sent) return;
            slot.loaded = true;
            slot.since = performance.now();
            // The picture over a PDF goes once its viewer has had its time: see `SHEET_KEEP`.
            if (slot.pdf) setTimeout(again, SHEET_KEEP + 1);
            // The page under the cursor is the one in the frame again.
            if (slot.id === shown.current && slot.sent === want) {
              slot.left = 0;
              slot.rested = performance.now();
            }
            again();
          }}
        />
      ))}
    </>
  );
}

function Zip({ entry, report }: { entry: Entry; report: Report }) {
  const { data, failed, unanswered, url } = useLoaded<Archive>(urls.archive(entry.path));
  const rested = useSettled(entry.path, WHOLE_REST);
  const total = data?.total;
  useEffect(() => {
    if (total !== undefined && url === urls.archive(entry.path)) report(entry.path, [`${fmt.count(total)} ${total === 1 ? "entry" : "entries"}`]);
  }, [entry.path, total, url, report]);
  if (failed) return <Card entry={entry} line={unanswered ?? "This archive could not be read"} unreached={!!unanswered} />;
  if (!data) return null;
  return (
    <>
      <Scroll id={url}>
        <table class={TABLE}>
          <thead>
            <tr>
              <th class={`${TH} text-left`}>In this archive</th>
              <th class={`${TH} text-right`}>Size</th>
            </tr>
          </thead>
          <tbody>
            {(rested ? data.entries : data.entries.slice(0, FIRST_ROWS)).map((item) => (
              <tr class={TR} key={item.name}>
                <td class={`${TD} text-left`}>{item.name}</td>
                <td class={`${TD} num text-right`}>{item.dir ? "" : fmt.size(item.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
      {data.total > data.entries.length && (
        <div class={NOTE}>
          Showing the first {fmt.count(data.entries.length)} of {fmt.count(data.total)} entries.
        </div>
      )}
    </>
  );
}

function JsonLeaf({ value }: { value: unknown }) {
  if (typeof value === "string") return <span class="tk-s">"{value}"</span>;
  if (typeof value === "number") return <span class="tk-n">{String(value)}</span>;
  return <span class="tk-k">{String(value)}</span>;
}

function JsonBranch({ value, label, depth }: { value: object; label: ComponentChildren; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const [shown, setShown] = useState(JSON_PAGE);
  const list = Array.isArray(value);
  const keys = Object.keys(value);
  const rest = keys.length - shown;
  return (
    <details class="pl-[1.3em]" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary class="-ml-[1.3em] cursor-pointer [list-style:none] before:inline-block before:w-[1.3em] before:text-faint before:content-['▸'] [details[open]>&]:before:content-['▾'] [&::-webkit-details-marker]:hidden">
        {label}
        <span class="text-faint">{list ? `[ ${keys.length} ]` : `{ ${keys.length} }`}</span>
      </summary>
      {/* Children are built only once a branch is open, so a large file stays light. */}
      {open &&
        keys.slice(0, shown).map((key) => (
          <JsonNode key={key} name={list ? undefined : key} value={(value as Record<string, unknown>)[key]} depth={depth + 1} />
        ))}
      {open && rest > 0 && (
        <button class="btn btn-line my-1 ml-[1.3em]" onClick={() => setShown(shown + JSON_PAGE * 5)}>
          Show {fmt.count(Math.min(rest, JSON_PAGE * 5))} more of {fmt.count(rest)}
        </button>
      )}
    </details>
  );
}

function JsonNode({ value, name, depth }: { value: unknown; name?: string; depth: number }) {
  const label = name === undefined ? null : (
    <>
      <span class="text-(color:--syn-title)">{name}</span>:{" "}
    </>
  );
  if (value !== null && typeof value === "object") return <JsonBranch value={value} label={label} depth={depth} />;
  return (
    <div class="pl-[1.3em]">
      {label}
      <JsonLeaf value={value} />
    </div>
  );
}

/** Links in rendered Markdown that lead elsewhere open in a new tab; the rest stay in okfs. */
function onProseClick(event: MouseEvent): void {
  const link = (event.target as Element).closest("a");
  if (!link || link.host === location.host) return;
  event.preventDefault();
  window.open(link.href, "_blank", "noopener");
}

export function Prose({ html, class: extra }: { html: string; class?: string }) {
  return <article class={extra ? `md ${extra}` : "md"} onClick={onProseClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A text file as what is made from it, or with `source` as it is written: its text as source code. */
function Text({ entry, report, source, wrap }: { entry: Entry; report: Report; source?: boolean; wrap?: boolean }) {
  // The start of the file comes first. The whole of it is asked for once the cursor has rested, and only
  // when the start says there is more: a short file, a table and a Markdown file are whole already.
  const whole = source ? urls.source(entry.path) : urls.preview(entry.path);
  const start = startOf(whole);
  const rested = useSettled(entry.path, WHOLE_REST);
  const head = useLoaded<TextPreview>(start);
  const cut = head.url === start && head.data?.kind === "code" && head.data.more === true;
  const wanted = cut && (rested || answers.has(whole));
  const rest = useLoaded<TextPreview>(wanted ? whole : start, wanted ? 0 : undefined);
  const { data, failed, unanswered, url: from } = wanted && rest.url === whole && rest.data ? rest : head;
  // A preview is known by the file's address whichever part is shown, so the pane keeps its scroll
  // position when the whole file takes the place of its start.
  const url = from.replace(/&lines=\d+$/, "");
  useEffect(() => {
    if (!data || url !== whole) return;
    if (data.kind === "table") report(entry.path, [`${fmt.count(data.total)} ${data.total === 1 ? "row" : "rows"}`]);
    // Only the start of a cut file is counted, which says nothing of the whole of it.
    else if (data.kind !== "none" && !(data.kind === "code" && data.cut)) {
      report(entry.path, [`${fmt.count(data.lines)} ${data.lines === 1 ? "line" : "lines"}`]);
    }
  }, [entry.path, data, url, whole, report]);

  if (failed) return <Card entry={entry} line={unanswered ?? "This file could not be read"} unreached={!!unanswered} />;
  if (!data) return null;
  switch (data.kind) {
    case "none":
      // A card names its file, so it is never shown for the one before.
      if (url !== whole) return null;
      return <Card entry={entry} line="No preview for this type" />;
    case "markdown":
      return (
        <Scroll id={url}>
          <Prose html={data.html} />
        </Scroll>
      );
    case "code":
      return (
        <>
          <Scroll id={url}>
            <pre class={wrap ? "code wrap" : "code"} style={{ "--ln": `${Math.max(3, String(data.lines).length)}ch` }}>
              <code dangerouslySetInnerHTML={{ __html: data.html }} />
            </pre>
          </Scroll>
          {data.cut && url === whole && <div class={NOTE}>Showing the start of this {fmt.size(entry.size)} file.</div>}
        </>
      );
    case "json":
      return (
        <Scroll id={url}>
          <div class="p-(--pad) pb-12 [font:calc(var(--text)*0.92)/1.7_var(--font-mono)] tracking-[0]">
            <JsonNode value={JSON.parse(data.text)} depth={0} />
          </div>
        </Scroll>
      );
    case "table":
      return (
        <>
          <Scroll id={url}>
            <table class={TABLE}>
              <thead>
                <tr>
                  <th class={`${TH} text-right`}>#</th>
                  {data.head.map((name, column) => (
                    <th class={`${TH} ${data.numeric[column] ? "text-right" : "text-left"}`}>{name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(rested ? data.rows : data.rows.slice(0, FIRST_ROWS)).map((row, at) => (
                  <tr class={TR}>
                    <td class={`${TD} num w-[1%] text-right text-faint`}>{at + 1}</td>
                    {row.map((value, column) => (
                      <td class={data.numeric[column] ? `${TD} num text-right` : `${TD} text-left`}>{value}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
          {data.total > data.rows.length && (
            <div class={NOTE}>
              Showing the first {fmt.count(data.rows.length)} of {fmt.count(data.total)} rows.
            </div>
          )}
        </>
      );
  }
}

/** `stamp` changes when the file is rewritten: what is loaded by address is then loaded again. */
interface Shown {
  entry: Entry;
  stamp: string;
  report: Report;
  /** Show the file's source in place of what is made from it. Only a file with both has it: see `hasSource`. */
  raw?: boolean;
  /** Wrap the lines of a source at the edge of the pane. */
  wrap?: boolean;
}

function Kind({ entry, stamp, report, raw, wrap, waiting, left, onReady }: Shown & { waiting: boolean; left?: boolean; onReady: () => void }) {
  // The bytes as they are, colored and never run: the same answer for a page, a drawing, a table.
  if (raw && hasSource(entry)) return <Text entry={entry} report={report} source wrap={wrap} />;
  switch (entry.kind) {
    case "folder":
      // A folder has columns of its own beside the list: see `Side`.
      return null;
    case "image":
      return <Picture entry={entry} stamp={stamp} report={report} />;
    case "video":
    case "audio":
      return <Media entry={entry} stamp={stamp} report={report} waiting={waiting} left={left} onReady={onReady} />;
    case "pdf":
    case "html":
      return <Page entry={entry} stamp={stamp} />;
    case "archive":
      if (entry.ext === "zip") return <Zip entry={entry} report={report} />;
      return <Card entry={entry} line="No preview for this type" />;
    default:
      return <Text entry={entry} report={report} wrap={wrap} />;
  }
}

/**
 * What tells one preview from the next. A player is made anew for each file. Every other kind
 * goes from file to file as it is, which is how a page, a picture and a text keep the last one up until the
 * next is here: see `Page`, `Picture` and `useLoaded`.
 */
const slot = (entry: Entry): string => (entry.kind === "video" || entry.kind === "audio" ? entry.path : "");

export function Preview(props: Shown) {
  const { entry } = props;
  // A video has nothing to show until its first picture is here. The preview before it stays up until then,
  // or until `KEEP` is over, and the player takes its place at that moment: the picture is never shown later
  // than it would be. A sound player looks the same before and after its file answers, so it is shown at once.
  const last = useRef(props);
  const [ready, setReady] = useState("");
  // A video whose picture was taken ahead of the cursor has that to show, and waits for nothing.
  const still = entry.kind === "video" && stills.has(`${urls.raw(entry.path)}?v=${props.stamp}`);
  const waiting = entry.kind === "video" && !still && ready !== entry.path && last.current.entry.path !== entry.path;
  if (!waiting) last.current = props;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setReady(entry.path), KEEP);
    return () => clearTimeout(timer);
  }, [waiting, entry.path]);
  return (
    <>
      {waiting && <Kind key={slot(last.current.entry)} {...last.current} waiting={false} left onReady={() => undefined} />}
      <Kind key={slot(entry)} {...props} waiting={waiting} onReady={() => setReady(entry.path)} />
    </>
  );
}
