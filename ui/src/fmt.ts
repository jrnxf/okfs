// How sizes, counts and times are written.

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const two = (n: number): string => String(n).padStart(2, "0");

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A short age for the list: `now`, `12m`, `3h`, `5d`, then a date. */
export function rel(seconds: number): string {
  const age = Date.now() / 1000 - seconds;
  if (age < 60) return "now";
  if (age < 3600) return `${Math.floor(age / 60)}m`;
  if (age < 86400) return `${Math.floor(age / 3600)}h`;
  if (age < 86400 * 30) return `${Math.floor(age / 86400)}d`;
  const at = new Date(seconds * 1000);
  const month = MONTHS[at.getMonth()];
  return at.getFullYear() === new Date().getFullYear() ? `${month} ${at.getDate()}` : `${month} ${at.getFullYear()}`;
}

export function abs(seconds: number): string {
  const at = new Date(seconds * 1000);
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

export const count = (n: number): string => n.toLocaleString("en-US");

export const items = (n: number): string => `${count(n)} ${n === 1 ? "item" : "items"}`;

export function duration(seconds: number): string {
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const rest = `${hours ? two(Math.floor((whole % 3600) / 60)) : Math.floor(whole / 60)}:${two(whole % 60)}`;
  return hours ? `${hours}:${rest}` : rest;
}

/** What the status line says of names that are not text, so okfs cannot show them. */
export const unreadable = (n: number): string => `${count(n)} ${n === 1 ? "name" : "names"} okfs cannot show`;
