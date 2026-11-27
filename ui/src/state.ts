// What a page in the preview keeps for the one who views it, such as the boxes ticked in a checklist. A served page
// runs sandboxed in an origin of its own, which has no storage, so okfs keeps a small value for it in this browser,
// under okfs's own origin. Each page has one value, by its path: a page cannot read or change the value of another.
// Each load of a page okfs sent the frame to is given a token of its own with its value, and okfs hears only a message
// that carries the token back: a page reached by a link never has one.
// Nothing is written to the served folder, so this works with no write flag, and every browser keeps its own.

/** The message a page sends to keep its value: `{ type: "okfs:state-set", token, state }`. A `null` state forgets it. */
export const SET = "okfs:state-set";
/** The message okfs sends a page each time it loads: `{ type: "okfs:state", token, state }`, `null` when none is kept. */
export const STATE = "okfs:state";

/** The longest value a page may keep, as JSON text. */
export const LONGEST_STATE = 100_000;

const keyOf = (path: string): string => `okfs.state:${path}`;

/**
 * A new token for one load of a page. `crypto.randomUUID` is only there on https and localhost, and okfs also
 * serves plain http to other machines, so the token is made from `crypto.getRandomValues`.
 */
export function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What a message from a page asks, with the token it carries: the JSON text to keep, `null` to forget, or why it cannot be kept. */
export type Ask = { token: string } & ({ text: string | null } | { refused: string });

/** What a message from a page asks to keep, or `null` when it is no message of this kind or carries no token. */
export function readSet(data: unknown): Ask | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, token, state } = data as { type?: unknown; token?: unknown; state?: unknown };
  if (type !== SET || typeof token !== "string" || !token) return null;
  if (state === null || state === undefined) return { token, text: null };
  let text: string | undefined;
  try {
    text = JSON.stringify(state);
  } catch {
    return { token, refused: "the page's state is not JSON" };
  }
  if (text === undefined) return { token, refused: "the page's state is not JSON" };
  if (text.length > LONGEST_STATE) return { token, refused: "the page's state is larger than 100 KB" };
  return { token, text };
}

/** The value kept for a page, or `null` when there is none or storage is blocked. */
export function loadState(path: string): unknown {
  try {
    const text = localStorage.getItem(keyOf(path));
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** Keeps a page's value, or forgets it for `null`. False when the browser's storage is blocked or full. */
export function keepState(path: string, text: string | null): boolean {
  try {
    if (text === null) localStorage.removeItem(keyOf(path));
    else localStorage.setItem(keyOf(path), text);
    return true;
  } catch {
    return false;
  }
}
