import { useEffect, useRef, useState } from "react";
import { chips } from "./chips";
import { hero, mountIn, session, startDemo, ui, type Driver } from "./demo";
import { scheme, setScheme, onScheme } from "./scheme";
import { CopyButton } from "../shared/copy";
import { useTutorial } from "./tutorial";

// Placeholder rows in okfs's layout: the main list, then the folder under the cursor. Widths are fixed so the
// first paint is the same every time.
const WIDTHS = [[46, 58, 40, 64, 52, 44, 60, 38, 56, 48, 66, 42, 54, 50, 62, 36, 58, 44], [54, 40, 62, 48, 58, 36, 50, 44, 60]];
function Rows({ col }: { col: number }) {
  return (
    <>
      {(WIDTHS[col] ?? []).map((w, n) => {
        // The cursor's row, at the top of the list.
        const cursor = col === 0 && n === 0;
        return (
          <div
            key={n}
            className={`flex h-8.5 flex-none items-center gap-2.5 before:h-3 before:w-3.5 before:rounded-[3px] before:bg-ok-bone before:content-[''] motion-safe:before:animate-breathe under-760:h-10.5 ${
              cursor ? "-mx-3.5 bg-[color-mix(in_srgb,var(--spot)_12%,var(--ok-bg))] px-3.5 shadow-[inset_3px_0_0_var(--spot)]" : ""
            }`}
          >
            <i className="block h-2 rounded-[4px] bg-ok-bone motion-safe:animate-breathe" style={{ width: `${w}%` }}></i>
          </div>
        );
      })}
    </>
  );
}

/** One of the things to try, in the status line. */
function Chip({ k, short, label, run, ready }: { k: string; short: string; label: string; run: (d: Driver) => unknown; ready: boolean }) {
  const [running, setRunning] = useState(false);
  return (
    <button
      type="button"
      disabled={!ready}
      title={label}
      aria-label={label}
      className={
        "cursor-pointer border-0 border-l border-l-rule bg-transparent px-3 py-0 text-ink-2 hover:bg-bg-2 hover:text-ink disabled:cursor-default disabled:bg-transparent disabled:opacity-45 [&.running]:bg-bg-2 [&.running]:text-ink under-1100:h-10 under-1100:truncate under-1100:border-r under-1100:border-l-0 under-1100:border-r-rule under-1100:px-1.5 under-1100:last:border-r-0 under-760:nth-[4n]:border-r-0 under-760:nth-[n+5]:border-t under-760:nth-[n+5]:border-t-rule" +
        (running ? " running" : "")
      }
      onClick={async () => {
        const drive = hero.entry!.drive;
        setRunning(true);
        try {
          await drive.closeAll();
          await run(drive);
        } finally {
          setTimeout(() => setRunning(false), 600);
        }
      }}
    >
      <kbd className="mr-1.5 text-spot">{k}</kbd>
      {short}
    </button>
  );
}

// A key pressed on the page with nothing on it focused goes to okfs while okfs is on screen, so the hints
// work without a click in first. The focus moves into okfs with it: the keys after go straight there.
const OKFS_KEYS = new Set(["j", "k", "h", "l", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", "Home", "End", "/", ".", "t", "?"]);

export function Top() {
  const stats = ui.use();
  const { demo } = session.use();
  const [path, setPath] = useState("/");
  const [gone, setGone] = useState(false);
  const [failed, setFailed] = useState(false);
  const viewRef = useRef<HTMLElement>(null);
  const tut = useTutorial({ free: () => hero.entry?.handle.frame.focus() });
  const { view } = tut;
  const words = view.words === null ? null : tut.api.text();
  const n = typeof view.words === "number" ? `${view.words + 1} of ${words!.steps.length}` : view.words === "last" ? "Done" : "";
  const say = view.words === null ? null : view.words === "last" ? words!.last : words!.steps[view.words]![0];

  useEffect(() => {
    startDemo().catch((error) => {
      console.error(error);
      ui.set({ bootText: "okfs could not start in this browser.", bootSub: "It needs WebAssembly and DecompressionStream." });
      setFailed(true);
    });
  }, []);

  // ---- the first screen ----
  useEffect(() => {
    if (!demo) return;
    const heroView = viewRef.current!;
    const tutorial = tut.api;
    const entry = mountIn(demo, heroView, "/", {
      onPath: setPath,
      title: "okfs serving the demo folder tidewater",
      onKey: (key, m) => tutorial.heard({ key, ...(m as Partial<typeof m>) }),
      onNav: (path) => tutorial.went(path),
      onReq: (url) => {
        const q = new URL(url, "http://okfs.demo").searchParams.get("q") ?? "";
        if (url.startsWith("/api/search") && q.trim()) tutorial.heard({ search: true });
      },
      // okfs's own `t` or its menu changed its scheme: the page follows, and with it every other okfs.
      onScheme: (value) => (value === "dark" || value === "light") && value !== scheme() && setScheme(value, entry.handle),
    });
    hero.entry = entry;
    const offScheme = onScheme(() => tutorial.heard({ scheme: true }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    void entry.handle.whenReady().then(() => {
      timer = setTimeout(() => setGone(true), 250);
      tutorial.start();
    });

    let heroVisible = true;
    const io = new IntersectionObserver(([e]) => (heroVisible = e!.intersectionRatio > 0.3), { threshold: [0, 0.3, 0.6, 1] });
    io.observe(heroView);

    const onKeydown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !heroVisible) return;
      if (e.key === "Escape" && tutorial.on() && !(e.target as Element).closest?.("input, textarea, select")) return void tutorial.end();
      const free = e.target === document.body || e.target === document.documentElement || (tut.boxRef.current?.contains(e.target as Node | null) && e.key !== "Enter" && e.key !== " ");
      const find = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k";
      if (!free || !(find || (!e.ctrlKey && !e.metaKey && !e.altKey && OKFS_KEYS.has(e.key)))) return;
      e.preventDefault();
      entry.handle.frame.focus();
      void entry.drive.key(find ? "k" : e.key, { ctrl: find });
      tutorial.heard({ key: e.key, chord: find, typing: false });
    };
    addEventListener("keydown", onKeydown);
    return () => {
      removeEventListener("keydown", onKeydown);
      offScheme();
      io.disconnect();
      clearTimeout(timer);
    };
  }, [demo]);

  return (
    <div className="flex h-svh min-h-[560px] flex-col" id="top">
      <header className="group/bar flex h-(--bar) flex-none items-center gap-4.5 border-b border-b-rule bg-bg pr-2.5 pl-4 under-860:gap-1 under-860:pr-1.5">
        <a className="flex items-center gap-2 font-sans text-[18px] leading-none font-[800] font-stretch-[115%] tracking-[-.02em] no-underline" href="#top" aria-label="okfs, back to the top">
          <svg className="size-4.5">
            <use href="#i-okfs" />
          </svg>
          okfs
        </a>
        <span className="min-w-0 truncate text-[15px] text-ink-2 under-1320:hidden under-1520:group-has-[.again:not([hidden])]/bar:hidden">
          A whole folder in a browser tab, from one small binary. Below is okfs itself.
        </span>
        <span className="flex-1"></span>
        <nav className="flex gap-4.5 [font:13px/1_var(--mono)] whitespace-nowrap under-1000:group-has-[.again:not([hidden])]/bar:hidden under-860:hidden" aria-label="Sections">
          <a className="text-ink-2 no-underline hover:text-ink" href="#search">
            Features
          </a>
          <a className="text-ink-2 no-underline hover:text-ink" href="#how">
            How this page works
          </a>
          <a className="text-ink-2 no-underline hover:text-ink" href="#install">
            Install
          </a>
        </nav>
        <div className="flex min-w-0 items-center gap-2.5 border border-rule py-1.5 pr-1.5 pl-2.5 [font:13px/1_var(--mono)] text-ink under-860:hidden">
          <code className="min-w-0 flex-1 truncate">
            nix run github:jrnxf/okfs
          </code>
          <CopyButton className="flex-none cursor-pointer border-0 bg-ink px-2 py-1.25 [font:600_12px/1_var(--sans)] text-bg hover:bg-spot hover:text-spot-ink" text="nix run github:jrnxf/okfs" />
        </div>
        <button type="button" className="again flex-none cursor-pointer border-0 bg-transparent px-1 py-2 [font:13px/1_var(--mono)] whitespace-nowrap text-ink-2 hover:text-ink" id="tut-again" hidden={!view.again} onClick={tut.api.again}>
          Show tutorial
        </button>
        <a className="grid size-8.5 flex-none cursor-pointer place-items-center border-0 bg-transparent text-ink-2 no-underline hover:text-ink" href="https://github.com/jrnxf/okfs" aria-label="okfs on GitHub">
          <svg className="block size-4">
            <use href="#i-gh" />
          </svg>
        </a>
        <button type="button" className="grid size-8.5 flex-none cursor-pointer place-items-center border-0 bg-transparent text-ink-2 no-underline hover:text-ink" id="theme" onClick={() => setScheme(scheme() === "dark" ? "light" : "dark")} aria-label="Switch between dark and light">
          <svg className="block size-4 dark:hidden">
            <use href="#i-sun" />
          </svg>
          <svg className="block size-4 light:hidden">
            <use href="#i-moon" />
          </svg>
        </button>
      </header>
      <main className="relative min-h-0 flex-1 overflow-hidden bg-ok-bg" id="view" ref={viewRef}>
        <h1 className="absolute h-px w-px overflow-hidden whitespace-nowrap [clip:rect(0_0_0_0)]">
          okfs, a web file browser in one small binary, running in this page
        </h1>
        <div className={"pointer-events-none absolute inset-0 z-1 flex flex-col transition-opacity duration-350 [&.gone]:opacity-0" + (gone ? " gone" : "")} id="bones" aria-hidden="true">
          <div className="flex h-11.5 flex-none items-center gap-3 border-b border-b-ok-line px-3.5">
            <svg className="size-4 text-ok-faint">
              <use href="#i-okfs" />
            </svg>
            <i className="block h-[9px] w-[74px] rounded-[4px] bg-ok-bone"></i>
            <span className="ml-auto h-7 w-[200px] rounded-[6px] border border-ok-line under-760:w-8.5"></span>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-[repeat(4,minmax(0,1fr))] under-1000:grid-cols-[repeat(3,minmax(0,1fr))] under-860:grid-cols-[repeat(2,minmax(0,1fr))] under-760:grid-cols-[minmax(0,1fr)]">
            <div className="col flex flex-col gap-0 overflow-hidden border-r border-r-ok-line px-3.5 pt-15 under-760:pt-7.5"><Rows col={0} /></div>
            <div className="col flex flex-col gap-0 overflow-hidden border-r border-r-ok-line px-3.5 pt-15 under-760:hidden under-760:pt-7.5"><Rows col={1} /></div>
            <div className="col flex flex-col gap-0 overflow-hidden px-3.5 pt-15 under-760:hidden under-760:pt-7.5"><Rows col={2} /></div>
            <div className="col flex flex-col gap-0 overflow-hidden px-3.5 pt-15 under-760:hidden under-760:pt-7.5"><Rows col={3} /></div>
          </div>
          <div className="h-7.5 flex-none border-t border-t-ok-line"></div>
          <div
            className={
              "say absolute top-11.5 right-0 bottom-7.5 grid w-1/2 place-content-center text-center [font:13px/1.5_var(--mono)] text-ok-faint under-760:w-full [&.err_b]:text-spot" + (failed ? " err" : "")
            }
          >
            <b className="block font-[400] text-ink" id="boot-text">
              {stats.bootText}
            </b>
            <span id="boot-sub">{stats.bootSub}</span>
          </div>
        </div>
        <div className={"absolute right-4.5 bottom-11 z-3 w-[min(340px,calc(100%-36px))] bg-ink px-4 pt-3.5 pb-3 [font:15px/1.45_var(--sans)] text-bg shadow-[0_18px_40px_-16px_rgba(0,0,0,.5)] focus:outline-none motion-safe:not-[[hidden]]:animate-[tut-in_.24s_var(--ease)] [&.fin]:pointer-events-none [&.fin]:transition-opacity [&.fin]:duration-400 [&.out]:opacity-0 under-860:inset-x-3 under-860:bottom-3 under-860:w-auto [&_kbd]:rounded-[3px] [&_kbd]:border [&_kbd]:border-current [&_kbd]:px-1.25 [&_kbd]:py-0.5 [&_kbd]:[font:600_12px/1_var(--mono)] [&_kbd]:whitespace-nowrap" + (view.box === "fin" ? " fin" : view.box === "out" ? " fin out" : "")} id="tut" role="region" aria-label="Tutorial" tabIndex={-1} hidden={view.box === "hidden"} ref={tut.boxRef}>
          <span className="mb-2 block [font:12px/1_var(--mono)] opacity-65" id="tut-n">
            {n}
          </span>
          <p className={"m-0 text-pretty [&_b]:font-[700]"} id="tut-say" aria-live="polite">
            {say}
          </p>
          <div className={"mt-3 flex justify-end gap-1.5 [&[hidden]]:hidden"} id="tut-do" hidden={view.words === "last"}>
            <button type="button" className="cursor-pointer border bg-transparent px-3 py-2 [font:600_13px/1_var(--sans)] text-inherit pointer-coarse:px-4 pointer-coarse:py-3 border-transparent opacity-70 hover:opacity-100" id="tut-skip" onClick={tut.api.end} title="Skip the tutorial (Esc)">
              Skip
            </button>
            <button type="button" className="cursor-pointer border bg-transparent px-3 py-2 [font:600_13px/1_var(--sans)] text-inherit pointer-coarse:px-4 pointer-coarse:py-3 border-current hover:bg-bg hover:text-ink" id="tut-next" onClick={tut.api.next}>
              Next
            </button>
          </div>
        </div>
      </main>
      <div className="flex h-[34px] flex-none items-stretch border-t border-t-rule bg-bg [font:12.5px/34px_var(--mono)] whitespace-nowrap under-1100:h-auto under-1100:flex-wrap" id="status" aria-live="polite">
        <span className="flex-none bg-spot px-3 font-[600] tracking-[.04em] text-spot-ink under-1100:h-[34px]">
          OKFS
        </span>
        <span className="min-w-0 flex-[0_1_auto] truncate border-r border-r-rule px-3 text-ink under-1100:h-[34px] under-1100:flex-[1_1_0] under-1100:border-r-0" id="path">
          {path}
        </span>
        <span className={"flex-none border-r border-r-rule px-3 text-ink-2 under-1100:h-[34px] under-1100:border-r-0 under-1100:border-l under-1100:border-l-rule [&_b]:font-[400] [&_b]:text-ink under-760:border-r-0"}>
          <b id="st-count">
            {stats.count}
          </b>
          {" entries"}
        </span>
        <span className={"flex-none border-r border-r-rule px-3 text-ink-2 under-1100:h-[34px] under-1100:border-r-0 under-1100:border-l under-1100:border-l-rule [&_b]:font-[400] [&_b]:text-ink under-760:hidden"}>
          {"walked in "}
          <b id="st-walk">
            {stats.walk}
          </b>
        </span>
        <span className={"flex-none border-r border-r-rule px-3 text-ink-2 under-1100:h-[34px] under-1100:border-r-0 under-1100:border-l under-1100:border-l-rule [&_b]:font-[400] [&_b]:text-ink under-760:hidden"}>
          {"search "}
          <b id="st-search">
            {stats.search}
          </b>
        </span>
        <span className="flex-1 p-0 under-1100:hidden"></span>
        <div className="flex flex-none p-0 under-1100:grid under-1100:flex-[1_0_100%] under-1100:grid-cols-[repeat(8,minmax(0,1fr))] under-1100:border-t under-1100:border-t-rule under-760:grid-cols-[repeat(4,minmax(0,1fr))]" id="keys" role="group" aria-label="Things to try in okfs above">
          {chips.map(([k, short, label, run]) => (
            <Chip key={short} k={k} short={short} label={label} run={run} ready={!!demo} />
          ))}
        </div>
      </div>
    </div>
  );
}
