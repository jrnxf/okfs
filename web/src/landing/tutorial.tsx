import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { reduced, store } from "./store";

/**
 * A few hints over okfs, one at a time. Each asks for one real thing and gives way to the next when okfs says it
 * was done: a key pressed, an address it went to, a search, a scheme. Skip, Esc or the last hint ends it for good,
 * on this browser; after the last, a short note says so and fades by itself. "Show tutorial" in the bar starts it
 * again. `free` hands the keys to okfs once it ends.
 */
export interface TutEvent {
  key?: string;
  typing?: boolean;
  chord?: boolean;
  idle?: boolean;
  from?: string;
  to?: string;
  search?: boolean;
  scheme?: unknown;
}

const kb = (...keys: string[]) =>
  keys.map((k, i) => (
    <Fragment key={k}>
      {i > 0 && " or "}
      <kbd>{k}</kbd>
    </Fragment>
  ));
const moved = (e: TutEvent) => ["j", "k", "ArrowDown", "ArrowUp"].includes(e.key!) && !e.typing && !e.chord;
// Moves between folders, from the address okfs went to: in, back up, or to a file.
const into = (e: TutEvent) => e.to?.endsWith("/") && e.to.length > e.from!.length && e.to.startsWith(e.from!);
const out = (e: TutEvent) => e.to?.endsWith("/") && e.to !== e.from && e.from!.startsWith(e.to);
const file = (e: TutEvent) => e.to !== undefined && !e.to.endsWith("/");

/** What each hint says and what it waits for. These read the browser, so they are made once it is running. */
function makeSteps(): { steps: [ReactNode, (e: TutEvent) => unknown][]; last: ReactNode } {
  const coarse = matchMedia("(pointer: coarse)").matches;
  const hello = <b>This is okfs, running in your tab.</b>;
  const steps: [ReactNode, (e: TutEvent) => unknown][] = coarse
    ? [
        [<>{hello} Tap a folder to open it.</>, into],
        ["Tap the arrow at the top left to go back up.", out],
        ["Tap a file to open it.", file],
        ["Tap the magnifier and type any name. It searches the whole folder.", (e: TutEvent) => e.search],
        ["Tap the sun or moon at the top right to switch between dark and light.", (e: TutEvent) => e.scheme],
      ]
    : [
        [<>{hello} Press {kb("j", "↓")} to move down the list.</>, moved],
        [<>Press {kb("l", "Enter")} to open the folder under the cursor.</>, into],
        [<>Press {kb("h", "←")} to go back up.</>, out],
        [<>Move down to a file and press {kb("Enter")} to open it.</>, file],
        [<>Press {kb(/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K")} and type any name. It searches the whole folder.</>, (e: TutEvent) => e.search],
        [<>Press {kb("t")} to switch between dark and light.</>, (e: TutEvent) => e.scheme],
      ];
  const last = coarse ? "That is all. The folder is yours to look around." : <>That is all. Press {kb("?")} in okfs for every key.</>;
  return { steps, last };
}

/** What shows: the box (hidden, a hint, the closing note, or the note fading), and which words are in it. */
interface View {
  box: "hidden" | "step" | "fin" | "out";
  /** The hint's index, "last" for the closing note, null before any. */
  words: number | "last" | null;
  again: boolean;
}

export function useTutorial({ free }: { free: () => void }) {
  const [view, setView] = useState<View>({ box: "hidden", words: null, again: false });
  const boxRef = useRef<HTMLDivElement>(null);
  const script = useRef<ReturnType<typeof makeSteps>>(undefined);
  const latestFree = useRef(free);
  latestFree.current = free;

  const api = useMemo(() => {
    const text = () => (script.current ??= makeSteps());
    let at = -1;
    let here = "/";
    let fading: ReturnType<typeof setTimeout> | undefined;

    function show(i: number) {
      if (i === text().steps.length) return finish();
      clearTimeout(fading);
      at = i;
      setView({ box: "step", words: i, again: false });
    }
    function close() {
      clearTimeout(fading);
      setView((v) => ({ ...v, box: "hidden", again: true }));
    }
    function end() {
      at = -1;
      store.set("tutorial", "done");
      const had = boxRef.current?.contains(document.activeElement);
      close();
      if (had) latestFree.current();
    }
    /** The last hint is done: a note that says so, which nothing has to close and which lets clicks through. */
    function finish() {
      end();
      setView({ box: "fin", words: "last", again: false });
      fading = setTimeout(() => {
        setView((v) => ({ ...v, box: "out" }));
        fading = setTimeout(close, reduced() ? 0 : 400);
      }, 3500);
    }
    /** Something happened in okfs: the hint on show is done if it asked for that. */
    function heard(e: TutEvent) {
      if (e.key === "Escape" && e.idle && at >= 0) return end();
      if (at >= 0 && at < text().steps.length && text().steps[at]![1](e)) show(at + 1);
    }
    return {
      text,
      next: () => show(at + 1),
      again() {
        show(0);
        boxRef.current?.focus();
      },
      start: () => (store.get("tutorial") === "done" ? setView((v) => ({ ...v, again: true })) : show(0)),
      on: () => at >= 0,
      end,
      heard,
      went(path: string) {
        const to = path.split("?")[0]!;
        const from = here;
        here = to;
        if (to !== from) heard({ from, to });
      },
    };
  }, []);

  return { view, api, boxRef };
}
