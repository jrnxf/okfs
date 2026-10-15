// What a file is, judged from its name alone: that is all a listing carries.

export type Kind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "md"
  | "html"
  | "csv"
  | "json"
  | "code"
  | "archive"
  | "text"
  | "file";

/** The seven color groups of the theme contract, plus `file` for everything else. */
export type Group = "folder" | "image" | "media" | "doc" | "code" | "data" | "archive" | "file";

const EXTENSIONS: Record<Exclude<Kind, "folder" | "file">, string> = {
  image: "jpg jpeg png gif webp svg avif bmp ico",
  video: "mp4 webm mov mkv m4v ogv",
  audio: "mp3 wav flac ogg m4a opus aac",
  pdf: "pdf",
  md: "md markdown",
  html: "html htm",
  csv: "csv tsv",
  json: "json",
  code:
    "rs ts tsx js jsx mjs cjs py go sh bash zsh fish toml yaml yml css scss c h cc cpp hpp java kt swift rb php lua sql xml nix zig ex exs hs ml vue svelte astro lock ini conf diff patch",
  archive: "zip tar gz tgz 7z bz2 xz zst rar",
  text: "txt log",
};

const BY_EXTENSION = new Map<string, Kind>();
for (const [kind, list] of Object.entries(EXTENSIONS)) {
  for (const ext of list.split(" ")) BY_EXTENSION.set(ext, kind as Kind);
}

export const GROUP: Record<Kind, Group> = {
  folder: "folder",
  image: "image",
  video: "media",
  audio: "media",
  pdf: "doc",
  md: "doc",
  html: "doc",
  text: "doc",
  csv: "data",
  json: "data",
  code: "code",
  archive: "archive",
  file: "file",
};

export const ICON: Record<Kind, string> = {
  folder: "folder",
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "doc",
  md: "doc",
  text: "doc",
  html: "html",
  csv: "data",
  json: "data",
  code: "code",
  archive: "archive",
  file: "file",
};

export const LABEL: Record<Kind, string> = {
  folder: "Folder",
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
  md: "Markdown",
  html: "HTML page",
  text: "Text",
  csv: "Table",
  json: "JSON",
  code: "Source",
  archive: "Archive",
  file: "File",
};

/**
 * True for a file that is shown as something made from its text: a page, rendered Markdown, a drawing, a
 * table, a tree. Such a file has a second form, its source as it is written.
 */
export function hasSource(file: { kind: Kind; ext: string }): boolean {
  return file.kind === "html" || file.kind === "md" || file.kind === "csv" || file.kind === "json" || file.ext === "svg";
}

/** What a flip of a file is remembered by: its kind, and an SVG drawing apart from the pictures. */
export function formOf(file: { kind: Kind; ext: string }): string {
  return file.ext === "svg" ? "svg" : file.kind;
}

/**
 * True for a file with a source that is shown as its source when it is opened: a page, Markdown and a drawing.
 * A table and JSON open as what is made from them.
 */
export function sourceFirst(file: { kind: Kind; ext: string }): boolean {
  return file.kind === "html" || file.kind === "md" || file.ext === "svg";
}

export function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function kindOf(name: string, dir: boolean): Kind {
  return dir ? "folder" : (BY_EXTENSION.get(extension(name)) ?? "file");
}
