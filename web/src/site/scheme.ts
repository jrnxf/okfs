import { useSyncExternalStore } from "react";

export type Scheme = "light" | "dark";

const listeners = new Set<(next: Scheme) => unknown>();

export const getScheme = (): Scheme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

/** Sets the page's scheme, and tells every okfs on it. */
export function setScheme(next: Scheme) {
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("okfs-site.theme", next);
  } catch {
    // The choice lasts for this visit.
  }
  document.querySelector('meta[name="theme-color"]')!.setAttribute("content", next === "dark" ? "#1a1815" : "#f3ecdc");
  listeners.forEach((fn) => fn(next));
}

/** Calls `fn` on each scheme change, until the returned function is called. */
export function onScheme(fn: (next: Scheme) => unknown) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The page's scheme: the server renders light, and the browser's own is read as the page opens. */
export const useScheme = () => useSyncExternalStore(onScheme, getScheme, () => "light" as Scheme);
