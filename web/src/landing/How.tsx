import type { CSSProperties } from "react";

export function How() {
  return (
    <section className="border-t border-t-rule" id="how">
      <div className="mx-auto max-w-[1440px] px-10 under-860:px-4">
        <div className="grid grid-cols-[90px_minmax(0,1fr)_minmax(0,440px)] items-baseline gap-x-10 pt-24 pb-10 under-1000:grid-cols-[minmax(0,1fr)] under-1000:gap-y-3.5 under-860:pt-16 under-860:pb-7">
          <span className="[font:500_13px/1_var(--mono)] text-ink-3">
            06 This page
          </span>
          <h2 className="m-0 font-sans font-[760] text-[length:clamp(34px,4.4vw,68px)] leading-[.98] font-stretch-[112%] tracking-[-.03em] text-balance *:not-italic *:text-spot">
            {"What is okfs here, "}
            <em>
              and what is not.
            </em>
          </h2>
          <div>
            <p className="m-0 text-pretty text-ink-2">
              Nothing on this page talks to a server once it has loaded. This is what runs okfs&apos;s own code, and what was recorded or made for the demo.
            </p>
          </div>
        </div>
        <div className={"grid grid-cols-[repeat(3,minmax(0,1fr))] gap-10 pb-24 under-860:grid-cols-[minmax(0,1fr)] under-860:gap-6 under-860:pb-16 [&_h3]:mt-0 [&_h3]:mb-3.5 [&_h3]:border-t [&_h3]:border-t-ink [&_h3]:pt-3.5 [&_h3]:[font:400_13px/1.4_var(--mono)] [&_h3]:text-ink [&_h3_i]:mr-2 [&_h3_i]:inline-block [&_h3_i]:size-2 [&_h3_i]:rounded-[50%] [&_h3_i]:bg-(--c) [&_ul]:m-0 [&_ul]:grid [&_ul]:list-none [&_ul]:gap-3 [&_ul]:p-0 [&_ul]:text-[15px] [&_ul]:text-ink-2"}>
          <div>
            <h3>
              <i style={{ "--c": "var(--spot)" } as CSSProperties}></i>
              okfs&apos;s own code
            </h3>
            <ul>
              <li>
                The page: okfs&apos;s interface, built from its source as the binary ships it.
              </li>
              <li>
                {"The index: "}
                <code>
                  src/index.rs
                </code>
                , compiled to WebAssembly. It walks the folder, leaves out what okfs leaves out, and answers every search, list of recent files and count.
              </li>
              <li>
                The listings: okfs&apos;s code for a folder&apos;s entries, with its sorting and its hidden files.
              </li>
            </ul>
          </div>
          <div>
            <h3>
              <i style={{ "--c": "#a892ea" } as CSSProperties}></i>
              Recorded or made for the demo
            </h3>
            <ul>
              <li>
                Text previews: the Markdown, code, tables and JSON as a real okfs drew them.
              </li>
              <li>
                The folder itself: this page builds it in your browser from a seed, and draws its pictures and its bell sound.
              </li>
            </ul>
          </div>
          <div>
            <h3>
              <i style={{ "--c": "var(--ink-3)" } as CSSProperties}></i>
              Only on your machine
            </h3>
            <ul>
              <li>
                Your own files. Here many names share one film, one PDF and one sound.
              </li>
              <li>
                Thumbnails, a picture of a PDF&apos;s first page, folders as zips, and deleting.
              </li>
              <li>
                Search on every core. Here it runs on one thread.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
