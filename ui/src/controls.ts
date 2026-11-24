// A served page's form controls, as its file holds them. A page in the preview may ask okfs to keep what its
// controls show: a box ticked, an option picked, a field typed in, a section opened. okfs then changes only the
// attribute or the text that says so, in the page's own file, and nothing else in it.

/** What a control shows, as the page tells it: by the control's `id`. */
export type Control = { id: string; checked: boolean } | { id: string; value: string } | { id: string; open: boolean };

/** The most controls one message may name, and the longest id and value it may hold. */
const MOST_CONTROLS = 1000;
const LONGEST_ID = 256;
const LONGEST_VALUE = 100_000;

/** The kind of message a page sends to have its controls kept. */
export const SAVE = "okfs:save";

/** The version of the message that this okfs reads. A page may leave it out, which means 1. */
export const SAVE_VERSION = 1;

/**
 * The controls a message from a page names, or `null` when it is no message of this kind:
 * `{ type: "okfs:save", v: 1, controls: [{ id, checked } | { id, value } | { id, open }] }`.
 *
 * A message with a later `v` is not read at all: okfs does not know what it means. In a message it reads, a
 * control that is not made right, or is of a kind this okfs does not know, is left out and the others are kept.
 */
export function readMessage(data: unknown): Control[] | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, v, controls } = data as { type?: unknown; v?: unknown; controls?: unknown };
  if (type !== SAVE || !Array.isArray(controls) || controls.length > MOST_CONTROLS) return null;
  if (v !== undefined && v !== SAVE_VERSION) return null;
  const out: Control[] = [];
  for (const item of controls as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { id, checked, value, open } = item as Record<string, unknown>;
    if (typeof id !== "string" || id === "" || id.length > LONGEST_ID) continue;
    const said = [checked, value, open].filter((part) => part !== undefined).length;
    if (said !== 1) continue;
    if (typeof checked === "boolean") out.push({ id, checked });
    else if (typeof open === "boolean") out.push({ id, open });
    else if (typeof value === "string" && value.length <= LONGEST_VALUE) out.push({ id, value });
  }
  return out;
}

interface Attr {
  /** Lower case. */
  name: string;
  /** Where the space before it starts, and where the attribute ends. */
  lead: number;
  end: number;
  /** Its value with character references read, or `null` for an attribute with no value. */
  value: string | null;
}

interface Tag {
  /** Lower case. */
  name: string;
  start: number;
  /** Where the `>`, or the `/>`, that closes it starts. */
  close: number;
  /** Just past the `>`. */
  end: number;
  attrs: Attr[];
}

/** Elements whose text is not markup: a `<` in them starts no tag. */
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Reads the character references in text: the common named ones and every numbered one. Others stay as they are. */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

const escapeAttr = (text: string): string => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const escapeText = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const SPACE = /[\t\n\f\r ]/;

/** The start tag at `at`, a `<` followed by a letter. `null` when the file ends inside it. */
function readTag(html: string, at: number): Tag | null {
  let i = at + 1;
  while (i < html.length && !SPACE.test(html[i]!) && html[i] !== "/" && html[i] !== ">") i++;
  const tag: Tag = { name: html.slice(at + 1, i).toLowerCase(), start: at, close: -1, end: -1, attrs: [] };
  while (i < html.length) {
    const lead = i;
    while (i < html.length && (SPACE.test(html[i]!) || (html[i] === "/" && html[i + 1] !== ">"))) i++;
    if (html[i] === ">" || (html[i] === "/" && html[i + 1] === ">")) {
      tag.close = i;
      tag.end = html.indexOf(">", i) + 1;
      return tag;
    }
    const from = i;
    // A name may start with `=`: the HTML parser takes it as part of the name.
    i++;
    while (i < html.length && !SPACE.test(html[i]!) && !"/>=".includes(html[i]!)) i++;
    const name = html.slice(from, i).toLowerCase();
    let j = i;
    while (j < html.length && SPACE.test(html[j]!)) j++;
    let value: string | null = null;
    if (html[j] === "=") {
      j++;
      while (j < html.length && SPACE.test(html[j]!)) j++;
      const quote = html[j];
      if (quote === '"' || quote === "'") {
        const shut = html.indexOf(quote, j + 1);
        if (shut < 0) return null;
        value = decode(html.slice(j + 1, shut));
        i = shut + 1;
      } else {
        let k = j;
        while (k < html.length && !SPACE.test(html[k]!) && html[k] !== ">") k++;
        value = decode(html.slice(j, k));
        i = k;
      }
    }
    tag.attrs.push({ name, lead, end: i, value });
  }
  return null;
}

/** Every start tag in the file, in order, with where the text of each raw text element ends. */
function scan(html: string): { tags: Tag[]; rawEnd: Map<Tag, number> } {
  const tags: Tag[] = [];
  const rawEnd = new Map<Tag, number>();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const next = html[lt + 1] ?? "";
    if (html.startsWith("<!--", lt)) {
      const shut = html.indexOf("-->", lt + 4);
      i = shut < 0 ? html.length : shut + 3;
    } else if (next === "!" || next === "?" || next === "/") {
      const shut = html.indexOf(">", lt + 2);
      i = shut < 0 ? html.length : shut + 1;
    } else if (/[a-z]/i.test(next)) {
      const tag = readTag(html, lt);
      if (!tag) break;
      tags.push(tag);
      i = tag.end;
      if (RAW.has(tag.name)) {
        const shut = html.slice(i).search(new RegExp(`</${tag.name}[\\t\\n\\f\\r />]`, "i"));
        const stop = shut < 0 ? html.length : i + shut;
        rawEnd.set(tag, stop);
        i = stop;
      }
    } else i = lt + 1;
  }
  return { tags, rawEnd };
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const attrOf = (tag: Tag, name: string): Attr | undefined => tag.attrs.find((attr) => attr.name === name);

/** The edits that give a tag an attribute with no value, or take every copy of it away. */
function flag(tag: Tag, name: string, on: boolean): Edit[] {
  const there = tag.attrs.filter((attr) => attr.name === name);
  if (on) return there.length ? [] : [{ start: tag.close, end: tag.close, text: ` ${name}` }];
  return there.map((attr) => ({ start: attr.lead, end: attr.end, text: "" }));
}

/** The edit that gives a tag's attribute a value. */
function attrValue(tag: Tag, name: string, value: string): Edit[] {
  const attr = attrOf(tag, name);
  if (attr?.value === value) return [];
  const text = ` ${name}="${escapeAttr(value)}"`;
  return attr ? [{ start: attr.lead, end: attr.end, text }] : [{ start: tag.close, end: tag.close, text }];
}

/** Inputs that hold no text to keep, or hold one that must never be written to a file. */
const NO_VALUE = new Set(["checkbox", "radio", "password", "file", "hidden", "submit", "button", "reset", "image"]);

/**
 * The page's file with its controls showing what the page says they show. A control the file does not hold under
 * exactly one element with that id, or that is not the kind of control the page says, is left as it is. So is a
 * password field. Text typed in a field is written with `newline` at the end of each line: the file's own.
 */
export function setControls(html: string, controls: Control[], newline = "\n"): string {
  const { tags, rawEnd } = scan(html);
  const byId = new Map<string, Tag | null>();
  for (const tag of tags) {
    const id = attrOf(tag, "id")?.value;
    if (id === undefined || id === null) continue;
    byId.set(id, byId.has(id) ? null : tag);
  }
  const edits: Edit[] = [];
  // A control named twice takes its last word.
  const last = new Map(controls.map((control) => [control.id, control]));
  for (const control of last.values()) {
    const tag = byId.get(control.id);
    if (!tag) continue;
    const type = (attrOf(tag, "type")?.value ?? "text").toLowerCase();
    if ("checked" in control) {
      if (tag.name === "input" && (type === "checkbox" || type === "radio")) edits.push(...flag(tag, "checked", control.checked));
    } else if ("open" in control) {
      if (tag.name === "details") edits.push(...flag(tag, "open", control.open));
    } else if (tag.name === "input") {
      if (!NO_VALUE.has(type)) edits.push(...attrValue(tag, "value", control.value.replace(/[\r\n]/g, "")));
    } else if (tag.name === "textarea") {
      const stop = rawEnd.get(tag) ?? tag.end;
      const typed = control.value.replace(/\r\n?/g, "\n");
      const found = decode(html.slice(tag.end, stop)).replace(/\r\n?/g, "\n");
      // The parser drops one newline right after the start tag.
      if (found.replace(/^\n/, "") !== typed) {
        const text = (typed.startsWith("\n") ? "\n" : "") + escapeText(typed).replace(/\n/g, newline);
        edits.push({ start: tag.end, end: stop, text });
      }
    } else if (tag.name === "select" && attrOf(tag, "multiple") === undefined) {
      edits.push(...pick(html, tags, tag, control.value));
    }
  }
  if (!edits.length) return html;
  edits.sort((a, b) => b.start - a.start);
  let out = html;
  let floor = Number.POSITIVE_INFINITY;
  for (const edit of edits) {
    // Two edits of the same text would undo each other: the later one in the file is kept.
    if (edit.end > floor) continue;
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    floor = edit.start;
  }
  return out;
}

/** The edits that mark the first option of a select with this value as the one picked, and no other. */
function pick(html: string, tags: Tag[], select: Tag, value: string): Edit[] {
  const after = html.slice(select.end).search(/<\/select[\t\n\f\r />]/i);
  const stop = after < 0 ? html.length : select.end + after;
  const options = tags.filter((tag) => tag.name === "option" && tag.start > select.start && tag.start < stop);
  const valueOf = (option: Tag): string => {
    const own = attrOf(option, "value")?.value;
    if (own !== undefined && own !== null) return own;
    const shut = html.indexOf("<", option.end);
    return decode(html.slice(option.end, shut < 0 || shut > stop ? stop : shut))
      .replace(/[\t\n\f\r ]+/g, " ")
      .trim();
  };
  const chosen = options.find((option) => valueOf(option) === value);
  if (!chosen) return [];
  return options.flatMap((option) => flag(option, "selected", option === chosen));
}
