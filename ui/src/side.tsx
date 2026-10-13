// What is beside the main list: the file under the cursor, or a column for the folder under it and for each
// folder its first entry leads to, and then the file that path ends on.

import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { type Item, type Listing, urls } from "./api";
import { config } from "./config";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { DELETE_KEY } from "./palette";
import { Preview, columnsUrl, lookAhead, useLoaded, useSettled } from "./preview";
import { chainOf } from "./slots";
import { type Entry, store, toEntry, versionOf } from "./store";

/** Once the cursor has rested on a folder this long, its first files are asked for: it may be entered next. */
const FOLDER_REST = 150;
/** How many of them. */
const FOLDER_WARM = 10;

/** A click on a row of a column goes where a click in the main list would: into a folder, onto a file. */
function visit(listing: Listing, item: Item, open: boolean): void {
  const path = listing.path ? `${listing.path}/${item.n}` : item.n;
  if (item.d) void store.showDir(path);
  else if (open) void store.go(path, false);
  else void store.showDir(listing.path, { select: item.n });
}

/**
 * One folder as a column: its own header, then its first entries as the main list draws them, in name order.
 * `followed` marks the first entry: the next slot shows it, the inside of a folder or the preview of a file.
 */
function Column({ folder, listing, followed, edge }: { folder: Entry; listing: Listing | undefined; followed: boolean; edge: boolean }) {
  // The listing on screen is the last one's until this folder's has come.
  const own = listing?.path === folder.path ? listing : undefined;
  const count = own?.total ?? folder.count;
  const facts = [...(count === undefined ? [] : [fmt.items(count)]), fmt.abs(folder.mtime)];
  const more = listing ? listing.total - listing.entries.length : 0;
  const itemOf = (event: MouseEvent): Item | undefined => {
    const row = (event.target as Element).closest<HTMLElement>("[data-i]");
    return row ? listing?.entries[Number(row.dataset.i)] : undefined;
  };
  const go = (open: boolean) => (event: MouseEvent) => {
    const item = itemOf(event);
    if (listing && item) visit(listing, item, open);
  };
  return (
    <section class={edge ? "col edge" : "col"} aria-label={folder.name}>
      <div class="ph">
        <KindIcon kind="folder" />
        <span class="nm trunc">{folder.name}</span>
        <span class="facts trunc num">{facts.join(" · ")}</span>
        <a class="btn" href={urls.zip(folder.path)} download aria-label="Download as a zip" title="Download as a zip">
          <Icon name="download" />
        </a>
        {config.delete && (
          <button class="btn" aria-label="Delete" title="Delete" onClick={() => store.askDelete(folder)}>
            <Icon name="trash" />
          </button>
        )}
      </div>
      <div class="cols label">
        <span />
        <span class="hd">
          Name
          <Icon name="up" />
        </span>
        <span class="hd r">Size</span>
        <span class="hd r">Mod.</span>
      </div>
      <div class="col-rows" onClick={go(false)} onDblClick={go(true)}>
        {listing?.entries.map((item, at) => {
          const entry = toEntry(item, listing.path, at);
          return (
            <div class={followed && at === 0 ? "row at" : "row"} data-i={at} data-dir={entry.dir ? "" : undefined} key={at}>
              <KindIcon kind={entry.kind} />
              <span class="nm trunc">
                <b>{entry.name}</b>
              </span>
              <span class="sz num">{entry.dir ? (entry.count === undefined ? "" : fmt.count(entry.count)) : fmt.size(entry.size)}</span>
              <span class="tm num" title={fmt.abs(entry.mtime)}>
                {fmt.rel(entry.mtime)}
              </span>
            </div>
          );
        })}
        {more > 0 && <div class="col-note label">and {fmt.count(more)} more</div>}
        {listing?.total === 0 && <div class="col-note label">This folder is empty.</div>}
      </div>
    </section>
  );
}

export function Side({ slots }: { slots: number }) {
  const { s } = store;
  // Without the pane, nothing is shown, and so nothing is loaded, until a file is opened.
  const cur = s.pane ? store.cur() : null;
  const folder = !s.open && cur?.dir ? cur : null;

  const [facts, setFacts] = useState<{ path: string; list: string[] }>({ path: "", list: [] });
  const report = useCallback((path: string, list: string[]) => {
    setFacts((old) => (old.path === path && old.list.join() === list.join() ? old : { path, list }));
  }, []);

  const url = folder ? columnsUrl(folder.path) : null;
  const { data, url: from } = useLoaded<Listing>(url);
  const { levels, file: last } = folder ? chainOf(data, slots) : { levels: [], file: null };
  // The file the folder's path ends on. It is the same entry from draw to draw, as an entry of the list is.
  const end = useMemo(() => (last ? toEntry(last.item, last.dir, 0) : null), [last?.item, last?.dir]);
  const file = s.open ?? (cur && !cur.dir ? cur : end);

  // The first move into a folder is the one move nothing was loaded ahead for. A folder the cursor rests on
  // is likely to be entered, so its first previews are asked for now, as they would be on the way in.
  const rested = useSettled(folder?.path ?? "", FOLDER_REST);
  useEffect(() => {
    if (!rested || !data || !url || from !== url) return;
    const first = data.entries.slice(0, FOLDER_WARM).map((item, rank) => toEntry(item, data.path, rank));
    lookAhead(first, -1, 1, versionOf);
  }, [rested, data, from, url]);

  let header: ComponentChildren = null;
  if (file) {
    const learned = facts.path === file.path ? facts.list : [];
    const files = s.open ? store.files() : [];
    header = (
      <>
        <button class="btn only-open" aria-label="Back to the list" onClick={() => store.close()}>
          <Icon name="left" />
        </button>
        <KindIcon kind={file.kind} />
        <span class="nm trunc">{file.name}</span>
        <span class="facts trunc num">{[...learned, fmt.size(file.size), fmt.abs(file.mtime)].join(" · ")}</span>
        <span class="pos num only-open">
          {files.indexOf(file) + 1} / {files.length}
        </span>
        <button class="btn only-open" aria-label="Previous file" onClick={() => store.step(-1)}>
          <Icon name="up" />
        </button>
        <button class="btn only-open" aria-label="Next file" onClick={() => store.step(1)}>
          <Icon name="down" />
        </button>
        <a class="btn" href={urls.raw(file.path)} download aria-label="Download" title="Download">
          <Icon name="download" />
        </a>
        {config.delete && (
          // The key deletes what is under the cursor, which the file at the end of a path is not.
          <button class="btn" aria-label="Delete" title={file === end ? "Delete" : `Delete (${DELETE_KEY})`} onClick={() => store.askDelete(file)}>
            <Icon name="trash" />
          </button>
        )}
        {s.pane && (
          <button
            class="btn widen"
            aria-label={s.open ? "Back to two panes" : "Full width"}
            onClick={() => (s.open ? store.close() : file === end ? void store.go(file.path, false) : store.activate())}
          >
            <Icon name={s.open ? "pane" : "expand"} />
          </button>
        )}
      </>
    );
  }

  return (
    <section class="right">
      {/* First in the page and last on screen: a column that comes or goes never moves the pane, whose frames
          would load again if it did. */}
      {(file || !cur) && (
        <div class="pane" key="pane">
          <div class="ph">{header}</div>
          <div class="pv">{file && <Preview entry={file} stamp={store.stamp(file)} report={report} end={file === end} />}</div>
        </div>
      )}
      {levels.map((listing, level) => {
        const above = levels[level - 1];
        const first = above?.entries[0];
        // The folder under the cursor heads the first column. Each one after is the first entry of the one before.
        const head = level === 0 ? folder : above && first ? toEntry(first, above.path, 0) : null;
        return head && <Column key={level} folder={head} listing={listing} followed={level + 1 < levels.length || end !== null} edge={level === slots - 2} />;
      })}
    </section>
  );
}
