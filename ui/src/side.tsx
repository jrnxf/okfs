// What is beside the main list. The file under the cursor as it is shown. For a folder under it: with the
// preview closed, a column for it and for each folder its first entry leads to; with it open, the folder
// added up.

import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { type FolderSum, type Item, type Listing, nameOf, parentOf, urls } from "./api";
import { config } from "./config";
import * as fmt from "./fmt";
import { Icon, KindIcon } from "./icons";
import { hasSource } from "./kinds";
import { DELETE_KEY } from "./palette";
import { Preview, Prose, columnsUrl, lookAhead, useLoaded, useSettled } from "./preview";
import { columnsOf, startingAt } from "./slots";
import { type Doomed, type Entry, store, toEntry, versionOf } from "./store";

/** Once the preview has rested on a folder this long, its first files are asked for: it may be entered next. */
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

/** A click on a button of a header leaves the focus where it was, so the keys go on working on the list. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * A folder's bar: its name, how much it holds, when it changed, and what can be done with it. The main list has
 * one as every column does, so a folder's rows sit at the same height in every slot, and on one grid with the
 * rows beside them.
 */
export function FolderBar({ name, path, count, mtime, doomed }: { name: string; path: string; count: number | undefined; mtime: number | undefined; doomed: Doomed | null }) {
  const facts = [...(count === undefined ? [] : [fmt.items(count)]), ...(mtime === undefined ? [] : [fmt.abs(mtime)])];
  return (
    <div class="ph" onMouseDown={keepFocus}>
      <KindIcon kind="folder" />
      <span class="nm trunc">{name}</span>
      <span class="facts trunc num">{facts.join(" · ")}</span>
      <a class="btn" href={urls.zip(path)} download aria-label="Download as a zip" title="Download as a zip">
        <Icon name="download" />
      </a>
      {doomed && (
        <button class="btn" aria-label="Delete" title="Delete" onClick={() => store.askDelete(doomed)}>
          <Icon name="trash" />
        </button>
      )}
    </div>
  );
}

/**
 * One folder as a column: its own bar, then its first entries as the main list draws them, in name order.
 * `followed` marks the first entry: the next column is the inside of it.
 */
function Column({ folder, listing, followed, edge }: { folder: Entry; listing: Listing | undefined; followed: boolean; edge: boolean }) {
  // The listing on screen is the last one's until this folder's has come.
  const own = listing?.path === folder.path ? listing : undefined;
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
    <section class={edge ? "col edge" : "col"} aria-label={folder.name} data-pane={folder.path}>
      <FolderBar name={folder.name} path={folder.path} count={own?.total ?? folder.count} mtime={folder.mtime} doomed={config.delete ? folder : null} />
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

const plural = (n: number, one: string, many: string): string => `${fmt.count(n)} ${n === 1 ? one : many}`;

/**
 * The folder under the cursor while the preview is open: how much it holds, how large it is with everything in
 * it, what was written last, its notes, and the whole of it as a zip.
 */
function Folder({ folder }: { folder: Entry }) {
  const url = urls.folder(folder.path);
  const loaded = useLoaded<FolderSum>(url);
  // Numbers are of this folder or they are not shown: the last folder's would be wrong under this one's name.
  const sum = loaded.data?.path === folder.path ? loaded.data : undefined;
  const failed = loaded.failed === true && loaded.url === url;

  // The first move into a folder is the one move nothing was loaded ahead for. A folder the preview rests on
  // is likely to be entered, so its first previews are asked for now, as they would be on the way in.
  const rested = useSettled(folder.path, FOLDER_REST);
  const warm = rested ? urls.list(folder.path, FOLDER_WARM) : null;
  const first = useLoaded<Listing>(warm);
  useEffect(() => {
    if (!warm || first.url !== warm || first.data?.path !== folder.path) return;
    const files = first.data.entries.map((item, rank) => toEntry(item, folder.path, rank));
    lookAhead(files, -1, 1, versionOf, false, (file) => store.isRaw(file));
  }, [warm, first.url, first.data, folder.path]);

  const items = sum?.items ?? folder.count;
  const newest = sum?.newest ?? null;
  const within = (path: string): string => path.slice(folder.path.length + 1);
  return (
    <div class="pv-scroll fp" key={folder.path} data-name={folder.name} data-ready={sum ? "1" : undefined}>
      <div class="fp-in">
        <dl class="fp-stats" onMouseDown={keepFocus}>
          <div>
            <dt class="label">Items</dt>
            <dd class="num">{items === undefined ? "–" : fmt.count(items)}</dd>
            <span>
              {!sum
                ? " "
                : sum.items === 0
                  ? "This folder is empty"
                  : `${[plural(sum.files, "file", "files"), ...(sum.folders ? [plural(sum.folders, "folder", "folders")] : [])].join(" and ")} in all${sum.cut ? ", and more" : ""}`}
            </span>
          </div>
          <div>
            <dt class="label">Total size</dt>
            <dd class="num">{sum ? `${sum.cut ? "over " : ""}${fmt.size(sum.bytes)}` : "–"}</dd>
            <span>{!sum ? " " : sum.cut ? `Counted in the first ${fmt.count(sum.files + sum.folders)} entries` : "With everything in it"}</span>
          </div>
          <div>
            <dt class="label">Newest change</dt>
            <dd class="num">{sum ? (newest ? fmt.abs(newest.m) : "–") : "–"}</dd>
            {newest ? (
              <button class="trunc" title={`/${newest.path}`} onClick={() => void store.showDir(parentOf(newest.path), { select: nameOf(newest.path) })}>
                {within(newest.path)}
              </button>
            ) : (
              <span>{sum ? "No files in it" : " "}</span>
            )}
          </div>
        </dl>
        <div class="fp-do" onMouseDown={keepFocus}>
          <a class="btn btn-line" href={urls.zip(folder.path)} download>
            <Icon name="download" />
            Download as zip
          </a>
          <button class="btn btn-line" onClick={() => void store.showDir(folder.path)}>
            Open
            <kbd>↵</kbd>
          </button>
        </div>
        {failed && <p class="fp-note">This folder could not be read.</p>}
        {sum?.readme && (
          <section class="fp-readme">
            <div class="readme-hd label">
              <KindIcon kind="md" />
              {sum.readme.name}
            </div>
            <Prose html={sum.readme.html} />
          </section>
        )}
      </div>
    </div>
  );
}

export function Side({ slots }: { slots: number }) {
  const { s } = store;
  const cur = store.cur();
  const file = s.open ?? (cur && !cur.dir ? cur : null);
  const folder = !s.open && cur?.dir ? cur : null;

  const [facts, setFacts] = useState<{ path: string; list: string[] }>({ path: "", list: [] });
  const report = useCallback((path: string, list: string[]) => {
    setFacts((old) => (old.path === path && old.list.join() === list.join() ? old : { path, list }));
  }, []);

  // A folder has its columns while the preview is closed, and is added up in the pane while it is open.
  const columns = folder && !s.peek ? folder : null;
  const summed = folder && s.peek ? folder : null;
  const { data } = useLoaded<Listing>(columns ? columnsUrl(columns.path) : null);
  const levels = columns ? columnsOf(startingAt(data, columns.path), slots) : [];

  const unpeek = s.peek && !s.open && (
    <button class="btn" aria-label="Close the preview" title="Close the preview (space)" onClick={() => store.setPeek(false)}>
      <Icon name="close" />
    </button>
  );
  let header: ComponentChildren = null;
  if (file) {
    const learned = facts.path === file.path ? facts.list : [];
    const files = s.open ? store.files() : [];
    const raw = store.isRaw(file);
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
        {hasSource(file) && (
          <button class="btn" aria-label="Show the source" aria-pressed={raw} title={raw ? "Show it rendered (r)" : "Show the source (r)"} onClick={() => store.flipRaw()}>
            <Icon name="code" />
          </button>
        )}
        <a class="btn" href={urls.raw(file.path)} download aria-label="Download" title="Download">
          <Icon name="download" />
        </a>
        {config.delete && (
          <button class="btn" aria-label="Delete" title={`Delete (${DELETE_KEY})`} onClick={() => store.askDelete(file)}>
            <Icon name="trash" />
          </button>
        )}
        <button class="btn widen" aria-label={s.open ? "Back to the list" : "Full width"} title={s.open ? "Back to the list (esc)" : "Full width (↵)"} onClick={() => (s.open ? store.close() : store.activate())}>
          <Icon name={s.open ? "pane" : "expand"} />
        </button>
      </>
    );
  } else if (summed) {
    header = (
      <>
        <KindIcon kind="folder" />
        <span class="nm trunc">{summed.name}</span>
        <span class="facts trunc num">{fmt.abs(summed.mtime)}</span>
        {config.delete && (
          <button class="btn" aria-label="Delete" title={`Delete (${DELETE_KEY})`} onClick={() => store.askDelete(summed)}>
            <Icon name="trash" />
          </button>
        )}
        {unpeek}
      </>
    );
  } else if (!cur) {
    header = (
      <>
        <span class="sp" />
        {unpeek}
      </>
    );
  }

  return (
    <section class="right">
      {/* First in the page and last on screen: a column that comes or goes never moves the pane, whose frames
          would load again if it did. */}
      {!columns && (
        <div class="pane" key="pane" data-pane="">
          <div class="ph" onMouseDown={keepFocus}>
            {header}
          </div>
          <div class="pv">
            {file && <Preview entry={file} stamp={store.stamp(file)} report={report} raw={store.isRaw(file)} />}
            {summed && <Folder folder={summed} />}
          </div>
        </div>
      )}
      {levels.map((listing, level) => {
        const above = levels[level - 1];
        const first = above?.entries[0];
        // The folder under the cursor heads the first column. Each one after is the first entry of the one before.
        const head = level === 0 ? columns : above && first ? toEntry(first, above.path, 0) : null;
        return head && <Column key={level} folder={head} listing={listing} followed={level + 1 < levels.length} edge={level === slots - 2} />;
      })}
    </section>
  );
}
