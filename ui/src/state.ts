// What a page in the preview keeps for the one who views it, such as the boxes ticked in a checklist. A served page
// runs sandboxed in an origin of its own, which has no storage, so okfs keeps a small value for it in this browser,
// under okfs's own origin. Each page has one value, by its path.
// Each page okfs shows in a frame has a token in its address, `?okfs-state=`, made once for its path while okfs is
// open. okfs answers and hears only a message that carries the token of the file the frame was sent to. A page
// reached by a link has no token in its address, so it cannot read or change the value of another page, unless
// a page gives its own token away, as by putting its own address with its query into a link.
// Nothing is written to the served folder, so this works with no write flag, and every browser keeps its own.

/** The query parameter of a framed page's address that holds its token. */
export const PARAM = "okfs-state";
/** The message a page sends to ask for its value: `{ type: "okfs:state-get", token }`. */
export const GET = "okfs:state-get";
/** The message a page sends to keep its value: `{ type: "okfs:state-set", token, state }`. A `null` state forgets it. */
export const SET = "okfs:state-set";
/** The answer okfs sends to a get: `{ type: "okfs:state", state }`, `null` when none is kept. */
export const STATE = "okfs:state";

/** The longest value a page may keep, as JSON text. */
export const LONGEST_STATE = 100_000;

const keyOf = (path: string): string => `okfs.state:${path}`;

const tokens = new Map<string, string>();

/**
 * The token of a page, made the first time it is asked for. `crypto.randomUUID` is only there on https and
 * localhost, and okfs also serves plain http to other machines, so the token is made from `crypto.getRandomValues`.
 */
export function tokenOf(path: string): string {
  let token = tokens.get(path);
  if (token === undefined) {
    token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    tokens.set(path, token);
  }
  return token;
}

/** True when `token` is the token made for the page at `path`. A page that was never framed has none. */
export const holds = (path: string, token: string): boolean => tokens.get(path) === token;

/** What a message from a page asks, with the token it carries: its value, to keep JSON text or `null` to forget, or why it cannot be kept. */
export type Ask = { token: string } & ({ get: true } | { text: string | null } | { refused: string });

/** What a message from a page asks, or `null` when it is no message of this kind or carries no token. */
export function readAsk(data: unknown): Ask | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, token, state } = data as { type?: unknown; token?: unknown; state?: unknown };
  if ((type !== GET && type !== SET) || typeof token !== "string" || !token) return null;
  if (type === GET) return { token, get: true };
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
