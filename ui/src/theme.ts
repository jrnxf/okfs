// The active theme and scheme. A theme is a stylesheet of tokens; switching swaps one link.

import { config } from "./config";
import { prefs } from "./prefs";

export type Scheme = "light" | "dark" | "auto";

const media = matchMedia("(prefers-color-scheme: dark)");
const query = new URLSearchParams(location.search);
const listeners = new Set<() => void>();

const known = (id: string | null): id is string => config.themes.some((theme) => theme.id === id);
const asScheme = (value: string | null): Scheme => (value === "light" || value === "dark" ? value : "auto");

// `?theme=` and `?scheme=` override the saved choice for one visit, without saving.
export const active = {
  theme: [query.get("theme"), prefs.get("theme")].find(known) ?? config.theme,
  scheme: asScheme(query.get("scheme") ?? prefs.get("scheme")),
};

export const isDark = (): boolean => (active.scheme === "auto" ? media.matches : active.scheme === "dark");

const href = (id: string): string => (id === config.theme ? "/theme.css" : `/assets/themes/${id}.css`);

/** Tokens are read by CSS, except the icon set, which picks markup: mirror it onto the root. */
function tokensChanged(): void {
  const set = getComputedStyle(document.documentElement).getPropertyValue("--icon-set").trim() || "line";
  document.documentElement.dataset.icons = set;
  requestAnimationFrame(() => listeners.forEach((listener) => listener()));
}

export function applyTheme(): void {
  const root = document.documentElement;
  root.dataset.scheme = isDark() ? "dark" : "light";
  root.dataset.theme = active.theme;
  const link = document.getElementById("okfs-theme") as HTMLLinkElement | null;
  const want = href(active.theme);
  if (link && link.getAttribute("href") !== want) {
    link.onload = tokensChanged;
    link.setAttribute("href", want);
  } else {
    tokensChanged();
  }
}

export function setTheme(id: string): void {
  active.theme = id;
  prefs.set("theme", id);
  applyTheme();
}

export function setScheme(scheme: Scheme): void {
  active.scheme = scheme;
  prefs.set("scheme", scheme);
  applyTheme();
}

/** Calls back after the tokens change, once styles have settled. */
export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

media.addEventListener("change", applyTheme);
