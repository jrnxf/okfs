// Both icon sets live in one sprite. The theme's --icon-set token picks which one shows.

import { GROUP, type Group, ICON, type Kind } from "./kinds";

const R = '<rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2"/>';
const FILE =
  '<path d="M4.25 1.75h4.5l3.5 3.5v7.5c0 .83-.67 1.5-1.5 1.5h-6.5c-.83 0-1.5-.67-1.5-1.5v-9.5c0-.83.67-1.5 1.5-1.5z"/><path d="M8.75 1.75v3.5h3.5"/>';
const BOX = "M4 2h8a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V4a2 2 0 012-2z";

const LINE: Record<string, string> = {
  folder:
    '<path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.69c.4 0 .78.16 1.06.44l.94.94c.28.28.66.44 1.06.44h3.75c.83 0 1.5.67 1.5 1.5v5.68c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5z"/>',
  file: FILE,
  doc: `${FILE}<path d="M5.5 8.5h5M5.5 11h3.25"/>`,
  image: `${R}<path d="M2.6 10.6l3-3 2.4 2.4 2-2 3.4 3.4"/><circle cx="10.4" cy="5.6" r=".9"/>`,
  video: `${R}<path d="M6.75 5.75v4.5L10.5 8z"/>`,
  audio: '<path d="M6.25 11.75v-8l6-1.5v8"/><circle cx="4.5" cy="11.75" r="1.75"/><circle cx="10.5" cy="10.25" r="1.75"/>',
  code: '<path d="M5.75 4.75L2.5 8l3.25 3.25M10.25 4.75L13.5 8l-3.25 3.25"/>',
  data: `${R}<path d="M2.25 6.25h11.5M6.25 6.25v7.5"/>`,
  html: '<circle cx="8" cy="8" r="5.75"/><path d="M2.25 8h11.5M8 2.25c1.9 2 1.9 9.5 0 11.5M8 2.25c-1.9 2-1.9 9.5 0 11.5"/>',
  archive:
    '<path d="M2.75 5.25h10.5v7c0 .83-.67 1.5-1.5 1.5h-7.5c-.83 0-1.5-.67-1.5-1.5z"/><path d="M1.75 2.75h12.5v2.5H1.75zM6.5 8.25h3"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25l3.25 3.25"/>',
  list: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
  right: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  left: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
  up: '<path d="M3.5 10L8 5.5l4.5 4.5"/>',
  down: '<path d="M3.5 6L8 10.5 12.5 6"/>',
  wrap: '<path d="M2.5 4h11M2.5 12h4M2.5 8h8.5a2 2 0 010 4H9.5M11 10.5L9.5 12 11 13.5"/>',
  more: '<circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/>',
  download: '<path d="M8 2.25v8M4.75 7.25L8 10.5l3.25-3.25M2.75 13.25h10.5"/>',
  upload: '<path d="M8 10.5v-8M4.75 5.5L8 2.25l3.25 3.25M2.75 13.25h10.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  pen: '<path d="M10.25 2.75l3 3-7.5 7.5H2.75v-3z"/><path d="M8.75 4.25l3 3"/>',
  swatch:
    '<circle cx="8" cy="8" r="5.75"/><path d="M8 2.25v11.5"/><path d="M8 2.25a5.75 5.75 0 010 11.5z" fill="currentColor"/>',
  expand: '<path d="M9.5 2.75h3.75V6.5M6.5 13.25H2.75V9.5M13.25 2.75L9 7M2.75 13.25L7 9"/>',
  pane: `${R}<path d="M9.25 2.25v11.5"/>`,
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  eye: '<path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z"/><circle cx="8" cy="8" r="1.75"/>',
  "eye-off":
    '<path d="M6.4 3.95A6.4 6.4 0 018 3.75C12 3.75 14.25 8 14.25 8a11.6 11.6 0 01-1.7 2.3M9.6 12.05a6.4 6.4 0 01-1.6.2C4 12.25 1.75 8 1.75 8a11.6 11.6 0 011.7-2.3M6.76 6.76a1.75 1.75 0 002.48 2.48M2.75 2.75l10.5 10.5"/>',
  trash:
    '<path d="M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4 4.25l.62 8.11c.06.78.71 1.39 1.5 1.39h3.76c.79 0 1.44-.61 1.5-1.39L12 4.25M6.75 7.25v3.5M9.25 7.25v3.5"/>',
  // The Trash as a place, in the top bar: a bin with its lines across, where a delete's has them down.
  bin: '<path d="M2.75 4.25h10.5M4 4.25l.62 8.11c.06.78.71 1.39 1.5 1.39h3.76c.79 0 1.44-.61 1.5-1.39L12 4.25M6.25 4.25v-1.5h3.5v1.5M5.75 7.5h4.5M6.25 10h3.5"/>',
  restore: '<path d="M2.75 4.25v3h3"/><path d="M3.1 7.25A5 5 0 118 13"/>',
  open: '<path d="M2.75 8h8.5M8 4.75L11.25 8 8 11.25M13.25 2.75v10.5"/>',
  newtab: '<path d="M9.25 2.75h4v4M13.25 2.75L7.5 8.5M11.75 9.5v2.75c0 .55-.45 1-1 1h-7c-.55 0-1-.45-1-1v-7c0-.55.45-1 1-1H6.5"/>',
  rename:
    '<path d="M6.25 4.25h-3.5c-.55 0-1 .45-1 1v5.5c0 .55.45 1 1 1h3.5M11.75 4.25h1.5c.55 0 1 .45 1 1v5.5c0 .55-.45 1-1 1h-1.5M9 2.25v11.5M7.5 2.25h3M7.5 13.75h3"/>',
  move: '<path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.69c.4 0 .78.16 1.06.44l.94.94c.28.28.66.44 1.06.44h3.75c.83 0 1.5.67 1.5 1.5v5.68c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5z"/><path d="M5.5 9h5M8.75 7.25L10.5 9l-1.75 1.75"/>',
  copy: '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5"/><path d="M10.75 5.25v-1.5c0-.83-.67-1.5-1.5-1.5h-5.5c-.83 0-1.5.67-1.5 1.5v5.5c0 .83.67 1.5 1.5 1.5h1.5"/>',
  dup: '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5"/><path d="M10.75 5.25v-1.5c0-.83-.67-1.5-1.5-1.5h-5.5c-.83 0-1.5.67-1.5 1.5v5.5c0 .83.67 1.5 1.5 1.5h1.5M9.5 7.75v3.5M7.75 9.5h3.5"/>',
  link: '<path d="M6.75 9.25a2.5 2.5 0 003.54 0l2.12-2.12a2.5 2.5 0 00-3.54-3.54l-.7.7M9.25 6.75a2.5 2.5 0 00-3.54 0L3.59 8.87a2.5 2.5 0 003.54 3.54l.7-.7"/>',
  path: '<path d="M6 13.25L10 2.75M2.75 13.25h2M11.25 13.25h2"/>',
  "folder-plus":
    '<path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.69c.4 0 .78.16 1.06.44l.94.94c.28.28.66.44 1.06.44h3.75c.83 0 1.5.67 1.5 1.5v5.68c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5z"/><path d="M8 7.25v3.5M6.25 9h3.5"/>',
  select: `${R}<path d="M5.25 8.25l2 2 3.5-4"/>`,
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  sort: '<path d="M2.75 4.25h10.5M2.75 8h7M2.75 11.75h3.5"/>',
  blank: "",
};

const SOLID: Record<string, string> = {
  folder:
    '<path d="M1.5 4.25c0-.97.78-1.75 1.75-1.75h2.69c.46 0 .9.18 1.23.51l.95.95c.24.23.55.36.88.36h3.75c.97 0 1.75.79 1.75 1.75v5.68c0 .97-.78 1.75-1.75 1.75H3.25c-.97 0-1.75-.78-1.75-1.75z"/>',
  file: '<path d="M4.25 1.5h4.6l3.9 3.9v7.35c0 .97-.78 1.75-1.75 1.75H4.25c-.97 0-1.75-.78-1.75-1.75v-9.5c0-.97.78-1.75 1.75-1.75z"/>',
  doc: '<path d="M4.25 1.5h4.6l3.9 3.9v7.35c0 .97-.78 1.75-1.75 1.75H4.25c-.97 0-1.75-.78-1.75-1.75v-9.5c0-.97.78-1.75 1.75-1.75zM5.25 7.9h5.5v1.2h-5.5zM5.25 10.4h3.5v1.2h-3.5z"/>',
  image: `<path d="${BOX}M10.4 4.2a1.3 1.3 0 110 2.6 1.3 1.3 0 010-2.6zM3.6 11.8l2.6-3.1 2 2 1.8-1.8 2.4 2.9z"/>`,
  video: `<path d="${BOX}M6.5 5.4l4.2 2.6-4.2 2.6z"/>`,
  audio: '<path d="M5.75 3.3l7-1.75v8.6a2.25 2.25 0 11-1.5-2.12V4.6l-4 1v6.3a2.25 2.25 0 11-1.5-2.12z"/>',
  code: `<path d="${BOX}M6.5 5.4L3.9 8l2.6 2.6.85-.85L5.6 8l1.75-1.75zM9.5 5.4l-.85.85L10.4 8l-1.75 1.75.85.85L12.1 8z"/>`,
  data: `<path d="${BOX}M3.4 6h9.2v1.2H3.4zM6 7.2h1.2v5.4H6z"/>`,
  html: '<path d="M8 1.75a6.25 6.25 0 100 12.5 6.25 6.25 0 000-12.5zM2.9 7.4h10.2v1.2H2.9zM8 3.2c1.1 1.6 1.1 8 0 9.6-1.1-1.6-1.1-8 0-9.6z"/>',
  archive:
    '<path d="M1.5 2.5h13v2.75h-13zM2.5 6.25h11v6c0 .97-.78 1.75-1.75 1.75h-7.5c-.97 0-1.75-.78-1.75-1.75zM6.25 8.1h3.5v1.2h-3.5z"/>',
};

const symbols = (set: Record<string, string>, prefix: string): string =>
  Object.entries(set)
    .map(([name, body]) => `<symbol id="${prefix}-${name}" viewBox="0 0 16 16">${body}</symbol>`)
    .join("");

const SPRITE = { __html: symbols(LINE, "l") + symbols(SOLID, "s") };

export function Sprite() {
  return <svg class="absolute" width="0" height="0" aria-hidden="true" dangerouslySetInnerHTML={SPRITE} />;
}

export function Icon({ name, class: extra }: { name: string; class?: string }) {
  return (
    <svg class={extra ? `ic ${extra}` : "ic"} viewBox="0 0 16 16" aria-hidden="true">
      <use class="ic-l" href={`#l-${name}`} />
      {SOLID[name] && <use class="ic-s" href={`#s-${name}`} />}
    </svg>
  );
}

/** Each group of kinds in its own color. */
const TINT: Record<Group, string> = {
  folder: "text-kind-folder",
  image: "text-kind-image",
  media: "text-kind-media",
  doc: "text-kind-doc",
  code: "text-kind-code",
  data: "text-kind-data",
  archive: "text-kind-archive",
  file: "text-faint",
};

export function KindIcon({ kind, class: extra }: { kind: Kind; class?: string }) {
  return <Icon name={ICON[kind]} class={`ic-kind ${TINT[GROUP[kind]]}${extra ? ` ${extra}` : ""}`} />;
}
