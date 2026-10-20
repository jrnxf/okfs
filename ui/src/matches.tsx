// Every match of a search, listed in place of a folder: the bar that holds the query, the heads that sort, a row
// for each match, and the way back to them from a folder entered from them.

import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { config } from "./config";
import { holdBack, took } from "./find";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { Marked } from "./palette";
import { MATCH_LABEL, type Match, store } from "./store";
import type { MatchOrder } from "./api";
import { nameOf, parentOf } from "./api";
import type { Cell } from "./vlist";

/** The server is asked no oftener than this while the query is typed: see `holdBack`. */
const SETTLE = 40;

/** The folder the matches are over, by name: where leaving them goes. */
const overName = (): string => (store.s.path ? nameOf(store.s.path) : config.root);

const counted = (n: number): string => `${fmt.count(n)} ${n === 1 ? "match" : "matches"}`;

/** The bar over the matches: the query, which refines them as it is typed, how many there are, and the way out. */
export function MatchBar({ input }: { input: RefObject<HTMLInputElement | null> }) {
  const matches = store.s.matches;
  const q = matches?.q ?? "";
  const [value, setValue] = useState(q);
  const sent = useRef(0);
  // A query set from elsewhere, such as the palette or the address bar, shows here.
  useEffect(() => {
    if (q.trim() !== value.trim()) setValue(q);
  }, [q]);
  useEffect(() => {
    if (!value.trim() || value.trim() === q) return;
    const timer = setTimeout(
      () => {
        sent.current = performance.now();
        store.refine(value);
      },
      holdBack(performance.now(), sent.current, SETTLE),
    );
    return () => clearTimeout(timer);
  }, [value]);
  return (
    <div class="qbar" onMouseDown={(event) => event.target !== input.current && event.preventDefault()}>
      <Icon name="search" />
      <input
        ref={input}
        type="text"
        name="find"
        value={value}
        placeholder={`Find a file or folder anywhere in ${config.root}`}
        spellcheck={false}
        autocomplete="off"
        aria-label="Refine the search"
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Enter" || event.key === "ArrowDown") {
            event.currentTarget.blur();
            event.preventDefault();
          }
        }}
      />
      {matches?.ready && matches.total > 0 && (
        <span class="facts num">
          {counted(matches.total)} · {took(matches.took)}
        </span>
      )}
      <button class="btn" aria-label="Close the matches" title={`Back to ${overName()} (esc)`} onClick={() => store.leaveFind()}>
        <Icon name="close" />
      </button>
    </div>
  );
}

/** The heads of the columns of the matches. Each sorts by its column; the one sorted by again turns it around. */
export function MatchColumns() {
  const sort = store.s.matches?.sort ?? { key: "rank", rev: false };
  const head = (key: MatchOrder, label: string, right = false) => {
    const on = sort.key === key;
    // Names and folders run from A, sizes and times from the largest and the newest.
    const rising = (key === "name" || key === "folder") !== sort.rev;
    return (
      <button class={[right && "r", on && "on"].filter(Boolean).join(" ") || undefined} onClick={() => store.setMatchSort(key)}>
        {label}
        {on && <Icon name={rising ? "up" : "down"} />}
      </button>
    );
  };
  return (
    <div class="cols label">
      <span />
      {head("name", "Name")}
      {head("folder", "Folder")}
      {head("size", "Size", true)}
      {head("time", "Mod.", true)}
    </div>
  );
}

/** One match as a row of the list, with what the query matched marked in its name, or in its folder. */
export function MatchRow({ match, index, cell, on }: { match: Match; index: number; cell: Cell; on: boolean }) {
  const { entry, hit } = match;
  const dir = parentOf(hit.path);
  // A match on the whole path counts characters from its start: the name begins after the folder and a slash.
  const offset = hit.name ? 0 : Array.from(dir).length + (dir ? 1 : 0);
  const folder = hit.name ? dir || "/" : <Marked text={dir || "/"} idx={hit.idx} />;
  const style = { top: `${cell.top}px`, left: `${cell.left}px`, width: `${cell.width}px`, height: `${cell.height}px` };
  return (
    <div class="row" role="option" aria-selected={on} data-i={index} data-dir={entry.dir ? "" : undefined} style={style}>
      <KindIcon kind={entry.kind} />
      <span class="nmw">
        <span class="nm trunc">
          <b>
            <Marked text={entry.name} idx={hit.idx} from={offset} />
          </b>
        </span>
        <span class="sub trunc">
          <bdi>{folder}</bdi>
        </span>
      </span>
      <span class="dir trunc">
        <bdi>{folder}</bdi>
      </span>
      <span class="sz num">{entry.dir ? (entry.count === undefined ? "" : fmt.count(entry.count)) : fmt.size(entry.size)}</span>
      <span class="tm num" title={entry.mtime ? fmt.abs(entry.mtime) : undefined}>
        {entry.mtime ? fmt.rel(entry.mtime) : ""}
      </span>
    </div>
  );
}

/** Over the list when nothing matches the query. */
export function MatchesEmpty() {
  const matches = store.s.matches;
  if (!matches?.ready || matches.total > 0) return null;
  return (
    <div class="empty">
      <b>No matches for “{matches.q}”</b>
      <span class="hint">Check the spelling, or try fewer letters.</span>
      <span class="hint">
        Press <kbd>esc</kbd> to go back to {overName()}.
      </span>
    </div>
  );
}

/** In the top bar while browsing below a folder entered from the matches: the way back to them. */
export function TrailButton() {
  const trail = store.trail();
  if (!trail) return null;
  // At the folder entered from the matches, a phone's back arrow already goes back to them: see `Store.up`.
  const atRoot = trail.root === store.s.path && !store.s.open;
  return (
    <button class={atRoot ? "btn btn-line trail at-root" : "btn btn-line trail"} title="Back to the matches (esc)" onClick={() => store.toMatches()}>
      <Icon name="left" class="wide-only" />
      <Icon name="list" class="phone-only" />
      <span class="wide-only trunc">
        {counted(trail.total)} for “{trail.q}”
      </span>
      <span class="phone-only num">{fmt.count(trail.total)}</span>
    </button>
  );
}

/** What the status line says of the matches. */
export function matchesInfo(): string {
  const matches = store.s.matches;
  if (!matches) return "";
  return `${counted(matches.total)} · by ${MATCH_LABEL[matches.sort.key]}`;
}
