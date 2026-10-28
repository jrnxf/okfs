import type { Driver } from "./demo";
import { sleep } from "./store";

// The things to try, in the status line. Disabled until okfs is up.
export const chips: [string, string, string, (d: Driver) => unknown][] = [
  ["j", "photos", "Hold j through the photos", async (d: Driver) => {
    await d.go("/photos/");
    await sleep(700);
    d.key("Home");
    await sleep(250);
    d.key("j");
    await sleep(500);
    await d.hold("j", 1400, 60);
  }],
  ["⌘K", "find", "Find anything", async (d: Driver) => {
    await d.closeAll();
    await d.palette();
    await sleep(350);
    await d.type("tide", 110);
  }],
  ["⏎", "list", "Every match in the list", (d: Driver) => d.go("/?find=readme")],
  [".", "hidden", "Show hidden: node_modules", async (d: Driver) => {
    await d.go("/harbor/");
    await sleep(700);
    d.key(".");
  }],
  ["▶", "film", "Play the timelapse", (d: Driver) => d.go("/harbor-timelapse.webm")],
  ["↗", "pdf", "Open the PDF", (d: Driver) => d.go("/annual-survey-2025.pdf")],
  ["r", "render", "Markdown, rendered", async (d: Driver) => {
    await d.go("/field-notes.md");
    await sleep(600);
    d.key("r");
  }],
  ["?", "keys", "All the keys", (d: Driver) => d.key("?")],
];
