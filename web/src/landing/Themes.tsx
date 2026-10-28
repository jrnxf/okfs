import { useEffect, useRef, useState } from "react";
import { mountIn, session } from "./demo";
import { useLazy } from "./lazy";
import { scheme } from "./scheme";
import { sleep } from "./store";

const BLURBS: Record<string, string> = {
  default: "Warm greys and one orange.",
  "tokyo-night": "Neon at night, crisp blue by day.",
  catppuccin: "Pastel Latte and Mocha.",
  "rose-pine": "Soft rose and pine.",
  gruvbox: "Retro, warm, high contrast.",
  kanagawa: "Ink, gold and indigo.",
  everforest: "Calm greens.",
  nord: "Arctic blue-greys.",
  solarized: "The classic, one blue accent.",
  one: "One Light and One Dark.",
  flexoki: "Inky, paper-warm.",
};

interface ThemeInfo {
  id: string;
  name: string;
  dark: string[];
  light: string[];
}

// 04: themes. okfs reads ?theme= when its page starts, so each choice starts it again.
export function Themes() {
  const { demo } = session.use();
  const view = useRef<HTMLDivElement>(null);
  const [path, setPath] = useState("/");
  const [themes, setThemes] = useState<ThemeInfo[]>([]);
  const [shown, setShown] = useState<{ id: string; scheme: string } | null>(null);
  const choice = useRef({ id: "tokyo-night", scheme: "dark" });

  useEffect(() => {
    if (!demo) return;
    choice.current.scheme = scheme();
    void demo.backend.answer("/").then((r) => setThemes(JSON.parse(r.body.match(/>(.*)</s)![1]!).themes));
  }, [demo]);

  const show = () => setShown({ ...choice.current });
  useLazy(view, themes.length > 0, show);

  // The folder with field-notes.md under the cursor, rendered: the list, the icons and the prose all take the theme.
  useEffect(() => {
    if (!demo || !shown) return;
    const entry = mountIn(demo, view.current!, `/?theme=${shown.id}&scheme=${shown.scheme}`, { onPath: setPath });
    void entry.handle.whenReady().then(async () => {
      const d = entry.drive;
      await sleep(250);
      d.key("Home");
      for (let i = 0; i < 11; i++) d.key("j");
      await sleep(450);
      d.key("r");
    });
  }, [shown]);

  return (
    <section className="border-t border-t-rule" id="themes">
      <div className="mx-auto max-w-[1440px] px-10 under-860:px-4">
        <div className="grid grid-cols-[90px_minmax(0,1fr)_minmax(0,440px)] items-baseline gap-x-10 pt-24 pb-10 under-1000:grid-cols-[minmax(0,1fr)] under-1000:gap-y-3.5 under-860:pt-16 under-860:pb-7">
          <span className="[font:500_13px/1_var(--mono)] text-ink-3">
            04 Themes
          </span>
          <h2 className="m-0 font-sans font-[760] text-[length:clamp(34px,4.4vw,68px)] leading-[.98] font-stretch-[112%] tracking-[-.03em] text-balance *:not-italic *:text-spot">
            {"A theme is "}
            <em>
              one CSS file.
            </em>
          </h2>
          <div>
            <p className="m-0 text-pretty text-ink-2">
              {"Eleven come built in, each light and dark, and the palette switches between them. A theme sets 42 tokens and nothing else. "}
              <code>
                okfs theme check
              </code>
              {" holds a file to that contract, contrast included."}
            </p>
          </div>
        </div>
        <div className="mb-10 overflow-hidden border-t border-t-rule">
          <ul className="m-0 -mr-px -mb-px grid list-none grid-cols-[repeat(5,minmax(0,1fr))] gap-0 p-0 under-1180:grid-cols-[repeat(3,minmax(0,1fr))] under-760:grid-cols-[minmax(0,1fr)]" id="theme-list" aria-label="okfs themes">
            {themes.map((t) => {
              const [bg, fg, accent] = t.dark as [string, string, string];
              const [lbg, , laccent] = t.light as [string, string, string];
              const dot = "size-3.5 rounded-[50%] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ink)_18%,transparent)]";
              return (
                <li key={t.id}>
                  {/* Rows of five, then of three, and on a phone a list with the swatches beside the name. Every cell rules
                      its right and bottom edge; the list's frame clips the ones that fall on its own edge. */}
                  <button
                    type="button"
                    data-id={t.id}
                    aria-pressed={shown?.id === t.id}
                    className="group grid h-full w-full cursor-pointer gap-1.5 border-0 border-r border-b border-r-rule border-b-rule bg-transparent px-4 pt-4 pb-4.5 text-left aria-pressed:shadow-[inset_0_3px_0_var(--spot)] under-760:grid-cols-[auto_minmax(0,1fr)] under-760:items-center under-760:gap-x-3.5"
                    onClick={() => {
                      choice.current.id = t.id;
                      show();
                    }}
                  >
                    <span className="flex gap-0.75 text-[14px] text-ink-2 under-760:[grid-row:span_2]" aria-hidden="true">
                      {[lbg, bg, fg, accent, laccent].map((c, n) => (
                        <i key={n} className={dot} style={{ background: c }}></i>
                      ))}
                    </span>
                    <b className="font-sans text-[20px] leading-[1.1] font-[700] font-stretch-[112%] group-hover:text-spot">{t.name}</b>
                    <span className="text-[14px] text-ink-2">{BLURBS[t.id] ?? ""}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <div className="relative h-[clamp(420px,62vh,640px)] border-t border-t-rule bg-ok-bg under-760:h-[clamp(420px,70svh,640px)]" id="themes-view" ref={view} data-start="/"></div>
      <div className="flex h-[34px] flex-none items-stretch border-t border-t-rule bg-bg [font:12.5px/34px_var(--mono)] whitespace-nowrap under-1100:h-auto under-1100:flex-wrap">
        <span className="flex-none bg-spot px-3 font-[600] tracking-[.04em] text-spot-ink under-1100:h-[34px]">
          OKFS
        </span>
        <span className="min-w-0 flex-[0_1_auto] truncate border-r border-r-rule px-3 text-ink under-1100:h-[34px] under-1100:flex-[1_1_0] under-1100:border-r-0" data-path-for="themes">
          {path}
        </span>
        <span className="flex-1 p-0 under-1100:hidden"></span>
        <span className="flex flex-none p-0" role="group" aria-label="okfs scheme">
          <button className="cursor-pointer border-0 border-l border-l-rule bg-transparent px-3 py-0 text-ink-2 aria-pressed:bg-bg-2 aria-pressed:text-ink" type="button" data-scheme="dark" aria-pressed={(shown?.scheme ?? "dark") === "dark"} onClick={() => { if (!themes.length) return; choice.current.scheme = "dark"; show(); }}>
            dark
          </button>
          <button className="cursor-pointer border-0 border-l border-l-rule bg-transparent px-3 py-0 text-ink-2 aria-pressed:bg-bg-2 aria-pressed:text-ink" type="button" data-scheme="light" aria-pressed={(shown?.scheme ?? "dark") === "light"} onClick={() => { if (!themes.length) return; choice.current.scheme = "light"; show(); }}>
            light
          </button>
        </span>
      </div>
    </section>
  );
}
