// Whether okfs answers. The stream of changes drops, or a request gets no answer at all, while it does not: the
// page says so until it is heard from again.

import { useEffect, useState } from "preact/hooks";

/** What the page says in place of blaming a file, while okfs does not answer. */
export const NOT_ANSWERING = "okfs is not answering";

let down = false;
const listeners = new Set<() => void>();

/** True from a drop of the stream, or a request that got no answer, until the server is heard from again. */
export const isDown = (): boolean => down;

export function setDown(on: boolean): void {
  if (down === on) return;
  down = on;
  for (const listener of listeners) listener();
}

export function onReach(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether okfs answers, for a component that draws again when that changes. */
export function useDown(): boolean {
  const [now, set] = useState(down);
  useEffect(() => {
    // It may have changed between the first draw and this.
    set(down);
    return onReach(() => set(down));
  }, []);
  return now;
}

/** A request okfs did not answer: nothing came back, or a proxy in front of it said that it could not reach it. */
export class NoAnswer extends Error {
  constructor() {
    super(NOT_ANSWERING);
  }
}

/** okfs never answers with these. A proxy in front of it does, when okfs is not there. */
const GATEWAY = new Set([502, 503, 504]);

/**
 * A request to okfs. Any answer of its own, an error too, says that it answers. None at all says that it does not,
 * and fails with a `NoAnswer`; a request given up on purpose says nothing either way.
 */
export async function call(url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    setDown(true);
    throw new NoAnswer();
  }
  if (GATEWAY.has(response.status)) {
    setDown(true);
    throw new NoAnswer();
  }
  setDown(false);
  return response;
}
