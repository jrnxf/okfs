// What the right pane shows for the file or folder under the cursor.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { type Archive, type Listing, type TextPreview, getJson, pathOf, urls } from "./api";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { LABEL, kindOf } from "./kinds";
import type { Entry } from "./store";

/** Wait this long before asking the server, so holding `j` does not ask for every file passed. */
const SETTLE = 25;
/** Frames and players cost more to start, so they wait a little longer. */
const SETTLE_HEAVY = 90;
/** After this long without an answer, the previous file's preview is cleared instead of kept. */
const STALE = 250;
/** Children of one JSON object or array shown before "show more". */
const JSON_PAGE = 200;
/** Entries listed for a folder under the cursor. */
const FOLDER_PEEK = 14;

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
  for (const asker of askers) if (dropped(asker.url)) asker.again();
}

interface Loaded<T> {
  /** The address `data` came from. It trails `url` while a newer answer is on its way. */
  url: string;
  data?: T;
  failed?: boolean;
}

/** Fetches JSON for the pane. Keeps the last answer on screen until the next one arrives. */
export function useLoaded<T>(url: string, settle = SETTLE): Loaded<T> {
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
  useEffect(() => {
    const known = answers.get(url) as T | undefined;
    if (known !== undefined) {
      setState({ url, data: known });
      return;
    }
    const abort = new AbortController();
    const ask = setTimeout(() => {
      getJson<T>(url, abort.signal).then(
        (data) => {
          remember(url, data);
          setState({ url, data });
        },
        () => {
          if (!abort.signal.aborted) setState({ url, failed: true });
        },
      );
    }, settle);
    const clear = setTimeout(() => setState((old) => (old.url === url ? old : { url: old.url })), STALE);
    return () => {
      clearTimeout(ask);
      clearTimeout(clear);
      abort.abort();
    };
  }, [url, settle, dropped]);
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
  const [broken, setBroken] = useState(false);
  const settled = useSettled(entry.path, SETTLE_HEAVY);
  // A rewritten file is loaded again only once nothing is playing: a player is never cut off.
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(stamp);
  useEffect(() => {
    if (!playing) setLoaded(stamp);
  }, [stamp, playing]);
  if (broken) return <Card entry={entry} line="This browser cannot play this file" />;
  const src = settled ? `${urls.raw(entry.path)}?v=${loaded}` : undefined;
  const state = { onPlay: () => setPlaying(true), onPause: () => setPlaying(false), onEnded: () => setPlaying(false) };
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
          <audio src={src} controls preload="metadata" onLoadedMetadata={onMeta} onError={() => setBroken(!!src)} {...state} />
        </div>
      </div>
    );
  }
  return (
    <div class="pv-center">
      <video src={src} controls playsInline preload="metadata" onLoadedMetadata={onMeta} onError={() => setBroken(!!src)} {...state} />
    </div>
  );
}

function Frame({ entry, stamp }: { entry: Entry; stamp: string }) {
  const settled = useSettled(entry.path, SETTLE_HEAVY);
  // A rewritten file loads in a frame of its own, behind the one on screen, and takes its place once it
  // is ready: a save never shows an empty pane.
  const [shown, setShown] = useState(stamp);
  if (!settled) return null;
  const html = entry.kind === "html";
  return (
    <>
      {(stamp === shown ? [shown] : [shown, stamp]).map((version) => (
        <iframe
          key={version}
          class={version === shown ? "pv-frame" : "pv-frame pv-next"}
          // A served page runs in a sandbox: it gets an origin of its own and cannot reach the app.
          // The server sends the same restriction as a header, so it holds when the page is opened directly too.
          sandbox={html ? "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms" : undefined}
          src={html ? urls.raw(entry.path) : `${urls.raw(entry.path)}#navpanes=0&view=FitH`}
          title={entry.name}
          onLoad={version === shown ? undefined : () => setShown(version)}
        />
      ))}
    </>
  );
}

function Zip({ entry, report }: { entry: Entry; report: Report }) {
  const { data, failed, url } = useLoaded<Archive>(urls.archive(entry.path));
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
            {data.entries.map((item) => (
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
  const { data, failed, url } = useLoaded<TextPreview>(urls.preview(entry.path));
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
                {data.rows.map((row, at) => (
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
