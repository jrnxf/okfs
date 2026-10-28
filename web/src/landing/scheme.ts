import { store } from "./store";

const html = () => document.documentElement;
export const scheme = () => (html().dataset.theme === "light" ? "light" : "dark");

const listeners = new Set<(next: string, from?: unknown) => void>();
export const onScheme = (fn: (next: string, from?: unknown) => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** The page's scheme, and every okfs's with it. `from` is the okfs that changed first, which is not told again. */
export function setScheme(next: string, from?: unknown) {
  html().dataset.theme = next;
  store.set("theme", next);
  document.querySelector('meta[name="theme-color"]')!.setAttribute("content", next === "dark" ? "#0c0c0d" : "#e8e7e2");
  listeners.forEach((fn) => fn(next, from));
}
