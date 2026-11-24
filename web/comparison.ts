// Keeps docs/comparison.md in step with src/comparison.ts, the source the site's table also reads.
// With --write it writes the block between the markers. Without it, it fails when the block differs,
// which is how build.sh runs it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { end, markdown, start } from "./src/comparison";

const path = join(import.meta.dir, "../docs/comparison.md");
const doc = readFileSync(path, "utf8");
const from = doc.indexOf(start);
const to = doc.indexOf(end);
if (from < 0 || to < from) throw new Error("docs/comparison.md has lost its comparison markers");

const next = `${doc.slice(0, from)}${start}\n\n${markdown()}\n\n${doc.slice(to)}`;
if (next === doc) {
  console.log("docs/comparison.md matches web/src/comparison.ts");
} else if (process.argv.includes("--write")) {
  writeFileSync(path, next);
  console.log("Wrote docs/comparison.md");
} else {
  console.error("docs/comparison.md differs from web/src/comparison.ts: run `npm run comparison` in web/");
  process.exit(1);
}
