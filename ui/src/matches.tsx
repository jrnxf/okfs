// Every match of a search, listed in place of a folder: the bar that holds the query, the heads that sort, a row
// for each match, and the way back to them from a folder entered from them.

import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { config } from "./config";
import { holdBack, took } from "./find";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { AGE, BAR_BTN, EMPTY, EMPTY_HEAD, EMPTY_HINT, HEAD, HEADS, LIST_ROW, MATCH_GRID, ROW, ROW_ON, ROW_REST, SIZE, nameWeight } from "./look";
import { Marked } from "./palette";
import { MATCH_LABEL, type Match, store } from "./store";
import type { MatchOrder } from "./api";
import { nameOf, parentOf } from "./api";
import { rowId, rowName } from "./rows";
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
    <div
      class="box-content flex h-[calc(30px*var(--density))] min-w-0 flex-none items-center gap-2 border-b border-b-line pr-[calc(var(--pad)*0.5)] pl-[calc(var(--pad)*1.25)] text-faint phone:h-[calc(44px*var(--density))]"
      onMouseDown={(event) => event.target !== input.current && event.preventDefault()}
    >
      <Icon name="search" />
      <input
        class="h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-strong text-fg placeholder:font-regular placeholder:text-faint pointer-coarse:text-[16px]"
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
        <span class="num flex-none text-xs text-muted">
          {counted(matches.total)} · {took(matches.took)}
        </span>
      )}
      <button class={`btn ${BAR_BTN}`} aria-label="Close the matches" title={`Back to ${overName()} (esc)`} onClick={() => store.leaveFind()}>
        <Icon name="close" />
      </button>
    </div>
  );
}

/** The heads of the columns of the matches. Each sorts by its column; the one sorted by again turns it around. */
export function MatchColumns() {
  const sort = store.s.matches?.sort ?? { key: "rank", rev: false };
  const head = (key: MatchOrder, label: string, right = false, hide = "") => {
    const on = sort.key === key;
    // Names and folders run from A, sizes and times from the largest and the newest.
    const rising = (key === "name" || key === "folder") !== sort.rev;
    return (
      <button class={`${HEAD} hover:text-fg ${right ? "justify-end" : ""} ${on ? "text-fg" : ""} ${hide}`} onClick={() => store.setMatchSort(key)}>
        {label}
        {on && <Icon name={rising ? "up" : "down"} class="size-2.75 text-accent" />}
      </button>
    );
  };
  return (
    <div class={`${HEADS} ${MATCH_GRID}`}>
      <span />
      {head("name", "Name")}
      {/* A phone puts the folder under the name. */}
      {head("folder", "Folder", false, "phone:hidden")}
      {head("size", "Size", true)}
      {head("time", "Mod.", true)}
    </div>
  );
}

/** The folder a match is in, cut at its start: the end of a path says more than its start. */
const FOLDER = "min-w-0 truncate text-left text-muted [direction:rtl]";

/** One match as a row of the list, with what the query matched marked in its name, or in its folder. */
export function MatchRow({ match, index, cell, on }: { match: Match; index: number; cell: Cell; on: boolean }) {
  const { entry, hit } = match;
  const dir = parentOf(hit.path);
  // A match on the whole path counts characters from its start: the name begins after the folder and a slash.
  const offset = hit.name ? 0 : Array.from(dir).length + (dir ? 1 : 0);
  const folder = hit.name ? dir || "/" : <Marked text={dir || "/"} idx={hit.idx} />;
  const style = { top: `${cell.top}px`, left: `${cell.left}px`, width: `${cell.width}px`, height: `${cell.height}px` };
  return (
    // A phone shows a match in two lines: its name, and the folder it is in under it.
    <div class={`${ROW} ${MATCH_GRID} ${ROW_REST} ${ROW_ON} ${LIST_ROW}`} id={rowId(index)} role="option" aria-label={rowName(entry)} aria-selected={on} data-i={index} data-dir={entry.dir ? "" : undefined} style={style}>
      <KindIcon kind={entry.kind} />
      <span class="flex min-w-0 phone:flex-col phone:leading-[1.3]">
        <span class="min-w-0 truncate">
          <b class={nameWeight(entry.dir)}>
            <Marked text={entry.name} idx={hit.idx} from={offset} />
          </b>
        </span>
        <span class={`hidden phone:block ${FOLDER} text-xs`}>
          <bdi class="[direction:ltr]">{folder}</bdi>
        </span>
      </span>
      <span class={`phone:hidden ${FOLDER} text-s`}>
        <bdi class="[direction:ltr]">{folder}</bdi>
      </span>
      <span class={SIZE}>{entry.dir ? (entry.count === undefined ? "" : fmt.count(entry.count)) : fmt.size(entry.size)}</span>
      <span class={AGE} title={entry.mtime ? fmt.abs(entry.mtime) : undefined}>
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
    <div class={EMPTY}>
      <b class={EMPTY_HEAD}>No matches for “{matches.q}”</b>
      <span class={EMPTY_HINT}>Check the spelling, or try fewer letters.</span>
      <span class={EMPTY_HINT}>
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
    <button
      class={`btn btn-line h-[calc(26px*var(--density))] max-w-[260px] flex-none gap-1 pr-2.25 pl-1.5 text-fg phone:h-8 phone:gap-1.25 phone:px-2 phone:text-xs ${atRoot ? "phone:hidden" : ""}`}
      title="Back to the matches (esc)"
      onClick={() => store.toMatches()}
    >
      <Icon name="left" class="text-accent phone:hidden" />
      <Icon name="list" class="hidden text-accent phone:block phone:text-muted" />
      <span class="min-w-0 truncate phone:hidden">
        {counted(trail.total)} for “{trail.q}”
      </span>
      <span class="num hidden phone:inline">{fmt.count(trail.total)}</span>
    </button>
  );
}

/** What the status line says of the matches. */
export function matchesInfo(): string {
  const matches = store.s.matches;
  if (!matches) return "";
  return `${counted(matches.total)} · by ${MATCH_LABEL[matches.sort.key]}`;
}
