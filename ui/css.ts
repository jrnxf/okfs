// Builds a stylesheet with Tailwind: its entry CSS, with every utility the given sources name.
//
// The compiler is the tailwindcss package, which is plain JavaScript. Its CLI and bundler plugins read the sources
// with a native scanner, from per-platform packages that the nix build leaves out (see flake.nix), so the class
// names are read here instead: every word of the sources is offered, and the compiler keeps the ones it knows.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { compile } from "tailwindcss";

// Packages are found from ui/, where they are installed.
const require = createRequire(join(import.meta.dir, "package.json"));

/**
 * The words of a source that could be class names. They sit between spaces and quotes, but an arbitrary value can
 * hold single quotes of its own, as `content-['']` does: both ways of reading them are offered.
 */
const words = (text: string): string[] => [...text.split(/[\s"`]+/), ...text.split(/[\s"'`]+/)].filter(Boolean);

export async function buildCss(entry: string, sources: string[]): Promise<string> {
  const compiler = await compile(readFileSync(entry, "utf8"), {
    base: dirname(entry),
    async loadStylesheet(id, base) {
      const path = id.startsWith(".") ? resolve(base, id) : require.resolve(id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  const candidates = new Set(sources.flatMap((source) => words(readFileSync(source, "utf8"))));
  return compiler.build([...candidates]);
}

/** The page's markup: its components and its HTML shell. */
export function uiSources(): string[] {
  const src = join(import.meta.dir, "src");
  const code = readdirSync(src).filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts"));
  return [...code.map((name) => join(src, name)), join(import.meta.dir, "index.html")];
}
