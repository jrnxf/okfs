// The folder picker of Move to and Copy to: the served folder as a tree, open down to the folder the entries are in,
// and a field that finds any folder by name. A folder cannot go inside itself, so for a move that one and all under it
// are greyed, and the folder the entries are in already says so.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Found, type Listing, getJson, joinPath, makeFolder, nameOf, parentOf, urls } from "./api";
import { config } from "./config";
import { Icon, KindIcon } from "./icons";
import { ASK, ASK_BTN, ASK_IN, DIALOG_HEAD } from "./look";
import { freeName, store } from "./store";

interface Row {
  path: string;
  depth: number;
  /** Why it cannot be picked: it is what moves, or where it already is. */
  off?: "itself" | "here";
  /** Shown found by name, with the folder it is in after it. */
  found?: boolean;
}

/** The paths of the folders above `path`, the top one first: `a/b/c` gives ``, `a`, `a/b`. */
const above = (path: string): string[] => {
  const out = [""];
  const names = path ? path.split("/") : [];
  for (let at = 1; at < names.length; at++) out.push(names.slice(0, at).join("/"));
  return out;
};

export function Picker() {
  const picking = store.s.picking;
  const [kids, setKids] = useState<Map<string, string[]>>(new Map());
  const [open, setOpen] = useState<Set<string>>(() => new Set(picking ? [...above(picking.from), picking.from] : [""]));
  const [hi, setHi] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const load = async (path: string) => {
    const listing = await getJson<Listing>(urls.list(path)).catch(() => null);
    if (!listing) return;
    const dirs = listing.entries.filter((item) => item.d && !item.l).map((item) => joinPath(path, item.n));
    setKids((was) => new Map(was).set(path, dirs));
  };
  // Every open folder is read once.
  useEffect(() => {
    for (const path of open) if (!kids.has(path)) void load(path);
  }, [open]);
  useEffect(() => field.current?.focus(), []);
  // A name typed finds folders anywhere, from the index.
  useEffect(() => {
    const q = query.trim();
    if (!q) return setFound(null);
    const asking = new AbortController();
    const wait = setTimeout(() => {
      getJson<Found>(urls.search(q), asking.signal)
        .then((answer) => setFound(answer.hits.filter((hit) => hit.dir).map((hit) => hit.path)))
        .catch(() => undefined);
    }, 60);
    return () => {
      clearTimeout(wait);
      asking.abort();
    };
  }, [query]);

  const moving = picking?.mode === "move";
  const offOf = (path: string): Row["off"] => {
    if (!picking) return undefined;
    if (moving && picking.paths.some((from) => path === from || path.startsWith(`${from}/`))) return "itself";
    if (moving && path === picking.from) return "here";
    return undefined;
  };
  const rows: Row[] = useMemo(() => {
    if (found) return found.map((path) => ({ path, depth: 0, off: offOf(path), found: true }));
    const out: Row[] = [];
    const walk = (path: string, depth: number) => {
      out.push({ path, depth, off: offOf(path) });
      if (!open.has(path)) return;
      for (const child of kids.get(path) ?? []) walk(child, depth + 1);
    };
    walk("", 0);
    return out;
  }, [found, kids, open, picking]);

  // The first folder that can be picked starts highlighted, and the highlight is kept on one that can be.
  useEffect(() => {
    if (hi !== null && rows.some((row) => row.path === hi && !row.off)) return;
    const first = rows.find((row) => !row.off && row.path !== picking?.from) ?? rows.find((row) => !row.off);
    setHi(first?.path ?? null);
  }, [rows]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  if (!picking) return null;
  const chosen = rows.find((row) => row.path === hi && !row.off);
  const n = picking.paths.length;
  const what = n === 1 ? `“${nameOf(picking.paths[0] ?? "")}”` : `${n} items`;
  const verb = moving ? "Move" : "Copy";
  const go = () => {
    if (!chosen || busy) return;
    void store.transfer(picking.mode, picking.paths, chosen.path);
  };
  const toggle = (path: string, on = !open.has(path)) => {
    const next = new Set(open);
    if (on) next.add(path);
    else next.delete(path);
    setOpen(next);
  };
  const step = (by: number) => {
    const live = rows.filter((row) => !row.off);
    if (!live.length) return;
    const at = live.findIndex((row) => row.path === hi);
    setHi(live[(at + by + live.length) % live.length]?.path ?? null);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") step(1);
    else if (event.key === "ArrowUp") step(-1);
    else if (event.key === "ArrowRight" && hi !== null && !found) toggle(hi, true);
    else if (event.key === "ArrowLeft" && hi !== null && !found) {
      if (open.has(hi) && hi !== "") toggle(hi, false);
      else if (hi !== "") setHi(parentOf(hi));
    } else if (event.key === "Enter") go();
    else if (event.key === "Escape") store.stopPicking();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const newFolder = async () => {
    const into = chosen?.path ?? picking.from;
    setBusy(true);
    try {
      if (!kids.has(into)) await load(into);
      const listing = await getJson<Listing>(urls.list(into));
      const name = freeName("New folder", new Set(listing.entries.map((item) => item.n.toLowerCase())));
      const clash = await makeFolder(joinPath(into, name));
      if (clash) throw new Error(clash.error);
      await load(into);
      setQuery("");
      setOpen(new Set(open).add(into));
      setHi(joinPath(into, name));
    } catch (error) {
      store.say(`Not made: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class={ASK_IN} onPointerDown={(event) => event.target === event.currentTarget && store.stopPicking()} onKeyDown={onKey}>
      <div class={`${ASK} w-[min(440px,100%)]`} role="dialog" aria-modal="true" aria-labelledby="pick-title">
        <h2 id="pick-title" class={`m-0 truncate ${DIALOG_HEAD}`}>
          {verb} {what} to…
        </h2>
        <label class="flex h-[calc(32px*var(--density))] items-center gap-2 rounded bg-sunken px-2.5 text-faint">
          <Icon name="search" />
          <input
            ref={field}
            class="min-w-0 flex-1 border-0 bg-transparent text-fg placeholder:text-faint pointer-coarse:text-[16px]"
            value={query}
            placeholder="Type a folder name"
            spellcheck={false}
            autocomplete="off"
            aria-label="Find a folder"
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <div ref={list} class="max-h-[236px] overflow-auto overscroll-contain rounded border border-line bg-bg p-1" role="tree" aria-label="Folders">
          {rows.map((row) => {
            const hasKids = row.found ? false : (kids.get(row.path)?.length ?? 1) > 0;
            const isOpen = open.has(row.path);
            return (
              <div
                class={`flex h-[calc(30px*var(--density))] cursor-default items-center gap-1.5 rounded pr-2 text-s aria-selected:bg-accent-soft aria-selected:shadow-[inset_3px_0_0_var(--accent)] aria-disabled:text-faint ${row.off ? "" : "hover:bg-hover"}`}
                style={{ paddingLeft: `${6 + row.depth * 16}px` }}
                role="treeitem"
                aria-selected={row.path === hi}
                aria-disabled={row.off !== undefined}
                aria-expanded={row.found || row.path === "" ? undefined : isOpen}
                key={row.path}
                onClick={() => !row.off && setHi(row.path)}
                onDblClick={() => {
                  if (row.off) return;
                  setHi(row.path);
                  void store.transfer(picking.mode, picking.paths, row.path);
                }}
              >
                <button
                  class={`grid size-3.5 flex-none place-items-center text-faint ${row.found || row.path === "" || !hasKids ? "invisible" : ""}`}
                  tabIndex={-1}
                  aria-label={isOpen ? "Close" : "Open"}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(row.path);
                  }}
                >
                  <Icon name="right" class={`size-3.5 transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`} />
                </button>
                <KindIcon kind="folder" />
                <span class="min-w-0 truncate">
                  {row.path === "" ? config.root : nameOf(row.path)}
                  {row.found && <span class="text-faint"> /{parentOf(row.path)}</span>}
                </span>
                {row.off && <span class="ml-auto text-xs text-faint">{row.off}</span>}
              </div>
            );
          })}
          {found && found.length === 0 && <div class="px-2 py-1.5 text-s text-faint">No folder is named like that</div>}
        </div>
        <p class="m-0 text-s text-muted">
          {chosen ? (
            <>
              {moving ? "Moves" : "Copies"} to <b class="num font-medium text-fg">/{chosen.path}</b>.
            </>
          ) : (
            "Pick a folder."
          )}{" "}
          A name taken there is kept beside it, as <span class="num">name (1)</span>.
        </p>
        <div class="mt-1 flex items-center gap-2">
          {config.upload && (
            <button class="btn" disabled={busy} onClick={() => void newFolder()}>
              <Icon name="folder-plus" />
              New folder
            </button>
          )}
          <span class="flex-1" />
          <button class={`btn btn-line ${ASK_BTN}`} onClick={() => store.stopPicking()}>
            Cancel
          </button>
          <button class={`btn btn-fill ${ASK_BTN}`} disabled={!chosen || busy} onClick={go}>
            {verb} here
          </button>
        </div>
      </div>
    </div>
  );
}
