// What the server tells the page when it loads. It is written into the HTML as a data block.

export interface ThemeInfo {
  id: string;
  name: string;
  /** Page, text and accent color, for the swatch in the switcher. */
  light: [string, string, string];
  dark: [string, string, string];
}

export interface Config {
  /** The served folder's name: the first breadcrumb. */
  root: string;
  title: string;
  version: string;
  /** The theme a browser with no saved choice gets. */
  theme: string;
  themes: ThemeInfo[];
  /** The `--header` note, already rendered and cleaned by the server. */
  header: string | null;
  target: { path: string; kind: "dir" | "file" | "missing" };
}

export const config: Config = JSON.parse(document.getElementById("okfs-config")?.textContent ?? "{}");
