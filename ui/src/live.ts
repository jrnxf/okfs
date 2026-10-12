// The page follows the served folder: the server tells what changed on disk, and the store reads that again.

import { urls } from "./api";
import { store } from "./store";

/** Seconds to wait before each new try after the stream drops. The last one repeats. */
const RETRY = [1, 2, 5, 10, 30];

let stream: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let tries = 0;

function close(): void {
  clearTimeout(retry);
  stream?.close();
  stream = null;
}

function open(): void {
  close();
  if (document.hidden) return;
  const source = new EventSource(urls.events);
  stream = source;
  // Nothing was heard while no stream was up: read once whatever is on screen.
  source.onopen = () => {
    tries = 0;
    store.sync();
  };
  source.addEventListener("change", (event) => {
    const { dir, files }: { dir: string; files: string[] | null } = JSON.parse(event.data);
    store.changed(dir, files);
  });
  source.addEventListener("sync", () => store.sync());
  // The browser would try again by itself, at one fixed pace and also against a server that refuses.
  source.onerror = () => {
    close();
    const wait = RETRY[Math.min(tries++, RETRY.length - 1)] ?? 30;
    retry = setTimeout(open, wait * 1000);
  };
}

/**
 * Holds the stream of changes while the tab is visible. A hidden tab lets it go, so that many open tabs
 * do not use up the few connections a browser gives one server, and catches up when it is shown again.
 */
export function follow(): void {
  document.addEventListener("visibilitychange", () => (document.hidden ? close() : open()));
  open();
}
