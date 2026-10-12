// The palette: find any file or folder in the whole tree, or run a command.

import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type Changed, type Found, type Hit, type Recent, getJson, nameOf, parentOf, urls } from "./api";
import { config } from "./config";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { kindOf } from "./kinds";
import { SORT_KEYS, SORT_LABEL, store } from "./store";
import { isDark, setScheme, setTheme } from "./theme";

/** Typing pauses this long before the server is asked. */
const SETTLE = 40;
/** How many recently changed files the palette lists before anything is typed. */
const RECENT = 8;

/** The modifier this platform uses for shortcuts, as it is written on the key. */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
/** The key that deletes. It takes two fingers, so it is not hit by rolling over `j` and `k`. */
export const DELETE_KEY = `${MOD === "⌘" ? "⇧" : "Shift"} D`;

interface Command {
  title: string;
  key?: string;
  run: () => void;
}

function commands(): Command[] {
  const { s } = store;
  const under = s.open ?? store.cur();
  const here = store.here();
  // Both are missing when the server has deleting off.
  const deletes: Command[] = [];
  if (config.delete && under) deletes.push({ title: `Delete “${under.name}”`, key: DELETE_KEY, run: () => store.askDelete(under) });
  if (here) deletes.push({ title: `Delete this folder, “${here.name}”`, run: () => store.askDelete(here) });
  return [
    { title: s.view === "list" ? "Switch to grid view" : "Switch to list view", key: "g", run: () => store.setView() },
    ...SORT_KEYS.map((key) => ({ title: `Sort by ${SORT_LABEL[key].toLowerCase()}`, run: () => store.setSort(key) })),
    {
      title: isDark() ? "Use light scheme" : "Use dark scheme",
      key: "t",
      run: () => setScheme(isDark() ? "light" : "dark"),
    },
    ...config.themes.map((theme) => ({ title: `Theme: ${theme.name}`, run: () => setTheme(theme.id) })),
    { title: "Go to the top folder", run: () => void store.showDir("") },
    { title: "Download this folder as a zip", run: () => location.assign(urls.zip(s.path)) },
    ...deletes,
    { title: "Keyboard shortcuts", key: "?", run: () => store.setHelp(true) },
  ];
}

/** Matches a command title: a plain substring first, then letters in order. */
function fuzzy(query: string, text: string): { score: number; idx: number[] } | null {
  const lower = text.toLowerCase();
  const at = lower.indexOf(query);
  if (at >= 0) return { score: 100 + query.length * 6 - at * 0.2, idx: Array.from(query, (_, i) => at + i) };
  const idx: number[] = [];
  let score = 0;
  let last = -2;
  for (let i = 0; i < lower.length && idx.length < query.length; i++) {
    if (lower[i] !== query[idx.length]) continue;
    score += 1 + (i === last + 1 ? 4 : 0) + (i === 0 || " -_./".includes(text[i - 1] ?? "") ? 3 : 0);
    idx.push(i);
    last = i;
  }
  return idx.length === query.length ? { score, idx } : null;
}

/** Text with its matched characters marked. `idx` counts characters, and `from` is where `text` starts. */
function Marked({ text, idx, from = 0 }: { text: string; idx: number[]; from?: number }) {
  if (!idx.length) return <>{text}</>;
  const hit = new Set(idx);
  const out: ComponentChildren[] = [];
  let plain = "";
  Array.from(text).forEach((char, i) => {
    if (!hit.has(from + i)) {
      plain += char;
      return;
    }
    out.push(plain, <mark>{char}</mark>);
    plain = "";
  });
  out.push(plain);
  return <>{out}</>;
}

type Row = { command: Command; idx: number[] } | { hit: Hit } | { recent: Changed };

export function Palette() {
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);
  const [found, setFound] = useState<Found | null>(null);
  // Asked for once, when the palette opens: it does not change while the palette is up.
  const [recent, setRecent] = useState<Changed[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const asCommand = value.startsWith(">");
  const query = value.replace(/^>\s*/, "").trim().toLowerCase();
  const searching = !asCommand && query !== "";

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const abort = new AbortController();
    getJson<Recent>(urls.recent(RECENT), abort.signal).then((answer) => setRecent(answer.files), () => {});
    return () => abort.abort();
  }, []);

  // An empty query still asks once, for the count of indexed entries shown in the footer.
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(
      () => {
        getJson<Found>(urls.search(searching ? query : ""), abort.signal).then(setFound, () => {});
      },
      searching ? SETTLE : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, searching]);

  let rows: Row[];
  if (searching) {
    rows = (found?.hits ?? []).map((hit) => ({ hit }));
  } else {
    const matched = commands().flatMap((command) => {
      const match = query ? fuzzy(query, command.title) : { score: 0, idx: [] };
      return match ? [{ command, ...match }] : [];
    });
    if (query) matched.sort((a, b) => b.score - a.score);
    // Nothing typed: the newest files first, then the commands. `>` means commands only.
    const newest: Row[] = value.trim() === "" ? recent.map((file) => ({ recent: file })) : [];
    rows = [...newest, ...matched];
  }
  const at = Math.min(selected, Math.max(0, rows.length - 1));

  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at, rows.length]);

  const pick = (index: number) => {
    const row = rows[index];
    if (!row) return;
    store.setPalette(false);
    if ("command" in row) row.command.run();
    else if ("recent" in row) void store.go(row.recent.path, false);
    else void store.go(row.hit.path, row.hit.dir);
  };

  const onKey = (event: KeyboardEvent) => {
    const { key, ctrlKey } = event;
    if (key === "ArrowDown" || (ctrlKey && key === "n")) setSelected(Math.min(at + 1, rows.length - 1));
    else if (key === "ArrowUp" || (ctrlKey && key === "p")) setSelected(Math.max(at - 1, 0));
    else if (key === "Enter") pick(at);
    else if (key === "Escape") store.setPalette(false);
    else return;
    event.preventDefault();
  };

  const total = found?.total ?? 0;
  const matches = `${fmt.count(total)} ${total === 1 ? "match" : "matches"}`;
  // The group a row belongs to, which gets its label above the first row of the run.
  const groupOf = (row: Row): string => ("recent" in row ? "Recently changed" : "command" in row ? "Commands" : matches);
  const waiting = searching && !found;

  return (
    <div class="scrim" onPointerDown={(event) => event.target === event.currentTarget && store.setPalette(false)}>
      <div class="pal" role="dialog" aria-label="Find anything">
        <div class="pal-in">
          <Icon name="search" />
          <input
            ref={input}
            type="text"
            name="find"
            value={value}
            placeholder={`Find a file or folder anywhere in ${config.root}`}
            spellcheck={false}
            autocomplete="off"
            onInput={(event) => {
              setValue(event.currentTarget.value);
              setSelected(0);
            }}
            onKeyDown={onKey}
          />
          <kbd>esc</kbd>
        </div>
        <div class="pal-list" ref={list}>
          {rows.length === 0 && !waiting && <div class="pal-empty">Nothing matches “{query}”.</div>}
          {rows.map((row, index) => {
            const common = { class: "pal-row", "aria-selected": index === at, onClick: () => pick(index) };
            const group = groupOf(row);
            const previous = rows[index - 1];
            const label = (!previous || groupOf(previous) !== group) && <div class="pal-group label">{group}</div>;
            if ("command" in row) {
              return (
                <Fragment key={`command:${row.command.title}`}>
                  {label}
                  <div {...common}>
                    <Icon name="right" />
                    <span class="nm trunc">
                      <Marked text={row.command.title} idx={row.idx} />
                    </span>
                    <span class="dir" />
                    {row.command.key && <kbd>{row.command.key}</kbd>}
                  </div>
                </Fragment>
              );
            }
            if ("recent" in row) {
              const { path, m } = row.recent;
              const [dir, name] = [parentOf(path), nameOf(path)];
              return (
                <Fragment key={`recent:${path}`}>
                  {label}
                  <div {...common}>
                    <KindIcon kind={kindOf(name, false)} />
                    <span class="nm trunc">{name}</span>
                    <span class="dir trunc">
                      <bdi>{dir || "/"}</bdi>
                    </span>
                    <span class="age" title={fmt.abs(m)}>
                      {fmt.rel(m)}
                    </span>
                  </div>
                </Fragment>
              );
            }
            const { hit } = row;
            const [dir, name] = [parentOf(hit.path), nameOf(hit.path)];
            // A match on the whole path counts characters from its start: the name begins after the folder and a slash.
            const offset = hit.name ? 0 : Array.from(dir).length + (dir ? 1 : 0);
            return (
              <Fragment key={`hit:${hit.path}`}>
                {label}
                <div {...common}>
                  <KindIcon kind={kindOf(name, hit.dir)} />
                  <span class="nm trunc">
                    <Marked text={name} idx={hit.idx} from={offset} />
                  </span>
                  <span class="dir trunc">
                    <bdi>{hit.name ? dir || "/" : <Marked text={dir || "/"} idx={hit.idx} />}</bdi>
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>
        <div class="pal-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>&gt;</kbd> commands
          </span>
          <span class="sp" />
          {found && (
            <span class="num">
              {fmt.count(found.indexed)} entries {found.ready ? "indexed" : "indexed so far"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
