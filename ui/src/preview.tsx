// What the right pane shows for the file or folder under the cursor.

import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type Archive, type Listing, type TextPreview, getJson, pathOf, urls } from "./api";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { LABEL, kindOf } from "./kinds";
import type { Entry } from "./store";

/**
 * Frames and players cost a lot to start. Under a held key, which passes a file faster than one can start,
 * they wait until the key is up or the cursor has stopped for this long.
 */
const SETTLE_HEAVY = 90;
/** After this long without an answer, the previous file's preview is cleared instead of kept. */
const STALE = 250;
/** Children of one JSON object or array shown before "show more". */
const JSON_PAGE = 200;
/** Entries listed for a folder under the cursor. */
const FOLDER_PEEK = 14;
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
const AHEAD_PICTURES = 3;
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
  flight.done = getJson<T>(url, flight.abort.signal)
    .then((data) => {
      // An answer to a request that was dropped describes a file that has changed since.
      if (flights.get(url)?.abort === flight.abort) remember(url, data);
      return data;
    })
    .finally(() => land(url, flight));
  flights.set(url, flight);
  return flight.done as Promise<T>;
}

/** The start of a text file: what the pane asks for first. */
const startUrl = (path: string): string => `${urls.preview(path)}&lines=${FIRST_LINES}`;

/** Pictures loaded ahead of the cursor, held so the browser keeps them. */
const pictures: HTMLImageElement[] = [];

/** The JSON the pane asks for when the cursor is on `entry`, if it asks for any. */
function addressOf(entry: Entry): string | null {
  switch (entry.kind) {
    case "folder":
      return urls.list(entry.path, FOLDER_PEEK);
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

/**
 * Asks for what lies past the cursor in the direction it moves, so a preview is here before the cursor is.
 * `stamp` gives the stamp a picture is loaded under.
 */
export function lookAhead(entries: Entry[], cursor: number, step: 1 | -1, stamp: (entry: Entry) => string): void {
  // Text files whose start is not known and not on its way, nearest first.
  const unknown: { url: string; path: string }[] = [];
  let nearest = 0;
  for (let i = 1; i <= AHEAD; i++) {
    const entry = entries[cursor + step * i];
    if (!entry) break;
    const url = addressOf(entry);
    if (url === startUrl(entry.path)) {
      if (answers.get(url) !== undefined || flights.has(url)) continue;
      if (!unknown.length) nearest = i;
      unknown.push({ url, path: entry.path });
    } else if (url) {
      if (flights.size < FLIGHTS) ask(url).catch(() => undefined);
    } else if (entry.kind === "image" && i <= AHEAD_PICTURES) {
      const src = `${urls.raw(entry.path)}?v=${stamp(entry)}`;
      if (pictures.some((picture) => picture.getAttribute("src") === src)) continue;
      const picture = new Image();
      picture.src = src;
      pictures.push(picture);
      if (pictures.length > AHEAD_PICTURES * 2) pictures.shift();
    }
  }
  // One request for all of them, once half of what lies ahead is unknown or the cursor is about to reach
  // it. A request for each file needs several turns of the page to land, and a held key leaves it few.
  if (!unknown.length || (unknown.length < AHEAD / 2 && nearest > 3)) return;
  const flight = { abort: new AbortController(), done: Promise.resolve() as Promise<unknown> };
  const all = getJson<Record<string, unknown>>(urls.previews(unknown.map((file) => file.path), FIRST_LINES), flight.abort.signal);
  for (const file of unknown) {
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

interface Loaded<T> {
  /** The address `data` came from. It trails `url` while a newer answer is on its way. */
  url: string;
  data?: T;
  failed?: boolean;
}

/**
 * Fetches JSON for the pane. Keeps the last answer on screen until the next one arrives.
 *
 * Without `wait` the request goes out in the task of the move that asked for it, and outlives the move: see
 * `ask`. With `wait` it goes out that many ms later and is cancelled when the address changes first. That is
 * for what is costly and seldom wanted twice: a tile scrolled past, the whole of a large file.
 */
export function useLoaded<T>(url: string, wait?: number): Loaded<T> {
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
        () => {
          // A request that was cancelled or pushed out says nothing about the file.
          if (here && !abort.signal.aborted && answers.get(url) === undefined && !flights.has(url)) setState({ url, failed: true });
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
function useSettled(key: string, delay: number): boolean {
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettled(key), delay);
    return () => clearTimeout(timer);
  }, [key, delay]);
  return settled === key;
}

/** True while a key is held down and repeating: the cursor is passing files, not stopping on them. */
let held = false;
// Heard on the way down, before the key moves the cursor: what it brings on screen then knows.
document.addEventListener(
  "keydown",
  (event) => {
    held = event.repeat;
  },
  true,
);
document.addEventListener(
  "keyup",
  () => {
    held = false;
  },
  true,
);

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

function Card({ entry, line }: { entry: Entry; line: string }) {
  return (
    <div class="pv-center">
      <div class="pv-card">
        <KindIcon kind={entry.kind} />
        <b>{entry.name}</b>
        <span>
          {LABEL[entry.kind]} · {fmt.size(entry.size)}
        </span>
        <span>{line}</span>
        <a class="btn btn-line" href={urls.raw(entry.path)} download>
          <Icon name="download" />
          Download
        </a>
      </div>
    </div>
  );
}

function Scroll({ id, children }: { id: string; children: ComponentChildren }) {
  // Keyed by what is shown, so each file starts scrolled to its top.
  return (
    <div class="pv-scroll" key={id}>
      {children}
    </div>
  );
}

function Folder({ entry, report }: { entry: Entry; report: Report }) {
  const { data, url } = useLoaded<Listing>(urls.list(entry.path, FOLDER_PEEK));
  const total = data?.total;
  useEffect(() => {
    if (total !== undefined && url === urls.list(entry.path, FOLDER_PEEK)) report(entry.path, [fmt.items(total)]);
  }, [entry.path, total, url, report]);
  if (!data) return null;
  const more = data.total - data.entries.length;
  return (
    <Scroll id={url}>
      <div class="pv-dir">
        <div class="hd">
          <b>{data.path.slice(data.path.lastIndexOf("/") + 1)}</b>
          <span class="label">{fmt.items(data.total)}</span>
        </div>
        {data.entries.map((item) => (
          <div class="it" key={item.n}>
            <KindIcon kind={kindOf(item.n, item.d === true)} />
            <span class="trunc">{item.n}</span>
            <span class="sz num">{item.d ? (item.c === undefined ? "" : fmt.count(item.c)) : fmt.size(item.s)}</span>
          </div>
        ))}
        {more > 0 && (
          <div class="it">
            <span class="label">and {fmt.count(more)} more</span>
          </div>
        )}
        {data.total === 0 && (
          <div class="it">
            <span class="label">This folder is empty.</span>
          </div>
        )}
      </div>
    </Scroll>
  );
}

function Picture({ entry, stamp, report }: { entry: Entry; stamp: string; report: Report }) {
  // The stamp makes a rewritten picture a new address: a page keeps the pictures it has loaded by address.
  const src = `${urls.raw(entry.path)}?v=${stamp}`;
  const [broken, setBroken] = useState("");
  if (broken === src) return <Card entry={entry} line="This image could not be shown" />;
  // The element is reused from file to file: the browser keeps the old picture up until the new one is ready.
  return (
    <div class="pv-center">
      <img
        src={src}
        alt={entry.name}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          if (naturalWidth) report(entry.path, [`${naturalWidth} × ${naturalHeight}`]);
        }}
        onError={() => setBroken(src)}
      />
    </div>
  );
}

function Media({ entry, stamp, report }: { entry: Entry; stamp: string; report: Report }) {
  const [broken, setBroken] = useState("");
  const settled = useUnhurried();
  // A rewritten file is loaded again only once nothing is playing: a player is never cut off.
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(stamp);
  useEffect(() => {
    if (!playing) setLoaded(stamp);
  }, [stamp, playing]);
  const src = settled ? `${urls.raw(entry.path)}?v=${loaded}` : undefined;
  if (broken === src) return <Card entry={entry} line="This browser cannot play this file" />;
  const state = { onPlay: () => setPlaying(true), onPause: () => setPlaying(false), onEnded: () => setPlaying(false) };
  const onError = () => {
    setPlaying(false);
    setBroken(src ?? "");
  };
  const onMeta = (event: { currentTarget: HTMLMediaElement }) => {
    const media = event.currentTarget;
    const frame = media instanceof HTMLVideoElement && media.videoWidth ? [`${media.videoWidth} × ${media.videoHeight}`] : [];
    report(entry.path, Number.isFinite(media.duration) ? [...frame, fmt.duration(media.duration)] : frame);
  };
  if (entry.kind === "audio") {
    return (
      <div class="pv-center">
        <div class="pv-audio">
          <KindIcon kind="audio" />
          <audio src={src} controls preload="metadata" onLoadedMetadata={onMeta} onError={onError} {...state} />
        </div>
      </div>
    );
  }
  return (
    <div class="pv-center">
      <video src={src} controls playsInline preload="metadata" onLoadedMetadata={onMeta} onError={onError} {...state} />
    </div>
  );
}

function Frame({ entry, stamp }: { entry: Entry; stamp: string }) {
  const settled = useUnhurried();
  // A rewritten file loads in a frame of its own, behind the one on screen, and takes its place once it
  // is ready: a save never shows an empty pane.
  const [shown, setShown] = useState(stamp);
  // Until the first frame has loaded, the pane shows through it: the wait for a page is never white.
  const [loaded, setLoaded] = useState(false);
  if (!settled) return null;
  const html = entry.kind === "html";
  return (
    <>
      {(stamp === shown ? [shown] : [shown, stamp]).map((version) => (
        <iframe
          key={version}
          class={version !== shown ? "pv-frame pv-next" : loaded ? "pv-frame pv-loaded" : "pv-frame"}
          // A served page runs in a sandbox: it gets an origin of its own and cannot reach the app.
          // The server sends the same restriction as a header, so it holds when the page is opened directly too.
          sandbox={html ? "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms" : undefined}
          src={html ? urls.raw(entry.path) : `${urls.raw(entry.path)}#navpanes=0&view=FitH`}
          title={entry.name}
          onLoad={version === shown ? () => setLoaded(true) : () => setShown(version)}
        />
      ))}
    </>
  );
}

function Zip({ entry, report }: { entry: Entry; report: Report }) {
  const { data, failed, url } = useLoaded<Archive>(urls.archive(entry.path));
  const rested = useSettled(entry.path, WHOLE_REST);
  const total = data?.total;
  useEffect(() => {
    if (total !== undefined && url === urls.archive(entry.path)) report(entry.path, [`${fmt.count(total)} ${total === 1 ? "entry" : "entries"}`]);
  }, [entry.path, total, url, report]);
  if (failed) return <Card entry={entry} line="This archive could not be read" />;
  if (!data) return null;
  return (
    <>
      <Scroll id={url}>
        <table class="tbl">
          <thead>
            <tr>
              <th>In this archive</th>
              <th class="r">Size</th>
            </tr>
          </thead>
          <tbody>
            {(rested ? data.entries : data.entries.slice(0, FIRST_ROWS)).map((item) => (
              <tr key={item.name}>
                <td>{item.name}</td>
                <td class="r num">{item.dir ? "" : fmt.size(item.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
      {data.total > data.entries.length && (
        <div class="pv-note">
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
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {label}
        <span class="cnt">{list ? `[ ${keys.length} ]` : `{ ${keys.length} }`}</span>
      </summary>
      {/* Children are built only once a branch is open, so a large file stays light. */}
      {open &&
        keys.slice(0, shown).map((key) => (
          <JsonNode key={key} name={list ? undefined : key} value={(value as Record<string, unknown>)[key]} depth={depth + 1} />
        ))}
      {open && rest > 0 && (
        <button class="btn btn-line more" onClick={() => setShown(shown + JSON_PAGE * 5)}>
          Show {fmt.count(Math.min(rest, JSON_PAGE * 5))} more of {fmt.count(rest)}
        </button>
      )}
    </details>
  );
}

function JsonNode({ value, name, depth }: { value: unknown; name?: string; depth: number }) {
  const label = name === undefined ? null : (
    <>
      <span class="key">{name}</span>:{" "}
    </>
  );
  if (value !== null && typeof value === "object") return <JsonBranch value={value} label={label} depth={depth} />;
  return (
    <div class="leaf">
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

function Text({ entry, report }: { entry: Entry; report: Report }) {
  // The start of the file comes first. The whole of it is asked for once the cursor has rested, and only
  // when the start says there is more: a short file, a table and a Markdown file are whole already.
  const whole = urls.preview(entry.path);
  const start = startUrl(entry.path);
  const rested = useSettled(entry.path, WHOLE_REST);
  const head = useLoaded<TextPreview>(start);
  const cut = head.url === start && head.data?.kind === "code" && head.data.more === true;
  const wanted = cut && (rested || answers.has(whole));
  const rest = useLoaded<TextPreview>(wanted ? whole : start, wanted ? 0 : undefined);
  const { data, failed, url: from } = wanted && rest.url === whole && rest.data ? rest : head;
  // A preview is known by the file's address whichever part is shown, so the pane keeps its scroll
  // position when the whole file takes the place of its start.
  const url = from.replace(/&lines=\d+$/, "");
  useEffect(() => {
    if (!data || url !== urls.preview(entry.path)) return;
    if (data.kind === "table") report(entry.path, [`${fmt.count(data.total)} ${data.total === 1 ? "row" : "rows"}`]);
    else if (data.kind !== "none" && data.kind !== "doc") report(entry.path, [`${fmt.count(data.lines)} ${data.lines === 1 ? "line" : "lines"}`]);
  }, [entry.path, data, url, report]);

  if (failed) return <Card entry={entry} line="This file could not be read" />;
  if (!data) return null;
  switch (data.kind) {
    case "doc":
      return null;
    case "none":
      // A card names its file, so it is never shown for the one before.
      if (url !== urls.preview(entry.path)) return null;
      return <Card entry={entry} line={data.reason === "large" ? "Too large to preview" : "No preview for this type"} />;
    case "markdown":
      return (
        <Scroll id={url}>
          <Prose html={data.html} />
        </Scroll>
      );
    case "code":
      return (
        <Scroll id={url}>
          <pre class="code">
            <code dangerouslySetInnerHTML={{ __html: data.html }} />
          </pre>
        </Scroll>
      );
    case "json":
      return (
        <Scroll id={url}>
          <div class="json">
            <JsonNode value={JSON.parse(data.text)} depth={0} />
          </div>
        </Scroll>
      );
    case "table":
      return (
        <>
          <Scroll id={url}>
            <table class="tbl">
              <thead>
                <tr>
                  <th class="r">#</th>
                  {data.head.map((name, column) => (
                    <th class={data.numeric[column] ? "r" : undefined}>{name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(rested ? data.rows : data.rows.slice(0, FIRST_ROWS)).map((row, at) => (
                  <tr>
                    <td class="i r num">{at + 1}</td>
                    {row.map((value, column) => (
                      <td class={data.numeric[column] ? "r num" : undefined}>{value}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
          {data.total > data.rows.length && (
            <div class="pv-note">
              Showing the first {fmt.count(data.rows.length)} of {fmt.count(data.total)} rows.
            </div>
          )}
        </>
      );
  }
}

/** `stamp` changes when the file is rewritten: what is loaded by address is then loaded again. */
export function Preview({ entry, stamp, report }: { entry: Entry; stamp: string; report: Report }) {
  switch (entry.kind) {
    case "folder":
      return <Folder entry={entry} report={report} />;
    case "image":
      return <Picture entry={entry} stamp={stamp} report={report} />;
    case "video":
    case "audio":
      return <Media key={entry.path} entry={entry} stamp={stamp} report={report} />;
    case "pdf":
    case "html":
      // A new frame for each file: changing the address of one frame would add to the back button's history.
      return <Frame key={entry.path} entry={entry} stamp={stamp} />;
    case "archive":
      if (entry.ext === "zip") return <Zip entry={entry} report={report} />;
      return <Card entry={entry} line="No preview for this type" />;
    default:
      return <Text entry={entry} report={report} />;
  }
}
