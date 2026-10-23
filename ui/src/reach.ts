// Whether okfs can be reached. The stream of changes drops, a request gets no answer at all, or okfs refuses the key
// the page holds: the page says which until it is heard from again.

import { useEffect, useState } from "preact/hooks";

/** What the page says in place of blaming a file, while okfs does not answer. */
export const NOT_ANSWERING = "okfs is not answering";

/** What it says while okfs answers but refuses the page's key: it started again since, with a new one. */
export const NEEDS_KEY = "This link needs its key";

/** Why the page cannot reach okfs, while it cannot. */
export type Unreached = typeof NOT_ANSWERING | typeof NEEDS_KEY;

let down: Unreached | null = null;
const listeners = new Set<() => void>();

/**
 * Why okfs cannot be reached, from a drop of the stream or a request that got no answer or had its key refused,
 * until the server is heard from again. `null` while it can be.
 */
export const whyDown = (): Unreached | null => down;

export const isDown = (): boolean => down !== null;

export function setDown(why: Unreached | null): void {
  if (down === why) return;
  down = why;
  for (const listener of listeners) listener();
}

export function onReach(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Why okfs cannot be reached, or `null`, for a component that draws again when that changes. */
export function useDown(): Unreached | null {
  const [now, set] = useState(down);
  useEffect(() => {
    // It may have changed between the first draw and this.
    set(down);
    return onReach(() => set(down));
  }, []);
  return now;
}

/**
 * A request okfs did not answer, or did not take: nothing came back, a proxy in front of it said that it could not
 * reach it, or okfs refused the key. `why` says which.
 */
export class NoAnswer extends Error {
  constructor(readonly why: Unreached = NOT_ANSWERING) {
    super(why);
  }
}

/** okfs never answers with these. A proxy in front of it does, when okfs is not there. */
const GATEWAY = new Set([502, 503, 504]);

/** What okfs says it wants when it refuses a request for want of its key. A proxy in front that signs people in says otherwise. */
const KEY_SCHEME = "okfs-key";

/**
 * A request to okfs. Any answer of its own, an error too, says that it answers, except the refusal of the key.
 * None at all says that it does not; either fails with a `NoAnswer`. A request given up on purpose says nothing
 * either way.
 */
export async function call(url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    setDown(NOT_ANSWERING);
    throw new NoAnswer();
  }
  const refused = heard(response.status, () => response.headers.get("www-authenticate"));
  if (refused) throw refused;
  return response;
}

/**
 * What an answer says of whether okfs can be reached, by its status and, for a 401, its `WWW-Authenticate`: a `NoAnswer` when a
 * proxy answered for it or it refused the key, and `null` when okfs itself answered. For a request made some other
 * way than `call`, as an upload is.
 */
export function heard(status: number, scheme: () => string | null): NoAnswer | null {
  if (GATEWAY.has(status)) {
    setDown(NOT_ANSWERING);
    return new NoAnswer();
  }
  if (status === 401 && scheme() === KEY_SCHEME) {
    setDown(NEEDS_KEY);
    return new NoAnswer(NEEDS_KEY);
  }
  setDown(null);
  return null;
}
