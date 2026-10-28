import { useEffect, useRef, useState } from "react";
import { loadDemo, mountIn } from "./demo";
import { useScheme } from "./scheme";

const BLURBS: Record<string, string> = {
  default: "Warm greys, one orange.",
  "tokyo-night": "Neon at night.",
  catppuccin: "Pastel Latte and Mocha.",
  "rose-pine": "Soft rose and pine.",
  gruvbox: "Retro and warm.",
  kanagawa: "Ink, gold and indigo.",
  everforest: "Calm greens.",
  nord: "Arctic blue-greys.",
  solarized: "The classic.",
  one: "From the Atom editor.",
  flexoki: "Inky, paper-warm.",
};

interface ThemeInfo {
  id: string;
  name: string;
  light: string[];
  dark: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fig. 3: the themes, as finishes. They load when the section is near, and each one starts its own okfs. */
export function Finishes() {
  const section = useRef<HTMLElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const [themes, setThemes] = useState<ThemeInfo[]>([]);
  const [themeId, setThemeId] = useState("tokyo-night");
  const scheme = useScheme();
  useEffect(() => {
    const watch = new IntersectionObserver(
      async ([e], obs) => {
        if (!e!.isIntersecting) return;
        obs.disconnect();
        const { backend } = await loadDemo();
        setThemes(await backend.answer("/").then((r) => JSON.parse(r.body.match(/>(.*)</s)![1]!).themes));
      },
      { rootMargin: "300px 0px" },
    );
    watch.observe(section.current!);
    return () => watch.disconnect();
  }, []);
  // okfs reads ?theme= when its page starts, so each finish starts it again, with field-notes.md rendered. The plate
  // starts in the page's scheme; it is started again when the scheme changes, so its caption holds.
  useEffect(() => {
    if (!themes.length) return;
    void mountIn(view.current!, `/?theme=${themeId}`, `okfs in its ${themeId} theme`, "absolute inset-0 size-full", false).then((shown) =>
      shown.handle.whenReady().then(async () => {
        await sleep(250);
        shown.drive.key("Home");
        for (let i = 0; i < 11; i++) shown.drive.key("j");
        await sleep(450);
        shown.drive.key("r");
      }),
    );
  }, [themes, themeId, scheme]);
  return (
    <section id="finishes" className="scroll-mt-3 pt-16" aria-labelledby="finishes-h" ref={section}>
      <div className="mb-6.5 grid grid-cols-[160px_1fr] gap-6 border-t-3 [border-top-style:double] border-t-rule pt-4.5 tablet:grid-cols-[1fr] tablet:gap-2">
        <div className="[font:500_12px/1.4_var(--mono)] tracking-[.1em] text-spot-ink uppercase">
          Fig. 3
          <br />
          Finishes
        </div>
        <div>
          <h2 className="m-0 font-serif font-[500] text-[length:clamp(30px,3.4vw,46px)] leading-[1.05] [font-variation-settings:'opsz'_96,'SOFT'_100,'WONK'_1] tracking-[-.01em]" id="finishes-h">
            Available in eleven finishes, light and dark.
          </h2>
          <p className="mt-2.5 mb-0 max-w-[62ch] text-ink-2">
            {"Each theme is one CSS file. Pick one with "}
            <code>
              --theme
            </code>
            , or write your own.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-[300px_1fr] [align-items:start] gap-6 tablet:grid-cols-[1fr] ml-46 tablet:ml-0">
        <ul className="m-0 grid list-none gap-2.5 p-0" id="chips" aria-label="Themes">
          {themes.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className="grid w-full grid-cols-[70px_1fr] items-center gap-3 rounded-[3px] border border-rule-soft bg-transparent p-2 text-left [font:400_15px/1.25_var(--serif)] aria-pressed:border-spot aria-pressed:shadow-[inset_0_0_0_1px_var(--spot)]"
                data-id={t.id}
                aria-pressed={t.id === themeId}
                onClick={() => setThemeId(t.id)}
              >
                <span className="flex h-[34px] overflow-hidden rounded-[2px] border border-[rgba(0,0,0,.2)] *:flex-1" aria-hidden="true">
                  <i style={{ background: t.light[0] }}></i>
                  <i style={{ background: t.light[2] }}></i>
                  <i style={{ background: t.dark[0] }}></i>
                  <i style={{ background: t.dark[2] }}></i>
                </span>
                <span>
                  <b className="block font-[600]">{t.name}</b>
                  <small className="text-[13px] text-ink-2">{BLURBS[t.id] ?? ""}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="border border-rule bg-paper-2 p-2.5">
          <div className="relative h-[470px] overflow-hidden bg-paper phone:h-[70vh]" id="theme-view" ref={view}></div>
          <p className="pt-2 [font:400_12px/1.4_var(--mono)] text-ink-2" id="theme-cap">
            {themes.length ? `Plate: the ${themeId} finish, ${scheme}.` : "Plate: the tokyo-night finish."}
          </p>
        </div>
      </div>
    </section>
  );
}
