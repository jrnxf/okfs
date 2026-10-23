// The palette: find any file or folder in the whole tree, or run a command.

import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type Changed, type Found, type Hit, type Recent, getJson, nameOf, parentOf, urls } from "./api";
import { config } from "./config";
import * as fmt from "./fmt";
import { type Answer, holdBack, took, waiting } from "./find";
import { Icon, KindIcon } from "./icons";
import { kindOf } from "./kinds";
import { SCRIM } from "./look";
import { SORT_KEYS, SORT_LABEL, store } from "./store";
import { pick } from "./upload";
import { active, isDark, previewTheme, setScheme, setTheme } from "./theme";

/** The server is asked no oftener than this while typing goes on. The first key after a pause is asked at once. */
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
  // Both are missing when the server has deleting off, and over the matches: a match is deleted from its own folder.
  const deletes: Command[] = [];
  if (config.delete && !s.finding) {
    if (under) deletes.push({ title: `Delete “${under.name}”`, key: DELETE_KEY, run: () => store.askDelete(under) });
    if (here) deletes.push({ title: `Delete this folder, “${here.name}”`, run: () => store.askDelete(here) });
  }
  // Missing when the server has adding off, and over the matches: they are in many folders.
  const dir = store.addsTo();
  const adds: Command[] =
    dir === null
      ? []
      : [
          { title: "Upload files here", key: s.open ? undefined : "u", run: () => pick(dir) },
          { title: "Upload a folder here", run: () => pick(dir, true) },
          { title: "New file", key: s.open ? undefined : "n", run: () => store.setNaming("file") },
          { title: "New folder", run: () => store.setNaming("folder") },
        ];
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
    ...(under ? [{ title: `Copy link to this ${under.dir ? "folder" : "file"}`, key: "y", run: () => void store.copyLink(under) }] : []),
    { title: "Go to the top folder", run: () => void store.showDir("") },
    { title: "Download this folder as a zip", run: () => location.assign(urls.zip(s.path)) },
    ...adds,
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

/** A row of the palette, and its name and folder: the folder takes the room the name leaves, cut at its start. */
const PICK = "flex h-(--row-h) cursor-pointer items-center gap-2.5 rounded px-2 aria-selected:bg-accent-soft";
const PICK_NAME = "min-w-0 max-w-[60%] flex-none truncate";
const PICK_DIR = "flex-1 text-right text-s text-muted [direction:rtl]";

/** Text with its matched characters marked. `idx` counts characters, and `from` is where `text` starts. */
export function Marked({ text, idx, from = 0 }: { text: string; idx: number[]; from?: number }) {
  if (!idx.length) return <>{text}</>;
  const hit = new Set(idx);
  const out: ComponentChildren[] = [];
  let plain = "";
  Array.from(text).forEach((char, i) => {
    if (!hit.has(from + i)) {
      plain += char;
      return;
    }
    out.push(plain, <mark class="bg-transparent font-strong text-accent">{char}</mark>);
    plain = "";
  });
  out.push(plain);
  return <>{out}</>;
}

type Row = { command: Entry; idx: number[] } | { hit: Hit } | { recent: Changed } | { all: true };

export function Palette() {
  // Over the matches, the palette starts from their query.
  const [value, setValue] = useState(() => (store.s.finding ? (store.s.matches?.q ?? "") : ""));
  const [selected, setSelected] = useState(0);
  // The last answer, kept while a newer query is on its way: the list shows it until the new one lands.
  const [answer, setAnswer] = useState<Answer | null>(null);
  const found = answer?.found ?? null;
  const sent = useRef(0);
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

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

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
        sent.current = performance.now();
        getJson<Found>(urls.search(asked), abort.signal).then((found) => setAnswer({ q: asked, found }), () => {});
      },
      asked ? holdBack(performance.now(), sent.current, SETTLE) : 0,
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
      getJson<Found>(urls.search(asked), abort.signal).then((found) => setAnswer({ q: asked, found }), () => {});
    }, WALKING);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [answer, asked]);

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
    // The way to every match, below the best ones: see `Store.find`.
    if (found?.total) rows.push({ all: true });
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
    if ("all" in row) return store.find(query);
    store.setPalette(false);
    if ("recent" in row) void store.go(row.recent.path, false);
    else void store.go(row.hit.path, row.hit.dir);
  };

  const onKey = (event: KeyboardEvent) => {
    const { key, ctrlKey } = event;
    if (key === "ArrowDown" || (ctrlKey && key === "n")) setSelected(Math.min(at + 1, rows.length - 1));
    else if (key === "ArrowUp" || (ctrlKey && key === "p")) setSelected(Math.max(at - 1, 0));
    else if (key === "Enter" && (ctrlKey || event.metaKey) && searching) store.find(query);
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
  const allAt = rows.findIndex((row) => "all" in row);
  // Nothing matches only for the query typed: until its answer lands the list keeps the last one.
  const pending = searching && waiting(asked, answer);

  return (
    <div class={SCRIM} onPointerDown={(event) => event.target === event.currentTarget && store.setPalette(false)}>
      <div class="flex max-h-[min(70vh,560px)] w-[min(620px,100%)] flex-col overflow-hidden rounded-lg bg-surface shadow" role="dialog" aria-label={menu ? menu.title : "Find anything"}>
        <div class="flex h-[calc(48px*var(--density))] flex-none items-center gap-2.5 border-b border-b-line px-3.5 text-faint">
          {menu ? (
            <button class="btn -ml-1.5 flex-none gap-0.5 pr-2 pl-1 font-strong text-fg phone:h-[34px]" aria-label={`${menu.title}: back to everything`} onClick={back}>
              <Icon name="left" />
              {menu.title}
            </button>
          ) : (
            <Icon name="search" />
          )}
          <input
            ref={input}
            class="min-w-0 flex-1 border-0 bg-transparent text-[length:calc(var(--text)*1.1)] text-fg placeholder:text-faint pointer-coarse:text-[16px]"
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
          {/* there is no Escape key on a phone, and the chip sits over the end of the placeholder */}
          <kbd class="pointer-coarse:hidden">esc</kbd>
        </div>
        <div class="min-h-0 flex-1 overflow-auto overscroll-contain p-1.5" ref={list}>
          {rows.length === 0 && !pending && <div class="px-3 py-7 text-center text-faint">Nothing matches “{query}”.</div>}
          {rows.map((row, index) => {
            if ("all" in row) return null;
            const common = { class: PICK, "aria-selected": index === at, onClick: () => pick(index) };
            const group = groupOf(row);
            const previous = rows[index - 1];
            // A nested list is named beside the input, so its rows go under no label.
            const label = !menu && (!previous || groupOf(previous) !== group) && (
              <div class="label px-2 pt-2 pb-1">{group}</div>
            );
            if ("command" in row) {
              const { command } = row;
              return (
                <Fragment key={`command:${command.title}`}>
                  {label}
                  <div {...common}>
                    <span class={PICK_NAME}>
                      <Marked text={command.title} idx={row.idx} />
                    </span>
                    <span class={PICK_DIR} />
                    {"key" in command && command.key && <kbd>{command.key}</kbd>}
                    {"menu" in command && <Icon name="right" class="flex-none text-faint" />}
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
                    <span class={PICK_NAME}>{name}</span>
                    <span class={`${PICK_DIR} min-w-0 truncate`}>
                      <bdi class="[direction:ltr]">{dir || "/"}</bdi>
                    </span>
                    <span class="min-w-[3ch] flex-none text-right text-s text-muted tabular-nums" title={fmt.abs(m)}>
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
                  <span class={PICK_NAME}>
                    <Marked text={name} idx={hit.idx} from={offset} />
                  </span>
                  <span class={`${PICK_DIR} min-w-0 truncate`}>
                    <bdi class="[direction:ltr]">{hit.name ? dir || "/" : <Marked text={dir || "/"} idx={hit.idx} />}</bdi>
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>
        {allAt >= 0 && (
          // The way to every match, held under the list: it does not scroll away with the best ones.
          <div class="flex-none border-t border-t-line p-1.5">
            <div class={`${PICK} text-fg phone:h-11`} role="option" aria-selected={allAt === at} onClick={() => pick(allAt)}>
              <Icon name="list" class={allAt === at ? "text-accent" : "text-faint"} />
              <span class="min-w-0 flex-1 truncate">Show all {matches} in the list</span>
              <span class="inline-flex flex-none gap-0.75 phone:hidden">
                <kbd>{MOD}</kbd>
                <kbd>↵</kbd>
              </span>
            </div>
          </div>
        )}
        <div class="flex h-[calc(34px*var(--density))] flex-none items-center gap-3.5 border-t border-t-line px-3.5 text-xs text-faint *:inline-flex *:items-center *:gap-1.25">
          {/* no keys to hint at on a phone, and the count needs the room */}
          <span class="phone:hidden">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span class="phone:hidden">
            <kbd>↵</kbd> {menu ? "choose" : "open"}
          </span>
          {menu ? (
            <span class="phone:hidden">
              <kbd>esc</kbd> back
            </span>
          ) : allAt >= 0 ? (
            <span class="phone:hidden">
              <kbd>{MOD}</kbd>
              <kbd>↵</kbd> all
            </span>
          ) : (
            <span class="phone:hidden">
              <kbd>&gt;</kbd> commands
            </span>
          )}
          <span class="flex-1" />
          {found && (
            <span class="num">
              {searching && !pending && `${took(found.took)} · `}
              {fmt.count(found.indexed)} entries {found.ready ? "indexed" : "indexed so far"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
