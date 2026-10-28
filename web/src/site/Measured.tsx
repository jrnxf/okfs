import { useState } from "react";
import type { BackendStatus } from "../backend";
import type { Demo } from "../runtime";

const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (n: number) => n.toLocaleString("en-US");

/** Fig. 2: what the page measured as okfs started, and five searches to time. */
export function Measured({ demo, status }: { demo?: Demo; status?: BackendStatus }) {
  const stats = demo?.stats;
  const [runs, setRuns] = useState<{ q: string; total: number; took: number }[]>([]);
  async function run() {
    setRuns([]);
    const done: typeof runs = [];
    for (const q of ["img_0042", "north pier 2024", "survey pdf", "button.tsx", "kelp flac"]) {
      const r: any = await demo!.backend.search({ q, limit: 1 });
      done.push({ q, total: r.total, took: r.took });
      setRuns([...done]);
      await sleep(reduced ? 0 : 160);
    }
  }
  return (
    <section id="measured" className="scroll-mt-3 pt-16" aria-labelledby="measured-h">
      <div className="mb-6.5 grid grid-cols-[160px_1fr] gap-6 border-t-3 [border-top-style:double] border-t-rule pt-4.5 tablet:grid-cols-[1fr] tablet:gap-2">
        <div className="[font:500_12px/1.4_var(--mono)] tracking-[.1em] text-spot-ink uppercase">
          Fig. 2
          <br />
          Measured here
        </div>
        <div>
          <h2 className="m-0 font-serif font-[500] text-[length:clamp(30px,3.4vw,46px)] leading-[1.05] [font-variation-settings:'opsz'_96,'SOFT'_100,'WONK'_1] tracking-[-.01em]" id="measured-h">
            Measured in your browser, a moment ago.
          </h2>
          <p className="mt-2.5 mb-0 max-w-[62ch] text-ink-2">
            When this page opened it unpacked okfs&apos;s index, compiled it and read a folder of about 300,000 names. These are its own timings.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-[1fr_1fr] gap-6 tablet:grid-cols-[1fr] ml-46 tablet:ml-0">
        <table className={"w-full border-collapse [font:400_15px/1.4_var(--mono)] [&_td]:border-b [&_td]:border-b-rule-faint [&_td]:px-0 [&_td]:py-2.5 [&_td]:align-baseline [&_td:last-child]:text-right [&_td:last-child]:font-[600] [&_td:last-child]:whitespace-nowrap [&_td:last-child]:text-spot-ink"}>
          <caption className="absolute h-px w-px overflow-hidden whitespace-nowrap [clip:rect(0_0_0_0)]">
            okfs&apos;s timings in this tab
          </caption>
          <tbody>
            <tr>
              <td>
                <span className="flex gap-2 after:flex-1 after:border-b after:[border-bottom-style:dotted] after:border-b-ink-2 after:[transform:translateY(-5px)] after:content-['']">
                  Index engine, WebAssembly
                </span>
              </td>
              <td id="b-size">{stats ? `${fmt(Math.round(stats.wasmBytes / 1024))} KB` : "-"}</td>
            </tr>
            <tr>
              <td>
                <span className="flex gap-2 after:flex-1 after:border-b after:[border-bottom-style:dotted] after:border-b-ink-2 after:[transform:translateY(-5px)] after:content-['']">
                  Unpacked
                </span>
              </td>
              <td id="b-unpack">{stats ? `${stats.unpackMs.toFixed(0)} ms` : "-"}</td>
            </tr>
            <tr>
              <td>
                <span className="flex gap-2 after:flex-1 after:border-b after:[border-bottom-style:dotted] after:border-b-ink-2 after:[transform:translateY(-5px)] after:content-['']">
                  Compiled
                </span>
              </td>
              <td id="b-compile">{stats ? `${stats.compileMs.toFixed(0)} ms` : "-"}</td>
            </tr>
            <tr>
              <td>
                <span className="flex gap-2 after:flex-1 after:border-b after:[border-bottom-style:dotted] after:border-b-ink-2 after:[transform:translateY(-5px)] after:content-['']">
                  Entries in the folder
                </span>
              </td>
              <td id="b-count">{status ? fmt(status.ready ? status.indexed : status.seen) : "-"}</td>
            </tr>
            <tr>
              <td>
                <span className="flex gap-2 after:flex-1 after:border-b after:[border-bottom-style:dotted] after:border-b-ink-2 after:[transform:translateY(-5px)] after:content-['']">
                  Read all of them
                </span>
              </td>
              <td id="b-walk">{status?.ready ? `${(status.walkMs / 1000).toFixed(2)} s` : "-"}</td>
            </tr>
          </tbody>
        </table>
        <div className="[font:400_14px/1.5_var(--mono)]">
          <button className="mb-3.5 border border-rule bg-transparent px-3 py-2.25 [font:500_13px/1_var(--mono)] disabled:cursor-default disabled:opacity-50 hover:not-disabled:bg-ink hover:not-disabled:text-paper" type="button" id="run" disabled={!status?.ready} onClick={run}>Search five names now</button>
          <ol className="m-0 list-none p-0 [counter-reset:r]" id="runs" aria-live="polite">
            {runs.map((r) => (
              <li
                key={r.q}
                className="grid grid-cols-[2.4em_1fr_auto] gap-2 border-b border-b-rule-faint py-1.5 before:text-ink-2 before:content-[counter(r)_'.'] before:[counter-increment:r]"
              >
                <span>
                  "{r.q}", {fmt(r.total)} matches
                </span>
                <b className="font-[600] text-spot-ink">{r.took.toFixed(1)} ms</b>
              </li>
            ))}
          </ol>
          <p className="mt-2.5 [font:400_12px/1.5_var(--mono)] text-ink-2">
            Each search ranks every name in the folder. The times are this tab&apos;s, with okfs compiled to WebAssembly.
          </p>
        </div>
      </div>
    </section>
  );
}
