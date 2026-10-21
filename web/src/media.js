// What stands behind a file of the demo folder: its real contents, a picture from the pool, or the template a
// real okfs drew the preview of. The page around okfs and okfs's own frame both ask here, so they agree.
import { extension, kindOf } from "../../ui/src/kinds.ts";
import { hash } from "./tree.js";

const pascal = (name) => name.replace(/(^|[-_.])([a-z0-9])/g, (_, __, c) => c.toUpperCase());

/** The package a path is in, for the names its templates take. */
export function packageOf(path) {
  const parts = path.split("/");
  if (parts[0] === "harbor" && ["packages", "apps", "crates"].includes(parts[1])) return parts[2] ?? null;
  const at = parts.indexOf("node_modules");
  return at >= 0 ? (parts[at + 1] ?? null) : null;
}

/**
 * The template whose answers stand for a text file: `{ key, subs }`, or `{ day: true }` for a day of gauge readings,
 * or null for a file that has no text to show. `has(key)` says whether a key was recorded.
 */
export function templateOf(path, has) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = extension(name);
  const parts = path.split("/");
  const t = (key, subs = {}) => ({ key, subs });
  if (has(path)) return t(path);
  const pkg = packageOf(path);
  if (/^readme\.md$/i.test(name) && pkg) return t("harbor/packages/PKGNAME/README.md", { PKGNAME: pkg });
  if (name === "CHANGELOG.md") return t("_tpl/changelog.md");
  if (parts[0] === "notes" && ext === "md") return t(`_tpl/note-${(hash(path) % 6) + 1}.md`, { NOTEDATE: name.replace(/\.md$/, "") });
  if (ext === "md") return t("_tpl/docs.md");
  if (name.endsWith(".test.tsx")) {
    const base = name.replace(/\.test\.tsx$/, "");
    return t("_tpl/component-test.tsx", { "gauge-dial": base, GaugeDial: pascal(base) });
  }
  if (ext === "tsx") {
    const base = name.replace(/\.tsx$/, "");
    return t("_tpl/component.tsx", { GaugeDial: pascal(base), "gauge-dial": base });
  }
  if (name.endsWith(".test.ts")) return t("_tpl/test.ts");
  if (name.endsWith(".d.ts")) return t("_tpl/index.d.ts");
  if (name.startsWith("use-") && ext === "ts") return t("_tpl/hook.ts");
  if (ext === "ts") return t("_tpl/lib.ts");
  if (ext === "js") return t("_tpl/index.js");
  if (ext === "rs") return t(name === "main.rs" ? "_tpl/main.rs" : "_tpl/lib.rs");
  if (ext === "css") return t("_tpl/styles.css");
  if (name === "package.json") return t("_tpl/package.json", pkg ? { "@harbor/tides": `@harbor/${pkg}` } : {});
  if (name === "tsconfig.json") return t("_tpl/tsconfig.json");
  if (name === "summary.json") return t("_tpl/summary.json");
  if (name === "station.json") return t("_tpl/station.json");
  if (ext === "json") return t(parts[0] === "recordings" ? "_tpl/mark.json" : "_tpl/package.json");
  if (name === "Cargo.lock" || name === "bun.lock") return t("_tpl/Cargo.lock");
  if (ext === "toml") return t("_tpl/Cargo.toml");
  if (ext === "sh") return t("_tpl/script.sh");
  if (ext === "py") return t("_tpl/script.py");
  if (ext === "nix") return t("_tpl/flake.nix");
  if (ext === "log") return t("_tpl/daemon.log");
  if (ext === "txt") return t("_tpl/robots.txt");
  if (name === "LICENSE") return t("_tpl/LICENSE");
  if (ext === "csv") return { key: "day.csv", subs: {}, day: true };
  return null;
}

/** A template's text with its names put in. */
export function fill(text, template) {
  let out = text;
  for (const [from, to] of Object.entries(template.subs)) out = out.split(from).join(to);
  return out;
}

/**
 * What a file's bytes are, for an address okfs's page loads: `{ file }` for a real file, `{ pool, at }` for a picture
 * of the pool, `{ text }` for a template's text, or `{ empty: true }`.
 */
export function sourceOf(path, { files, pool, has, texts }) {
  if (files[path]) return { file: path };
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ext = extension(name);
  const kind = kindOf(name, false);
  const fromPool = (group) => ({ pool: group, at: hash(path) % pool[group].length });
  if (kind === "image") {
    if (ext === "svg") return { file: "data/station-map.svg" };
    if (path.startsWith("maps/tiles/")) return fromPool("tile");
    if (path.startsWith("scans/")) return fromPool("scan");
    return fromPool("photo");
  }
  if (kind === "video") return { file: "harbor-timelapse.webm" };
  if (kind === "audio") return { file: "harbor-bell.wav" };
  if (kind === "pdf") return { file: "annual-survey-2025.pdf" };
  if (kind === "html") return { file: "tide-chart.html" };
  if (kind === "archive") return { file: "survey-2026.zip" };
  const template = templateOf(path, has);
  if (template && !template.day && texts[template.key] !== undefined) return { text: fill(texts[template.key], template), key: `${template.key}|${JSON.stringify(template.subs)}` };
  return { empty: true };
}
