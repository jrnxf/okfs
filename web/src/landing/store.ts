import { useSyncExternalStore } from "react";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let reducedMotion: boolean | undefined;
/** Whether the visitor asked for less motion, read once. */
export const reduced = () => (reducedMotion ??= matchMedia("(prefers-reduced-motion: reduce)").matches);
export const fmt = (n: number) => n.toLocaleString("en-US");

/** What this browser remembers about the page. */
export const store = {
  get: (key: string) => {
    try {
      return localStorage.getItem(`okfs-landing.${key}`);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(`okfs-landing.${key}`, value);
    } catch {
      // The choice lasts for this visit.
    }
  },
};

/** A value shared by the page's parts, which starts at what the server rendered. */
export function createState<T extends object>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    subs.add(fn);
    return () => void subs.delete(fn);
  };
  return {
    get: () => value,
    set(patch: Partial<T>) {
      value = { ...value, ...patch };
      subs.forEach((fn) => fn());
    },
    use: () => useSyncExternalStore(subscribe, () => value, () => initial),
  };
}
