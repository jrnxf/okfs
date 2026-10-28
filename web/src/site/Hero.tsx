import { useEffect, useRef, useState } from "react";
import type { Demo } from "../runtime";
import { mountIn } from "./demo";

/** Drawn at --fw by --fh, and scaled by --k to the width of the glass. */
const ON_SCREEN = "absolute top-0 left-0 h-[var(--fh,750px)] w-[var(--fw,1000px)] origin-top-left [transform:scale(var(--k,.6))]";

/** Fig. 1: okfs on the screen, drawn wide and scaled to fit the glass. */
export function Hero({ demo, failed, sub }: { demo?: Demo; failed: boolean; sub: string }) {
  const screen = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const glass = screen.current!;
    const fit = () => {
      const w = glass.clientWidth;
      const portrait = glass.clientHeight > w;
      const fw = portrait ? 420 : 1000;
      const fh = portrait ? 560 : 750;
      glass.style.setProperty("--k", (w / fw).toFixed(4));
      glass.style.setProperty("--fw", `${fw}px`);
      glass.style.setProperty("--fh", `${fh}px`);
    };
    const watch = new ResizeObserver(fit);
    watch.observe(glass);
    fit();
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    if (!demo) return;
    void mountIn(view.current!, "/photos/", "okfs serving the demo folder, on the screen", ON_SCREEN).then(({ handle }) =>
      handle.whenReady().then(() => setReady(true)),
    );
  }, [demo]);
  return (
    <div className="grid grid-cols-[7fr_5fr] [align-items:start] gap-14 pt-11 pb-14 tablet:grid-cols-[1fr] tablet:gap-8.5 phone:pt-6">
      <div>
        <div className="relative mx-auto max-w-[720px]">
          <div className="relative rounded-[18px_18px_10px_10px] bg-[linear-gradient(180deg,var(--beige)_0%,var(--beige-2)_100%)] px-7.5 pt-6.5 pb-14 shadow-[inset_0_-6px_0_var(--beige-3),inset_0_2px_0_rgba(255,255,255,.5),0_30px_40px_-28px_rgba(0,0,0,.55)] after:absolute after:bottom-5 after:left-7.5 after:h-3.5 after:w-16 after:rounded-[2px] after:bg-[repeating-linear-gradient(90deg,var(--beige-3)_0_2px,transparent_2px_5px)] after:content-[''] phone:rounded-[12px_12px_8px_8px] phone:px-3.5 phone:pt-3.5 phone:pb-10 phone:after:bottom-3.5 phone:after:left-3.5 phone:after:h-2.5 phone:after:w-10">
            <div className="rounded-[14px] bg-[#2a2722] p-4 shadow-[inset_0_0_0_3px_#1c1a17] phone:rounded-[10px] phone:p-2.25">
              <div className="relative aspect-[4/3] overflow-hidden rounded-[22px/18px] bg-glass after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:bg-[linear-gradient(160deg,rgba(255,255,255,.07),transparent_40%)] after:shadow-[inset_0_0_40px_rgba(0,0,0,.45)] after:content-[''] phone:aspect-[3/4] phone:rounded-[14px/12px]" id="screen" ref={screen}>
                <div className="absolute inset-0" id="view" ref={view}>
                  {!ready && (
                    <div className="absolute inset-0 grid place-content-center p-5 text-center [font:400_14px/1.5_var(--mono)] text-[#c9f2c4]" id="boot">
                      {failed ? (
                        "okfs could not start in this browser. The demo link beside it may work."
                      ) : (
                        <span>
                          okfs is starting
                          <br />
                          <span id="boot-sub">{sub}</span>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <svg className="logo absolute right-7.5 bottom-3.5 w-[84px] [--logo-ink:#3b352a] [--logo-spot:#e8501c] phone:right-3.5 phone:bottom-2.5 phone:w-16" viewBox="0 0 2647 850" aria-hidden="true">
              <use href="#okfs-logo" width="2647" height="850" />
            </svg>
          </div>
          <div className="mx-auto h-5 w-[46%] bg-[linear-gradient(180deg,var(--beige-3),var(--beige-2))] [clip-path:polygon(8%_0,92%_0,100%_100%,0_100%)]"></div>
          <div className="relative mx-auto h-11 w-[92%] rounded-[6px_6px_10px_10px] bg-beige shadow-[inset_0_-5px_0_var(--beige-3)] before:absolute before:inset-[8px_14px_14px] before:rounded-[2px] before:bg-[repeating-linear-gradient(90deg,var(--beige-2)_0_18px,transparent_18px_22px)] before:content-['']"></div>
        </div>
        <p className={"mt-3.5 [font:400_13px/1.45_var(--mono)] text-ink-2 [&_b]:text-ink"}>
          <b>
            Fig. 1.
          </b>
          {" okfs, running on the screen above. It is the real program, compiled for this page; click into it and press "}
          <b>
            j
          </b>
          {", or "}
          <b>
            Ctrl K
          </b>
          {" to search."}
        </p>
      </div>
      <div className="tablet:-order-1">
        <div className="[font:500_13px/1_var(--mono)] tracking-[.08em] text-spot-ink">
          Item 0.1.0
        </div>
        <svg className="logo mt-4.5 mb-4 w-[min(380px,100%)]" viewBox="0 0 2647 850" role="img" aria-label="okfs">
          <use href="#okfs-logo" width="2647" height="850" />
        </svg>
        <h1 className="mt-0 mb-4.5 font-serif font-[500] text-[length:clamp(30px,3.1vw,42px)] leading-[1.08] [font-variation-settings:'opsz'_72,'SOFT'_100,'WONK'_1] tracking-[-.01em]">
          A file browser for any folder you can reach.
        </h1>
        <p className="mt-0 mb-3.5">
          {"Run "}
          <code>
            okfs
          </code>
          {" in a folder and your browser opens on it. The list sits on the left. The file under the cursor shows beside it as soon as the cursor lands, so holding "}
          <b>
            j
          </b>
          {" flips through a folder of photos, PDFs or video."}
        </p>
        <ul className="my-5.5 list-none border-t border-t-rule p-0 [font:400_14px/1.4_var(--mono)] *:flex *:gap-2 *:border-b *:border-b-rule-faint *:py-1.75">
          <li>
            <span className="text-ink-2">
              Runs on
            </span>
            <span className="min-w-5 flex-1 border-b [border-bottom-style:dotted] border-b-ink-2 [transform:translateY(-5px)]"></span>
            <span>
              Linux, macOS
            </span>
          </li>
          <li>
            <span className="text-ink-2">
              Ships as
            </span>
            <span className="min-w-5 flex-1 border-b [border-bottom-style:dotted] border-b-ink-2 [transform:translateY(-5px)]"></span>
            <span>
              one binary, about 18 MB
            </span>
          </li>
          <li>
            <span className="text-ink-2">
              Serves at
            </span>
            <span className="min-w-5 flex-1 border-b [border-bottom-style:dotted] border-b-ink-2 [transform:translateY(-5px)]"></span>
            <span>
              127.0.0.1:8080
            </span>
          </li>
          <li>
            <span className="text-ink-2">
              Writes files
            </span>
            <span className="min-w-5 flex-1 border-b [border-bottom-style:dotted] border-b-ink-2 [transform:translateY(-5px)]"></span>
            <span>
              only when turned on
            </span>
          </li>
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-5.5">
          <div className="font-serif font-[600] text-[34px] leading-[1] [font-variation-settings:'opsz'_144,'SOFT'_100,'WONK'_1]">
            Free
            <small className="mt-1 block [font:400_12px/1.3_var(--mono)] text-ink-2">
              MIT licence
            </small>
          </div>
          <a className="inline-flex flex-col gap-1 rounded-[4px] bg-spot px-4.5 py-3.25 [font:600_17px/1_var(--serif)] text-on-spot no-underline hover:bg-ink hover:text-paper" href="/demo/">
            {"Open the live demo "}
            <small className="[font:400_12px/1_var(--mono)]">
              okfs, the whole page
            </small>
          </a>
        </div>
      </div>
    </div>
  );
}
