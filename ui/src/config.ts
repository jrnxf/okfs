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
  /** The `--index` file name: a folder holding it opens as that page. Absent without the flag. */
  index?: string;
  target: { path: string; kind: "dir" | "file" | "missing" };
  /** True when the server was started with deleting on. */
  delete: boolean;
  /** True when the server draws the first page of a PDF as a picture. */
  pdf?: boolean;
  /** True with `--hidden`: dotfiles are served, and a browser with no choice of its own shows hidden entries. */
  hidden?: boolean;
}

const read = (page: Document): Partial<Config> => JSON.parse(page.getElementById("okfs-config")?.textContent ?? "{}");

export const config = read(document) as Config;

/** Asks the server again where the page's address leads, the way a reload does. Nothing when it does not say. */
export async function locate(): Promise<Config["target"] | undefined> {
  const response = await fetch(location.href);
  return read(new DOMParser().parseFromString(await response.text(), "text/html")).target;
}
