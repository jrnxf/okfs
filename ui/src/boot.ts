// Runs in the head, before first paint: applies the saved theme and scheme so the page
// never flashes the wrong one.
import { applyTheme } from "./theme";

applyTheme();
