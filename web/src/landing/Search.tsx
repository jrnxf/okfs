import { useEffect, useRef, useState, type ReactNode } from "react";
import { hero, session, ui } from "./demo";
import { fmt, reduced, sleep } from "./store";

// The search box's answers, in two columns. The list starts with the empty one.
const HIT_BASE = "grid-cols-[18px_minmax(0,1fr)] gap-x-2 break-inside-avoid py-2";
const HIT = `${HIT_BASE} group grid cursor-pointer border-b border-b-rule`;
const HIT_EMPTY = `${HIT_BASE} block cursor-default border-0 text-[15px] text-ink-3 [column-span:all]`;

const marked = (text: string, idx: number[], offset: number) => {
  const at = new Set(idx.map((i) => i - offset));
  const out: ReactNode[] = [];
  let plain = "";
  [...text].forEach((c, i) => {
    if (!at.has(i)) return void (plain += c);
    if (plain) out.push(plain);
    plain = "";
    out.push(
      <mark key={i} className="bg-transparent text-spot">
        {c}
      </mark>,
    );
  });
  if (plain) out.push(plain);
  return out;
};

interface Found {
  took: number;
  total: number;
  indexed: number;
  hits: { path: string; name?: boolean; dir?: boolean; idx: number[] }[];
}
type Answer = { empty: true } | { found: Found };

const SAMPLES = ["tide", "img_0042", "north pier 2024", "button.tsx", "readme", "survey pdf", "kelp flac"];

export function Search() {
  const stats = ui.use();
  const { demo } = session.use();
  const input = useRef<HTMLInputElement>(null);
  const asked = useRef(0);
  const [answer, setAnswer] = useState<Answer>({ empty: true });
  const [ms, setMs] = useState("-");
  const [total, setTotal] = useState("0");

  async function search(q: string) {
    const id = ++asked.current;
    if (!q.trim()) {
      setAnswer({ empty: true });
      setMs("-");
      setTotal("0");
      return;
    }
    const found = (await demo!.backend.search({ q, limit: 12 })) as Found;
    if (id !== asked.current) return;
    setMs(found.took.toFixed(1));
    setTotal(fmt(found.total));
    ui.set({ fMs: `${found.took.toFixed(0)} ms`, search: `${found.took.toFixed(1)} ms` });
    setAnswer({ found });
  }

  // The box opens with one search made, so the section shows what an answer looks like.
  useEffect(() => {
    if (!demo) return;
    input.current!.value = "tide";
    void search(input.current!.value);
  }, [demo]);

  return (
    <section className="border-t border-t-rule" id="search">
      <div className="mx-auto max-w-[1440px] px-10 under-860:px-4">
        <div className="grid grid-cols-[90px_minmax(0,1fr)_minmax(0,440px)] items-baseline gap-x-10 pt-24 pb-10 under-1000:grid-cols-[minmax(0,1fr)] under-1000:gap-y-3.5 under-860:pt-16 under-860:pb-7">
          <span className="[font:500_13px/1_var(--mono)] text-ink-3">
            01 Search
          </span>
          <h2 className="m-0 font-sans font-[760] text-[length:clamp(34px,4.4vw,68px)] leading-[.98] font-stretch-[112%] tracking-[-.03em] text-balance *:not-italic *:text-spot">
            {"Each letter searches "}
            <em>
              the whole tree.
            </em>
          </h2>
          <div>
            <p className="m-0 text-pretty text-ink-2">
              This box asks okfs&apos;s index directly: the Rust code from the binary, compiled to WebAssembly. A letter added to the end searches only what the letters before it matched.
            </p>
          </div>
        </div>
        <div className="mb-3.5 flex justify-between gap-5 [font:13px/1.5_var(--mono)] text-ink-3">
          <span>
            Search, answered by okfs&apos;s index
          </span>
          <span>
            <span id="find-total">
              {total}
            </span>
            {" matches, best first"}
          </span>
        </div>
        <label className="flex items-baseline gap-5.5 border-b-3 border-b-ink pb-2">
          <input className={"min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-[length:clamp(40px,6vw,96px)] leading-[1.05] font-[760] font-stretch-[112%] tracking-[-.03em] text-ink caret-spot outline-none placeholder:text-ink-3 placeholder:opacity-50 [&::-webkit-search-cancel-button]:hidden"} id="find" ref={input} onInput={() => demo && void search(input.current!.value)} type="search" placeholder="type a name" autoComplete="off" spellCheck="false" aria-label="Search the demo folder" />
          <span className="[font:500_clamp(18px,2vw,28px)/1_var(--mono)] whitespace-nowrap text-spot">
            <span id="find-ms">
              {ms}
            </span>
            {" ms"}
          </span>
        </label>
        <div className="mt-4 mb-6.5 flex flex-wrap gap-x-5 gap-y-1.5 [font:14px/1.5_var(--mono)] text-ink-3" id="samples">
          <span>
            try
          </span>
          {demo &&
            SAMPLES.map((q) => (
              <button
                key={q}
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 text-ink-2 hover:text-spot"
                onClick={async () => {
                  const find = input.current!;
                  find.value = "";
                  for (const ch of q) {
                    find.value += ch;
                    await search(find.value);
                    await sleep(reduced() ? 0 : 45);
                  }
                }}
              >
                {q}
              </button>
            ))}
        </div>
        <ul className="m-0 min-h-[200px] list-none columns-2 gap-x-10 p-0 under-860:columns-1" id="hits">
          {"empty" in answer ? (
            <li className={HIT_EMPTY}>Type a few letters of any name, or pick one above.</li>
          ) : answer.found.hits.length ? (
            answer.found.hits.map((h) => {
              const slash = h.path.lastIndexOf("/");
              const name = h.path.slice(slash + 1);
              const dir = slash < 0 ? "/" : h.path.slice(0, slash);
              const shown = h.name ? marked(name, h.idx, 0) : marked(name, h.idx, slash + 1);
              return (
                <li
                  key={h.path}
                  className={HIT}
                  data-path={h.path}
                  data-dir={h.dir ? 1 : 0}
                  onClick={() => {
                    void hero.entry!.drive.go(`/${h.path.split("/").map(encodeURIComponent).join("/")}${h.dir ? "/" : ""}`);
                    scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });
                  }}
                >
                  <span className="[font:13px/1.6_var(--mono)] text-ink-3">{h.dir ? "/" : ""}</span>
                  <span className="truncate [font:600_19px/1.3_var(--sans)] group-hover:text-spot">{shown}</span>
                  <span className="col-[2] truncate [font:12.5px/1.4_var(--mono)] text-ink-3">{dir}</span>
                </li>
              );
            })
          ) : (
            <li className={HIT_EMPTY}>Nothing matches. okfs looked through all {fmt(answer.found.indexed)} names.</li>
          )}
        </ul>
        <ul className="mt-14 mb-24 grid list-none grid-cols-[repeat(3,minmax(0,1fr))] gap-8 p-0 under-860:mt-10 under-860:mb-16 under-860:grid-cols-[minmax(0,1fr)] under-860:gap-6 *:border-t *:border-t-ink *:pt-3.5 *:text-[15px] *:text-ink-2">
          <li>
            <b className="mb-1.5 block [font:400_28px/1.1_var(--mono)] text-ink" id="f-count">
              {stats.fCount}
            </b>
            {"names in the demo folder, walked by okfs's own code when this page opened. "}
            <code>
              node_modules
            </code>
            {" and what a "}
            <code>
              .gitignore
            </code>
            {" names are left out, as on your disk."}
          </li>
          <li>
            <b className="mb-1.5 block [font:400_28px/1.1_var(--mono)] text-ink" id="f-ms">
              {stats.fMs}
            </b>
            for a search here, on one thread of your browser. On your machine okfs searches on every core.
          </li>
          <li>
            <b className="mb-1.5 block [font:400_28px/1.1_var(--mono)] text-ink">
              0
            </b>
            requests to a server while you search. Turn off the network and keep typing.
          </li>
        </ul>
      </div>
    </section>
  );
}
