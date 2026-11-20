// What the address says about the open file: `?code` shows its code in place of what is made from it, and `?full`
// shows it alone, with nothing of the page around it. A link with them opens the file the same way. The store writes
// the path, and drops these from the address of a folder: see `withoutFile`.

import { createParser, useQueryStates } from "nuqs";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { hasSource } from "./kinds";
import { type Entry, store } from "./store";

/** A word that is there or not: `?full`, `?full=1` and `?full=true` are yes. It is written `?full=1`. */
const parseAsWord = createParser<boolean>({
  parse: (value) => (value === "" || value === "1" || value === "true" ? true : null),
  serialize: () => "1",
}).withDefault(false);

const PARAMS = { code: parseAsWord, full: parseAsWord };

/** The page went to the screen's full size for `?full`: leaving it, as Esc does, leaves `?full` too. */
let screenFor = false;

export interface View {
  /** The address asks for the open file's code. */
  code: boolean;
  /** A file is open and the page shows only it. */
  full: boolean;
  /** Flips the file on show between its code and what is made from it. The address of an open file says which. */
  flip: (file?: Entry | null) => void;
  /** Shows the open file alone, or with the page around it again. `screen`: and fill the screen, or leave it. */
  setFull: (on: boolean, screen?: boolean) => void;
}

/** Whether the open file shows its code and whether the page shows only it, from the address, and the ways to change them. */
export function useView(): View {
  const [{ code, full }, set] = useQueryStates(PARAMS, { history: "replace" });
  const open = store.s.open;
  return {
    code,
    full: full && open !== null,
    flip(file = store.flippable()) {
      if (!file || !hasSource(file)) return;
      const next = !store.isCode(file);
      store.setCode(file, next);
      if (file.path === store.s.open?.path) void set({ code: next });
    },
    setFull(on, screen = false) {
      if (on && !store.s.open) return;
      void set({ full: on });
      if (!screen) return;
      if (on && !document.fullscreenElement) {
        screenFor = true;
        // A browser may refuse, as one in a frame does: the page is full all the same.
        document.documentElement.requestFullscreen?.().catch(() => (screenFor = false));
      } else if (!on && document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined);
      }
    },
  };
}

/**
 * Keeps the store, the address and the page in step. `?code` shows the open file's code, as on a load or a link.
 * A file opened while its kind shows its code gets `?code` in its address, so its link shows what is on screen.
 * The page drops what is around the file while `?full` is there.
 */
export function useViewSync({ code, full, setFull }: View): void {
  const open = store.s.open;
  const [, set] = useQueryStates(PARAMS, { history: "replace" });
  useEffect(() => {
    if (!open || !hasSource(open)) return;
    if (code) store.setCode(open, true);
    else if (store.isCode(open)) void set({ code: true });
  }, [code, open?.path]);
  // Before the paint, as the class for an open file is: see `App`.
  useLayoutEffect(() => {
    document.body.classList.toggle("full", full);
  }, [full]);
  // Esc leaves the full screen before the page hears it: the page leaves `?full` with it.
  const leave = useRef(setFull);
  leave.current = setFull;
  useEffect(() => {
    const left = () => {
      if (document.fullscreenElement || !screenFor) return;
      screenFor = false;
      leave.current(false);
    };
    document.addEventListener("fullscreenchange", left);
    return () => document.removeEventListener("fullscreenchange", left);
  }, []);
}
