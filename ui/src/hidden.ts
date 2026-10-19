// Whether hidden entries are shown: dotfiles, which the server sends only with `--hidden`, and the folders it
// leaves out of the search, such as node_modules. The choice is remembered per browser. A browser with none starts
// as `--hidden` says.

import { config } from "./config";
import { prefs } from "./prefs";

const saved = prefs.get("hidden");
let shown = saved === null ? config.hidden === true : saved === "1";

export const showsHidden = (): boolean => shown;

export function setShowsHidden(on: boolean): void {
  shown = on;
  prefs.set("hidden", on ? "1" : "0");
}
