import { useRef, useState, type ReactNode } from "react";
import { mountIn, session, ui, type Entry } from "./demo";
import { useLazy } from "./lazy";

export function Binary() {
  const stats = ui.use();
  const { demo } = session.use();
  const view = useRef<HTMLDivElement>(null);
  const live = useRef<Entry>(undefined);
  const written = useRef(0);
  const [monthDir, setMonthDir] = useState<string | null>(null);
  const [path, setPath] = useState("/notes/");
  const [wrote, setWrote] = useState<ReactNode>(null);

  // 05: the folder, followed.
  if (demo && monthDir === null) {
    // Today's folder, which only the browser knows.
    const today = new Date();
    const dir = `notes/${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}`;
    setMonthDir(dir);
    setPath(`/${dir}/`);
  }
  useLazy(view, !!demo && monthDir !== null, () => (live.current = mountIn(demo!, view.current!, view.current!.dataset.start!, { onPath: setPath })));

  const write = async () => {
    if (!demo) return;
    const dir = monthDir!;
    written.current += 1;
    const stamp = new Date();
    const name = `visitor-${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}${String(stamp.getSeconds()).padStart(2, "0")}.md`;
    const t0 = performance.now();
    await demo.backend.write(dir, name, `# A note from a visitor\n\nWritten at ${stamp.toISOString()} from the okfs demo page.\n`);
    const ms = performance.now() - t0;
    setWrote(
      <>
        Wrote <code>{name}</code>. The index read the folder again in {ms.toFixed(1)} ms and told the open page. A search for <code>visitor</code> finds {written.current === 1 ? "it" : `all ${written.current}`}.
      </>,
    );
    if (live.current && live.current.path() !== `/${dir}/`) void live.current.drive.go(`/${dir}/`);
  };

  return (
    <section className="border-t border-t-rule" id="binary">
      <div className="mx-auto max-w-[1440px] px-10 under-860:px-4">
        <div className="grid grid-cols-[90px_minmax(0,1fr)_minmax(0,440px)] items-baseline gap-x-10 pt-24 pb-10 under-1000:grid-cols-[minmax(0,1fr)] under-1000:gap-y-3.5 under-860:pt-16 under-860:pb-7">
          <span className="[font:500_13px/1_var(--mono)] text-ink-3">
            05 Binary
          </span>
          <h2 className="m-0 font-sans font-[760] text-[length:clamp(34px,4.4vw,68px)] leading-[.98] font-stretch-[112%] tracking-[-.03em] text-balance *:not-italic *:text-spot">
            {"The page is "}
            <em>
              inside the binary.
            </em>
          </h2>
          <div>
            <p className="m-0 text-pretty text-ink-2">
              Nothing is fetched from another site while okfs runs. It is read only unless you turn writes on, and it follows the folder: a file added, removed, renamed or rewritten on disk shows at once, with no reload.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-16 gap-y-10 pb-12 under-1000:grid-cols-[minmax(0,1fr)]">
          <pre className="m-0 overflow-x-auto bg-bg-2 px-5 py-4.5 [font:14px/1.65_var(--mono)] text-ink-2" aria-label="okfs starting in a terminal">
            <span className="text-spot select-none">
              {"$ "}
            </span>
            <b className="font-[400] text-ink">
              okfs ~/tidewater
            </b>
            {"\nokfs "}
            <span id="term-version">
              {stats.version}
            </span>
            {"\n  serving  ~/tidewater (read only)\n  at       http://127.0.0.1:8080/\n  theme    default"}
          </pre>
          <dl className={"m-0 grid grid-cols-[max-content_minmax(0,1fr)] [align-content:start] gap-x-5.5 gap-y-3 text-[15px] under-760:grid-cols-[minmax(0,1fr)] under-760:gap-1 [&_dd]:m-0 [&_dd]:text-ink-2 under-760:[&_dd]:mb-3 [&_dt]:[font:14px/1.5_var(--mono)] [&_dt]:text-ink"}>
            <dt>
              --bind 0.0.0.0 --qr
            </dt>
            <dd>
              Let other machines on the network in, and print a QR code for a phone.
            </dd>
            <dt>
              --allow-upload --allow-edit
            </dt>
            <dd>
              {"Off by default. Add files and folders by dropping them on the list, and edit text files in place. "}
              <code>
                --allow-delete
              </code>
              {" deletes."}
            </dd>
            <dt>
              --rescan 6h
            </dt>
            <dd>
              Read the tree again on a timer, for a tree too big to watch or a network share.
            </dd>
            <dt>
              --index index.html
            </dt>
            <dd>
              A folder that holds that file opens as its page, so a folder can be a small site.
            </dd>
          </dl>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-3 pb-10">
          <button className="inline-flex flex-none cursor-pointer items-center gap-2.5 border border-ink bg-transparent px-4 py-2.75 [font:15px/1_var(--mono)] hover:bg-ink hover:text-bg" type="button" id="write" onClick={write}>
            Write a note into the folder
          </button>
          <div className="min-w-[260px] flex-1 text-[15px] text-ink-2" id="wrote" aria-live="polite">
            {wrote ?? "This adds a file to the demo folder. The okfs below shows it without a reload."}
          </div>
        </div>
      </div>
      <div className="relative h-[clamp(420px,62vh,640px)] border-t border-t-rule bg-ok-bg under-760:h-[clamp(420px,70svh,640px)]" id="live-view" ref={view} data-start={monthDir === null ? "/notes/" : `/${monthDir}/`}></div>
      <div className="flex h-[34px] flex-none items-stretch border-t border-t-rule bg-bg [font:12.5px/34px_var(--mono)] whitespace-nowrap under-1100:h-auto under-1100:flex-wrap">
        <span className="flex-none bg-spot px-3 font-[600] tracking-[.04em] text-spot-ink under-1100:h-[34px]">
          OKFS
        </span>
        <span className="min-w-0 flex-[0_1_auto] truncate border-r border-r-rule px-3 text-ink under-1100:h-[34px] under-1100:flex-[1_1_0] under-1100:border-r-0" data-path-for="live">
          {path}
        </span>
      </div>
    </section>
  );
}
