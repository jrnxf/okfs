import { useRef, useState, type CSSProperties } from "react";
import { mountIn, session, type Entry } from "./demo";
import { useLazy } from "./lazy";

// The kinds of file to show: a label, an address and the color of its dot.
const KINDS: [string, string, string][] = [
  ["Picture", "/photos/05-headland.jpg", "#c05fb0"],
  ["Video", "/harbor-timelapse.webm", "#d9772b"],
  ["Sound", "/harbor-bell.wav", "#d9772b"],
  ["PDF", "/annual-survey-2025.pdf", "#8a8a86"],
  ["Markdown", "/field-notes.md", "#8a8a86"],
  ["Code", "/src/tide.rs", "#3f9b6c"],
  ["Table", "/stations.csv", "#b8922a"],
  ["JSON", "/gauges.json", "#b8922a"],
  ["Drawing", "/data/station-map.svg", "#c05fb0"],
  ["Web page", "/tide-chart.html", "#8a8a86"],
  ["Zip", "/survey-2026.zip", "#8a6fd1"],
];

export function Previews() {
  const { demo } = session.use();
  const view = useRef<HTMLDivElement>(null);
  const previews = useRef<Entry>(undefined);
  const [start, setStart] = useState("/photos/05-headland.jpg");
  const [pressed, setPressed] = useState("/photos/05-headland.jpg");
  const [path, setPath] = useState("/photos/05-headland.jpg");

  useLazy(view, !!demo, () => (previews.current = mountIn(demo!, view.current!, view.current!.dataset.start!, { onPath: setPath })));

  return (
    <section className="border-t border-t-rule" id="previews">
      <div className="mx-auto max-w-[1440px] px-10 under-860:px-4">
        <div className="grid grid-cols-[90px_minmax(0,1fr)_minmax(0,440px)] items-baseline gap-x-10 pt-24 pb-10 under-1000:grid-cols-[minmax(0,1fr)] under-1000:gap-y-3.5 under-860:pt-16 under-860:pb-7">
          <span className="[font:500_13px/1_var(--mono)] text-ink-3">
            03 Previews
          </span>
          <h2 className="m-0 font-sans font-[760] text-[length:clamp(34px,4.4vw,68px)] leading-[.98] font-stretch-[112%] tracking-[-.03em] text-balance *:not-italic *:text-spot">
            {"Pictures, film, sound, "}
            <em>
              pages and code.
            </em>
          </h2>
          <div>
            <p className="m-0 text-pretty text-ink-2">
              {"Each one shows in the same pane as the list. Markdown opens rendered and an HTML page runs sandboxed, in an origin of its own. SVG and JSON open as their source, colored and never run, and "}
              <code>
                r
              </code>
              {" flips any of them between the two."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2.5 pb-10 [font:15px/1.5_var(--mono)]" id="kinds" role="group" aria-label="Show a kind of file">
          {demo &&
            KINDS.map(([label, kind, color]) => (
              <button
                key={kind}
                type="button"
                data-path={kind}
                style={{ "--c": color } as CSSProperties}
                aria-pressed={kind === pressed}
                className="inline-flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-ink-2 hover:text-ink aria-pressed:text-ink aria-pressed:underline aria-pressed:decoration-spot aria-pressed:decoration-2 aria-pressed:underline-offset-6"
                onClick={() => {
                  setPressed(kind);
                  if (previews.current) void previews.current.drive.go(kind);
                  else setStart(kind);
                }}
              >
                <i className="size-[9px] rounded-[50%] bg-(--c)"></i>
                {label}
              </button>
            ))}
        </div>
      </div>
      <div className="relative h-[clamp(420px,62vh,640px)] border-t border-t-rule bg-ok-bg under-760:h-[clamp(420px,70svh,640px)]" id="previews-view" ref={view} data-start={start}></div>
      <div className="flex h-[34px] flex-none items-stretch border-t border-t-rule bg-bg [font:12.5px/34px_var(--mono)] whitespace-nowrap under-1100:h-auto under-1100:flex-wrap">
        <span className="flex-none bg-spot px-3 font-[600] tracking-[.04em] text-spot-ink under-1100:h-[34px]">
          OKFS
        </span>
        <span className="min-w-0 flex-[0_1_auto] truncate border-r border-r-rule px-3 text-ink under-1100:h-[34px] under-1100:flex-[1_1_0] under-1100:border-r-0" data-path-for="previews">
          {path}
        </span>
      </div>
    </section>
  );
}
