import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { mountIn, session, type Entry } from "./demo";
import { useLazy } from "./lazy";
import { sleep } from "./store";

const LABELS: Record<string, string> = { ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→", Enter: "⏎", Escape: "esc", " ": "space", Backspace: "⌫" };

export function Keys() {
  const { demo } = session.use();
  const view = useRef<HTMLDivElement>(null);
  const keys = useRef<Entry>(undefined);
  const holding = useRef<ReturnType<typeof setInterval> | null>(null);
  const [path, setPath] = useState("/photos/library/2025/");
  const [pressed, setPressed] = useState<{ id: number; label: string }[]>([]);
  const [down, setDown] = useState(false);
  const shown = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => {
    timers.current.forEach(clearTimeout);
    if (holding.current) clearInterval(holding.current);
  }, []);

  // Each key shown in the status line as it is pressed.
  const showHud = (k: string) => {
    const id = ++shown.current;
    setPressed((list) => [...list, { id, label: LABELS[k] ?? k }].slice(-6));
    const t = setTimeout(() => {
      timers.current.delete(t);
      setPressed((list) => list.filter((p) => p.id !== id));
    }, 900);
    timers.current.add(t);
  };

  useLazy(view, !!demo, () => {
    const entry = (keys.current = mountIn(demo!, view.current!, view.current!.dataset.start!, { onPath: setPath, onKey: showHud }));
    void entry.handle.whenReady().then(async () => {
      await sleep(500);
      entry.drive.key("Home");
      entry.drive.key("l");
      await sleep(500);
      entry.drive.key("j");
    });
  });

  const startHold = (e: SyntheticEvent) => {
    e.preventDefault();
    if (!keys.current || holding.current) return;
    setDown(true);
    showHud("j");
    let first = true;
    holding.current = setInterval(() => {
      void keys.current!.drive.down("j", !first);
      first = false;
    }, 60);
  };
  const endHold = () => {
    if (!holding.current) return;
    clearInterval(holding.current);
    holding.current = null;
    setDown(false);
    void keys.current?.drive.up("j");
  };

  return (
    <section className="border-t border-t-rule" id="keys-sec">
      <div className="mx-auto max-w-[1440px] px-10 under-860:px-4">
        <div className="grid grid-cols-[90px_minmax(0,1fr)_minmax(0,440px)] items-baseline gap-x-10 pt-24 pb-10 under-1000:grid-cols-[minmax(0,1fr)] under-1000:gap-y-3.5 under-860:pt-16 under-860:pb-7">
          <span className="[font:500_13px/1_var(--mono)] text-ink-3">
            02 Keys
          </span>
          <h2 className="m-0 font-sans font-[760] text-[length:clamp(34px,4.4vw,68px)] leading-[.98] font-stretch-[112%] tracking-[-.03em] text-balance *:not-italic *:text-spot">
            {"Hold "}
            <em>
              j
            </em>
            {" and watch each file go by."}
          </h2>
          <div>
            <p className="m-0 text-pretty text-ink-2">
              A file shows as soon as the cursor is on it. Pictures, text and tables draw as the cursor passes. A page, a PDF or a player waits until you let go, unless okfs loaded it ahead.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-10 gap-y-4.5 pb-10">
          <button type="button" className={"group/hold inline-flex cursor-pointer touch-none items-center gap-3 border border-ink bg-transparent py-3 pr-4.5 pl-3 [font:15px/1_var(--mono)] select-none" + (down ? " down" : "")} id="hold" onPointerDown={startHold} onPointerUp={endHold} onPointerLeave={endHold} onPointerCancel={endHold} onKeyDown={(e) => (e.key === " " || e.key === "Enter") && startHold(e)} onKeyUp={endHold}>
            <kbd className="grid size-8.5 place-items-center bg-ink text-[16px] text-bg transition-[transform] duration-80 group-[.down]/hold:bg-spot group-[.down]/hold:text-spot-ink group-[.down]/hold:[transform:translateY(2px)]">
              j
            </kbd>
            Press and hold
          </button>
          <ul className={"m-0 flex list-none flex-wrap gap-x-6.5 gap-y-2.5 p-0 [font:14px/1_var(--mono)] text-ink-2 *:flex *:items-center *:gap-2 [&_kbd]:inline-grid [&_kbd]:h-6 [&_kbd]:min-w-6 [&_kbd]:place-items-center [&_kbd]:rounded-[3px] [&_kbd]:border [&_kbd]:border-ink-3 [&_kbd]:px-1.5 [&_kbd]:[font:13px/1_var(--mono)] [&_kbd]:text-ink"}>
            <li>
              <kbd>
                j
              </kbd>
              <kbd>
                k
              </kbd>
              down, up
            </li>
            <li>
              <kbd>
                h
              </kbd>
              <kbd>
                l
              </kbd>
              out, in
            </li>
            <li>
              <kbd>
                ⏎
              </kbd>
              full width
            </li>
            <li>
              <kbd>
                /
              </kbd>
              filter
            </li>
            <li>
              <kbd>
                ⌘K
              </kbd>
              find
            </li>
            <li>
              <kbd>
                s
              </kbd>
              sort
            </li>
            <li>
              <kbd>
                r
              </kbd>
              source
            </li>
            <li>
              <kbd>
                .
              </kbd>
              hidden
            </li>
          </ul>
        </div>
      </div>
      <div className="relative h-[clamp(420px,62vh,640px)] border-t border-t-rule bg-ok-bg under-760:h-[clamp(420px,70svh,640px)]" id="keys-view" ref={view} data-start="/photos/library/2025/"></div>
      <div className="flex h-[34px] flex-none items-stretch border-t border-t-rule bg-bg [font:12.5px/34px_var(--mono)] whitespace-nowrap under-1100:h-auto under-1100:flex-wrap">
        <span className="flex-none bg-spot px-3 font-[600] tracking-[.04em] text-spot-ink under-1100:h-[34px]">
          OKFS
        </span>
        <span className="min-w-0 flex-[0_1_auto] truncate border-r border-r-rule px-3 text-ink under-1100:h-[34px] under-1100:flex-[1_1_0] under-1100:border-r-0" data-path-for="keys">
          {path}
        </span>
        <span className="flex-1 p-0 under-1100:hidden"></span>
        <span className="flex flex-none items-center gap-1.5 px-3 under-760:hidden" id="hud" aria-hidden="true">
          {pressed.map((p) => (
            <kbd key={p.id} className="animate-[hud_.9s_var(--ease)_forwards] border border-rule px-1.5 py-0.75 [font:12px/1_var(--mono)] text-ink">
              {p.label}
            </kbd>
          ))}
        </span>
      </div>
    </section>
  );
}
