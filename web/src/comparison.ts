// The one source of the comparison: the site's table (site/Compare.tsx) and the block between the
// markers in docs/comparison.md both come from here. `npm run comparison` writes the docs block, and
// the site build fails when the block differs. Text between backticks is code in both places.
//
// Every cell about another tool is what its own documentation says, from the pages in `sources`.
// Read them again and move `read` forward before changing a cell.

export const read = "2026-11-16";

export const tools = [
  { name: "okfs" },
  { name: "`python -m http.server`" },
  { name: "miniserve" },
  { name: "dufs" },
  { name: "copyparty" },
];

// One cell per tool, in the order of `tools`.
export const rows: { label: string; cells: string[] }[] = [
  {
    label: "Default address",
    cells: ["loopback only", "all interfaces", "all interfaces", "all interfaces", "all interfaces"],
  },
  {
    label: "Access control",
    cells: [
      "a key in the link, beyond loopback",
      "none",
      "user and password, optional",
      "accounts with rules for each path, optional",
      "accounts with permissions for each folder, optional",
    ],
  },
  {
    label: "Writes",
    cells: [
      "none unless turned on: upload, edit and delete, each behind a flag",
      "none",
      "none unless turned on: upload, new folders and delete, each behind a flag",
      "none unless turned on: upload and delete behind separate flags, or every operation with `-A`",
      "with no arguments, everyone can read and write the current folder; accounts restrict it",
    ],
  },
  {
    label: "Previews",
    cells: [
      "images, video, audio, PDF, Markdown, code, CSV, JSON, zip, HTML",
      "none",
      "`README.md` shown in a folder, optional",
      "none named in its README",
      "image gallery with a video player, audio player, text viewer with highlighting, Markdown viewer and editors, thumbnails",
    ],
  },
  {
    label: "Search",
    cells: [
      "every name in the tree, from an index kept in memory",
      "none",
      "a filter by name (`?search=`)",
      "by name (`?q=`), with `--allow-search`",
      "by name, path, size and date, from an index on disk, with `-e2dsa`",
    ],
  },
  {
    label: "Page follows the disk",
    cells: [
      "yes",
      "none documented",
      "none documented",
      "none documented",
      "none documented for the listing; the index can scan again on a timer",
    ],
  },
  {
    label: "TLS",
    cells: ["yes, optional", "since Python 3.14", "yes, optional", "yes, optional", "yes"],
  },
];

// Where another tool is the better choice.
export const better: string[] = [
  "Uploads that resume, accounts, or WebDAV, FTP and SFTP: copyparty.",
  "Users, permissions for each of them, share links, or a login through OIDC or LDAP: FileBrowser Quantum.",
  "A WebDAV server, or a place to upload to with `curl`: dufs. miniserve takes `curl` uploads too, and its WebDAV is read only.",
  "A terminal is already open on that machine: yazi, a file manager with previews that runs in the terminal.",
  "A plain listing for a moment, where Python is installed: `python -m http.server`.",
  "A file browser under a path such as `example.com/files/`: not okfs, which has no base-path option.",
];

export const sources: { name: string; links: string[] }[] = [
  { name: "`python -m http.server`", links: ["https://docs.python.org/3/library/http.server.html"] },
  { name: "miniserve", links: ["https://github.com/svenstaro/miniserve/blob/master/README.md"] },
  {
    name: "dufs",
    links: ["https://github.com/sigoden/dufs/blob/main/README.md", "https://github.com/sigoden/dufs/blob/main/src/args.rs"],
  },
  { name: "copyparty", links: ["https://github.com/9001/copyparty/blob/hovudstraum/README.md"] },
  { name: "FileBrowser Quantum", links: ["https://github.com/gtsteffaniak/filebrowser/blob/main/README.md"] },
  { name: "File Browser", links: ["https://github.com/filebrowser/filebrowser/blob/master/README.md"] },
  { name: "yazi", links: ["https://github.com/sxyazi/yazi/blob/main/README.md"] },
];

export const note = `This is how each tool read on ${read}, from its own documentation. "None documented" means that the pages below name no such feature, not that a test found none. Check the project you are comparing before you rely on a cell.`;

// The block of docs/comparison.md between the markers.
export function markdown(): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(["", ...tools.map((tool) => tool.name)]),
    line(["---", ...tools.map(() => "---")]),
    ...rows.map((row) => line([row.label, ...row.cells])),
    "",
    note,
    "",
    "## Where another tool is the better choice",
    "",
    ...better.map((item) => `- ${item}`),
    "",
    "## Sources",
    "",
    ...sources.map((source) => `- ${source.name}: ${source.links.map((link) => `<${link}>`).join(", ")}`),
  ].join("\n");
}

export const start = "<!-- comparison:start - written by `npm run comparison` in web/ from web/src/comparison.ts -->";
export const end = "<!-- comparison:end -->";
