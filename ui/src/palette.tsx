// The palette: find any file or folder in the whole tree, or run a command.

import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type Changed, type Found, type Hit, type Recent, getJson, nameOf, parentOf, urls } from "./api";
import { config } from "./config";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { kindOf } from "./kinds";
import { SORT_KEYS, SORT_LABEL, store } from "./store";
import { active, isDark, previewTheme, setScheme, setTheme } from "./theme";

/** Typing pauses this long before the server is asked. */
const SETTLE = 40;
/** How often the search is asked again while the first walk of the folder goes on. */
const WALKING = 1000;

/** The modifier this platform uses for shortcuts, as it is written on the key. */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
/** The key that deletes. It takes two fingers, so it is not hit by rolling over `j` and `k`. */
export const DELETE_KEY = `${MOD === "⌘" ? "⇧" : "Shift"} D`;

interface Command {
  title: string;
  key?: string;
  run: () => void;
  /** In a nested list: shows the choice while its row is only highlighted. */
  peek?: () => void;
}

/** A list that a row opens inside the palette, in place of the top one. */
interface Menu {
  title: string;
  /** What the input says while the list is up. */
  placeholder: string;
  items: Command[];
  /** The row the highlight starts on. */
  start: number;
  /** Undoes what `peek` showed, when the list is left without a choice. */
  restore?: () => void;
}

/** A row of the top list: it runs, or it opens a nested list. */
type Entry = Command | { title: string; menu: () => Menu };

function themeMenu(): Menu {
  return {
    title: "Theme",
    placeholder: "Filter themes",
    items: config.themes.map((theme) => ({
      title: theme.name,
      peek: () => previewTheme(theme.id),
      run: () => setTheme(theme.id),
    })),
    start: Math.max(0, config.themes.findIndex((theme) => theme.id === active.theme)),
    restore: () => previewTheme(),
  };
}

function commands(): Entry[] {
  const { s } = store;
  const under = s.open ?? store.cur();
  const here = store.here();
  const flippable = store.flippable();
  const wrappable = store.wrappable();
  // Both are missing when the server has deleting off.
  const deletes: Command[] = [];
  if (config.delete && under) deletes.push({ title: `Delete “${under.name}”`, key: DELETE_KEY, run: () => store.askDelete(under) });
  if (here) deletes.push({ title: `Delete this folder, “${here.name}”`, run: () => store.askDelete(here) });
  return [
    ...(flippable ? [{ title: store.isRaw(flippable) ? "Show it rendered" : "Show the source", key: "r", run: () => store.flipRaw() }] : []),
    ...(wrappable ? [{ title: store.wraps(wrappable) ? "Stop wrapping long lines" : "Wrap long lines", key: "w", run: () => store.flipWrap() }] : []),
    ...SORT_KEYS.map((key) => ({ title: `Sort by ${SORT_LABEL[key].toLowerCase()}`, run: () => store.setSort(key) })),
    {
      title: isDark() ? "Use light scheme" : "Use dark scheme",
      key: "t",
      run: () => setScheme(isDark() ? "light" : "dark"),
    },
    { title: s.hidden ? "Hide hidden files" : "Show hidden files", key: ".", run: () => store.setHidden() },
    { title: "Theme", menu: themeMenu },
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

type Row = { command: Entry; idx: number[] } | { hit: Hit } | { recent: Changed };

export function Palette() {
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);
  const [found, setFound] = useState<Found | null>(null);
  // Asked for once, when the palette opens: it does not change while the palette is up.
  const [recent, setRecent] = useState<Changed[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // The nested list that is up, with the top list's input and highlight to go back to.
  const [nested, setNested] = useState<{ menu: Menu; value: string; selected: number } | null>(null);
  const chosen = useRef(false);
  const menu = nested?.menu;

  // Inside a nested list the input only filters that list.
  const asCommand = !menu && value.startsWith(">");
  const query = (menu ? value : value.replace(/^>\s*/, "")).trim().toLowerCase();
  const searching = !menu && !asCommand && query !== "";
  const asked = searching ? query : "";

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const abort = new AbortController();
    getJson<Recent>(urls.recent(), abort.signal).then((answer) => setRecent(answer.files), () => {});
    return () => abort.abort();
    // Asked again when the first walk ends: until then the newest files are those it has read so far.
  }, [found?.ready]);

  // An empty query still asks once, for the count of indexed entries shown in the footer.
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(
      () => {
        getJson<Found>(urls.search(asked), abort.signal).then(setFound, () => {});
      },
      asked ? SETTLE : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [asked]);

  // The server searches what its first walk has found so far: ask again while it goes on, for the count and the matches.
  useEffect(() => {
    if (!found || found.ready) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      getJson<Found>(urls.search(asked), abort.signal).then(setFound, () => {});
    }, WALKING);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [found, asked]);

  const matching = (entries: Entry[]): Row[] => {
    const matched = entries.flatMap((command) => {
      const match = query ? fuzzy(query, command.title) : { score: 0, idx: [] };
      return match ? [{ command, ...match }] : [];
    });
    if (query) matched.sort((a, b) => b.score - a.score);
    return matched;
  };
  let rows: Row[];
  if (searching) {
    rows = (found?.hits ?? []).map((hit) => ({ hit }));
  } else if (menu) {
    rows = matching(menu.items);
  } else {
    // Nothing typed: the newest files first, then the commands. `>` means commands only.
    const newest: Row[] = value.trim() === "" ? recent.map((file) => ({ recent: file })) : [];
    rows = [...newest, ...matching(commands())];
  }
  const at = Math.min(selected, Math.max(0, rows.length - 1));
  const under = rows[at];
  const lit = menu && under && "command" in under && "run" in under.command ? under.command : undefined;

  // The highlighted row of a nested list shows its choice at once. With no row left, nothing is shown.
  useEffect(() => {
    if (!menu) return;
    if (lit?.peek) lit.peek();
    else menu.restore?.();
  }, [menu, lit]);

  // Leaving a nested list any way but by choosing from it undoes what its highlight showed.
  useEffect(
    () => () => {
      if (!chosen.current) menu?.restore?.();
    },
    [menu],
  );

  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at, rows.length]);

  const enter = (next: Menu) => {
    setNested({ menu: next, value, selected: at });
    setValue("");
    setSelected(next.start);
    input.current?.focus();
  };

  const back = () => {
    if (!nested) return;
    setValue(nested.value);
    setSelected(nested.selected);
    setNested(null);
    input.current?.focus();
  };

  const pick = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if ("command" in row) {
      const { command } = row;
      if ("menu" in command) return enter(command.menu());
      chosen.current = true;
      store.setPalette(false);
      command.run();
      return;
    }
    store.setPalette(false);
    if ("recent" in row) void store.go(row.recent.path, false);
    else void store.go(row.hit.path, row.hit.dir);
  };

  const onKey = (event: KeyboardEvent) => {
    const { key, ctrlKey } = event;
    if (key === "ArrowDown" || (ctrlKey && key === "n")) setSelected(Math.min(at + 1, rows.length - 1));
    else if (key === "ArrowUp" || (ctrlKey && key === "p")) setSelected(Math.max(at - 1, 0));
    else if (key === "Enter") pick(at);
    else if (key === "Escape" && menu) back();
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
      <div class="pal" role="dialog" aria-label={menu ? menu.title : "Find anything"}>
        <div class="pal-in">
          {menu ? (
            <button class="btn pal-up" aria-label={`${menu.title}: back to everything`} onClick={back}>
              <Icon name="left" />
              {menu.title}
            </button>
          ) : (
            <Icon name="search" />
          )}
          <input
            ref={input}
            type="text"
            name="find"
            value={value}
            placeholder={menu ? menu.placeholder : `Find a file or folder anywhere in ${config.root}`}
            spellcheck={false}
            autocomplete="off"
            onInput={(event) => {
              setValue(event.currentTarget.value);
              setSelected(0);
            }}
            onKeyDown={onKey}
          />
          <kbd class="pal-esc">esc</kbd>
        </div>
        <div class="pal-list" ref={list}>
          {rows.length === 0 && !waiting && <div class="pal-empty">Nothing matches “{query}”.</div>}
          {rows.map((row, index) => {
            const common = { class: "pal-row", "aria-selected": index === at, onClick: () => pick(index) };
            const group = groupOf(row);
            const previous = rows[index - 1];
            // A nested list is named beside the input, so its rows go under no label.
            const label = !menu && (!previous || groupOf(previous) !== group) && (
              <div class="pal-group label">{group}</div>
            );
            if ("command" in row) {
              const { command } = row;
              return (
                <Fragment key={`command:${command.title}`}>
                  {label}
                  <div {...common}>
                    <span class="nm trunc">
                      <Marked text={command.title} idx={row.idx} />
                    </span>
                    <span class="dir" />
                    {"key" in command && command.key && <kbd>{command.key}</kbd>}
                    {"menu" in command && <Icon name="right" class="pal-more" />}
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
            <kbd>↵</kbd> {menu ? "choose" : "open"}
          </span>
          {menu ? (
            <span>
              <kbd>esc</kbd> back
            </span>
          ) : (
            <span>
              <kbd>&gt;</kbd> commands
            </span>
          )}
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
