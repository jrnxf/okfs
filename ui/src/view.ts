// What the address says about the open file: `?code` shows its code in place of what is made from it, and `?focus`
// shows only the file, with nothing of okfs around it. A link with them opens the file the same way. The store writes
// the path, and drops these from the address of a folder: see `withoutFile`. The browser's own full screen is a
// separate thing, and works with either.

import { createParser, useQueryStates } from "nuqs";
import { useEffect, useLayoutEffect } from "preact/hooks";
import { hasSource } from "./kinds";
import { type Entry, store } from "./store";

/** A word that is there or not: `?focus`, `?focus=1` and `?focus=true` are yes. It is written `?focus=1`. */
const parseAsWord = createParser<boolean>({
  parse: (value) => (value === "" || value === "1" || value === "true" ? true : null),
  serialize: () => "1",
}).withDefault(false);

const PARAMS = { code: parseAsWord, focus: parseAsWord };

export interface View {
  /** The address asks for the open file's code. */
  code: boolean;
  /** A file is open and the page shows only it. */
  focusMode: boolean;
  /** Flips the file on show between its code and what is made from it. The address of an open file says which. */
  flip: (file?: Entry | null) => void;
  /** Shows only the open file, or okfs around it again. */
  setFocusMode: (on: boolean) => void;
}

/** Whether the open file shows its code and whether the page shows only it, from the address, and the ways to change them. */
export function useView(): View {
  const [{ code, focus }, set] = useQueryStates(PARAMS, { history: "replace" });
  const open = store.s.open;
  return {
    code,
    focusMode: focus && open !== null,
    flip(file = store.flippable()) {
      if (!file || !hasSource(file)) return;
      const next = !store.isCode(file);
      store.setCode(file, next);
      if (file.path === store.s.open?.path) void set({ code: next });
    },
    setFocusMode(on) {
      if (on && !store.s.open) return;
      void set({ focus: on });
    },
  };
}

/**
 * Keeps the store, the address and the page in step. `?code` shows the open file's code, as on a load or a link.
 * A file opened while its kind shows its code gets `?code` in its address, so its link shows what is on screen.
 * The page drops what is around the file while `?focus` is there.
 */
export function useViewSync({ code, focusMode }: View): void {
  const open = store.s.open;
  const [, set] = useQueryStates(PARAMS, { history: "replace" });
  useEffect(() => {
    if (!open || !hasSource(open)) return;
    if (code) store.setCode(open, true);
    else if (store.isCode(open)) void set({ code: true });
  }, [code, open?.path]);
  // Before the paint, as the class for an open file is: see `App`.
  useLayoutEffect(() => {
    document.body.classList.toggle("focus-mode", focusMode);
  }, [focusMode]);
}
