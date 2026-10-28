// The demo folder: "tidewater", a small harbor-watching project grown into a big tree. The same seed
// gives the same tree in every tab and in the engine's worker, so a path names the same file everywhere.
// A folder fills itself the first time it is read, so the page holds only what it has looked at, and
// the engine's walk holds everything.
/* eslint-disable no-bitwise */

const enc = new TextEncoder();
const EMPTY = new Uint8Array(0);
const DAY = 86400;

/** A folder fills itself with this the first time it is read. */
export type Fill = ((dir: Dir) => void) | null;
export type Node = File | Dir;

export class File {
  declare name: string;
  declare size: number;
  declare mtime: number;
  declare body?: string | Uint8Array;
  constructor(name: string, size: number, mtime: number, body?: string | Uint8Array) {
    this.name = name;
    this.size = size;
    this.mtime = mtime;
    if (body !== undefined) this.body = body;
  }
  get isDir(): false {
    return false;
  }
  bytes(): Uint8Array {
    if (this.body === undefined) return EMPTY;
    if (typeof this.body === "string") this.body = enc.encode(this.body);
    return this.body as Uint8Array;
  }
}

export class Dir {
  declare name: string;
  declare mtime: number;
  declare fill: Fill;
  declare kids: Node[] | null;
  declare map: Map<string, Node> | null;
  declare hint?: number;
  constructor(name: string, mtime: number, fill: Fill) {
    this.name = name;
    this.mtime = mtime;
    this.fill = fill;
    this.kids = null;
    this.map = null;
  }
  get isDir(): true {
    return true;
  }
  list(): Node[] {
    if (!this.kids) {
      this.kids = [];
      const fill = this.fill;
      this.fill = null;
      fill?.(this);
    }
    return this.kids!;
  }
  child(name: string): Node | undefined {
    const kids = this.list();
    // The engine asks for each name in the order the folder listed them: try the one after the last first.
    const next = kids[this.hint ?? 0];
    if (next?.name === name) {
      this.hint = (this.hint ?? 0) + 1;
      return next;
    }
    // A short folder is looked through; a long one keeps a map, made the first time it is asked.
    if (kids.length < 40) return kids.find((kid) => kid.name === name);
    if (!this.map) {
      this.map = new Map();
      for (const kid of kids) this.map.set(kid.name, kid);
    }
    return this.map.get(name);
  }
  add<T extends Node>(node: T): T {
    this.list();
    this.kids!.push(node);
    this.map?.set(node.name, node);
    return node;
  }
  remove(name: string) {
    this.list();
    const at = this.kids!.findIndex((kid) => kid.name === name);
    if (at >= 0) this.kids!.splice(at, 1);
    this.map?.delete(name);
  }
  dir(name: string, mtime: number, fill: Fill): Dir {
    return this.add(new Dir(name, mtime, fill));
  }
  file(name: string, size: number, mtime: number, body?: string | Uint8Array): File {
    return this.add(new File(name, size, mtime, body));
  }
}

// ---- seeded randomness: the same path always draws the same numbers ----

export function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  next.pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  next.chance = (p: number) => next() < p;
  return next;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const ymd = (t: number) => {
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const dayStart = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// ---- the words the tree is made of ----

export const STATIONS = [
  "north-pier", "east-channel", "salt-marsh", "headland", "fog-bank", "low-tide-flats", "breakwater",
  "lighthouse-point", "kelp-bed", "oyster-reef", "harbor-mouth", "river-delta", "shoal-7", "buoy-12",
  "buoy-19", "seawall", "ferry-dock", "estuary-south", "mudflat-west", "tide-pool-3", "cove-inner",
  "cove-outer", "jetty-end", "dune-line", "eelgrass-bank", "mill-creek", "pilot-station", "sand-spit",
  "channel-marker-4", "old-quay", "rock-garden", "south-beacon",
];
const PLACES = [
  "north pier", "salt marsh", "the headland", "east channel", "fog bank", "breakwater", "lighthouse",
  "kelp bed", "oyster reef", "harbor mouth", "river delta", "ferry dock", "estuary", "jetty", "dunes",
  "mill creek", "sand spit", "old quay", "south beacon", "eelgrass", "mudflats", "tide pools",
];
const MOMENTS = ["at dawn", "at dusk", "low tide", "high water", "in fog", "spring tide", "storm", "first light",
  "last light", "night watch", "king tide", "after rain", "neap tide", "heron count", "survey"];
const PACKAGES = [
  "ui", "charts", "tides", "gauges", "geo", "units", "time", "format", "http", "auth", "db", "queue",
  "logger", "config", "icons", "maps", "tiles", "sync", "cache", "cli", "testing", "fixtures", "forms",
  "tables", "theme", "router", "store", "workers", "upload", "search", "alerts", "export", "import",
  "stations", "readings", "weather", "currents", "moon", "datum", "calibration", "reports", "pdf",
  "email", "i18n", "a11y", "telemetry", "flags", "billing",
];
const PARTS = [
  "button", "dialog", "chart", "legend", "axis", "tooltip", "table", "row", "cell", "card", "badge",
  "menu", "tabs", "slider", "toggle", "field", "select", "range", "sparkline", "gauge", "dial", "map",
  "marker", "layer", "popover", "toast", "banner", "empty-state", "skeleton", "header", "footer",
  "sidebar", "panel", "grid", "list", "tree", "breadcrumbs", "pager", "search-box", "date-picker",
];
const LIBS = [
  "parse", "format", "units", "convert", "range", "clamp", "interpolate", "smooth", "resample",
  "bucket", "window", "median", "harmonics", "phase", "datum", "offset", "station", "reading", "series",
  "cache", "retry", "fetch", "schema", "validate", "encode", "decode", "stream", "batch", "queue",
];
const CRATES = [
  "tide-core", "tide-harmonics", "gauge-proto", "gauge-daemon", "tile-render", "chart-svg", "datum",
  "station-db", "reading-codec", "geo-grid", "moon-phase", "tide-api", "sync-agent", "ingest",
];
const NPM = [
  "react", "react-dom", "preact", "scheduler", "typescript", "esbuild", "vite", "rollup", "postcss",
  "autoprefixer", "tailwindcss", "zod", "date-fns", "d3-scale", "d3-shape", "d3-array", "d3-time",
  "d3-format", "d3-interpolate", "d3-color", "d3-path", "maplibre-gl", "pmtiles", "lodash", "nanoid",
  "clsx", "tslib", "semver", "chalk", "commander", "yargs", "debug", "ms", "picomatch", "micromatch",
  "fast-glob", "glob", "minimatch", "brace-expansion", "balanced-match", "acorn", "estree-walker",
  "magic-string", "source-map", "source-map-js", "picocolors", "nanoid", "vitest", "chai", "tinyspy",
  "@types/node", "@types/react", "@babel/core", "@babel/parser", "@babel/types", "@babel/traverse",
  "@babel/generator", "@vitejs/plugin-react", "eslint", "prettier", "undici", "ws", "cookie",
  "mime", "uuid", "dotenv", "cross-spawn", "which", "path-key", "shebang-command", "signal-exit",
  "rimraf", "fs-extra", "graceful-fs", "jsonfile", "universalify", "kleur", "sade", "mri", "fflate",
  "buffer", "base64-js", "ieee754", "events", "util", "inherits", "safe-buffer", "string_decoder",
];
const TOPICS = ["tidal-harmonics", "sediment", "estuaries", "sea-level", "instrumentation", "storm-surge",
  "salt-marsh-ecology", "bathymetry", "currents", "datums"];
const SURNAMES = ["okafor", "lindqvist", "marsh", "nakamura", "oduya", "pereira", "haldane", "ibsen",
  "varga", "achebe", "moreau", "castellan", "whitby", "rao", "sorensen", "quill", "abernathy", "tanaka"];
const PAPER_WORDS = ["tidal", "asymmetry", "estuary", "residual", "currents", "harmonic", "analysis",
  "marsh", "accretion", "surge", "forecast", "datum", "drift", "gauge", "calibration", "sediment",
  "transport", "shoreline", "change", "wave", "setup", "inlet", "stability", "bathymetric", "survey"];

/** Where the demo's clock stood when the tidewater files were made: their ages are kept from here. */
const MADE = 1791763200;

/**
 * The served folder, named `tidewater`, inside a preopen root. `now` is in seconds: file ages count back
 * from it, so a visit always finds files written today.
 */
export function makeTree(now: number) {
  const root = new Dir("", now, null);
  root.kids = [];
  root.dir("tidewater", now - 3 * 3600, (top) => fillTop(top, now));
  return root;
}

/** The real tidewater files, with their sizes, and their ages counted back from `now`. */
export const SHOWCASE: [string, number, number][] = [
  ["README.md", 277, 1779102000],
  ["data/june-raw.csv", 5237, 1782892800],
  ["data/station-map.svg", 4664, 1779290520],
  ["field-notes.md", 887, 1791566400],
  ["gauges.json", 623, 1779291000],
  ["harbor-at-dawn.jpg", 97150, 1780980540],
  ["harbor-bell.wav", 176444, 1780981320],
  ["photos/01-low-tide.jpg", 71151, 1780380840],
  ["photos/02-north-pier.jpg", 84352, 1780980720],
  ["photos/03-salt-marsh.jpg", 66682, 1782037800],
  ["photos/04-night-watch.jpg", 82051, 1783204860],
  ["photos/05-headland.jpg", 72706, 1784394300],
  ["photos/06-fog-bank.jpg", 75665, 1785563280],
  ["photos/07-east-channel.jpg", 99330, 1787487120],
  ["photos/08-last-light.jpg", 91299, 1789238220],
  ["ridge-line.jpg", 72371, 1787490060],
  ["src/Makefile.toml", 57, 1779951600],
  ["src/plot.py", 847, 1790586900],
  ["src/tide.rs", 1524, 1791060000],
  ["stations.csv", 5237, 1791486660],
  ["survey-2026.zip", 5861, 1790805600],
  ["tide-table.txt", 990, 1779179400],
];

/** Files beside the tidewater set, with real contents of their own. Size, age in days. */
export const EXTRAS: [string, number, number][] = [
  ["harbor-timelapse.webm", 88162, 1.4],
  ["annual-survey-2025.pdf", 29491, 6.2],
  ["tide-chart.html", 3312, 0.6],
  ["season-plan.md", 623, 0.9],
];

function fillTop(top: Dir, now: number) {
  const age = (t: number) => now - (MADE - t);
  const folders = new Map<string, Dir>();
  const folder = (path: string): Dir => {
    if (!path) return top;
    if (!folders.has(path)) folders.set(path, folder(path.split("/").slice(0, -1).join("/")).dir(path.split("/").pop()!, now, null));
    return folders.get(path)!;
  };
  // The real files first, so the folders they sit in are made by them.
  for (const [path, size, made] of SHOWCASE) {
    const at = path.lastIndexOf("/");
    const dir = folder(at < 0 ? "" : path.slice(0, at));
    dir.file(path.slice(at + 1), size, age(made));
  }
  for (const [name, size, days] of EXTRAS) top.file(name, size, Math.round(now - days * DAY));
  for (const dir of folders.values()) dir.mtime = Math.max(...dir.kids!.map((kid) => kid.mtime));
  folder("photos").dir("library", now - 9 * DAY, (dir) => fillLibrary(dir, now));

  top.file(".gitignore", 31, now - 300 * DAY, "scratch/\n*.tmp\n.DS_Store\n");
  top.file(".okfsignore", 64, now - 120 * DAY, "# raw scans are kept, not searched\nscans/raw\n");
  top.dir("archive", now - DAY + 600, (dir) => fillArchive(dir, now));
  top.dir("maps", now - 41 * DAY, (dir) => fillMaps(dir, now));
  top.dir("harbor", now - 2 * 3600, (dir) => fillHarbor(dir, now));
  top.dir("recordings", now - 3 * DAY, (dir) => fillRecordings(dir, now));
  top.dir("notes", now - 5 * 3600, (dir) => fillNotes(dir, now));
  top.dir("papers", now - 18 * DAY, (dir) => fillPapers(dir, now));
  top.dir("scans", now - 64 * DAY, (dir) => fillScans(dir, now));
  top.dir("scratch", now - 12 * DAY, (dir) => {
    for (let i = 1; i <= 40; i++) dir.file(`try-${pad(i, 3)}.tmp`, 1200 + i * 97, now - i * 3 * DAY);
  });
}

// archive/<station>/<year>/<MM>/<YYYY-MM-DD>.csv: ten-minute readings, one file a day per gauge.
function fillArchive(dir: Dir, now: number) {
  dir.file("README.md", 612, now - 220 * DAY);
  const today = new Date(now * 1000);
  const thisYear = today.getUTCFullYear();
  STATIONS.forEach((station, i) => {
    const first = 2009 + ((i * 7) % 11);
    dir.dir(station, now - DAY + 600, (s) => {
      s.file("station.json", 900 + (hash(station) % 400), dayStart(first, 3, 1) + 3600);
      for (let year = first; year <= thisYear; year++) {
        s.dir(String(year), year === thisYear ? now - DAY + 600 : dayStart(year, 12, 31) + DAY + 600, (y) => {
          const lastMonth = year === thisYear ? today.getUTCMonth() + 1 : 12;
          for (let m = 1; m <= lastMonth; m++) {
            const end = year === thisYear && m === lastMonth ? today.getUTCDate() - 1 : daysIn(year, m);
            if (end < 1) continue;
            const r = rng(hash(`${station}/${year}/${m}`));
            y.dir(pad(m), dayStart(year, m, end) + DAY + 600, (month) => {
              for (let d = 1; d <= end; d++) {
                // A gauge is down now and then: those days have no file.
                if (r.chance(0.015)) continue;
                const t = dayStart(year, m, d);
                month.file(`${ymd(t)}.csv`, 38000 + Math.floor(r() * 9000), t + DAY + 600 + r.int(0, 900));
              }
              month.file("summary.json", 2100 + r.int(0, 600), dayStart(year, m, end) + DAY + 1200);
            });
          }
        });
      }
    });
  });
}

// maps/tiles/<z>/<x>/<y>.png: a nautical chart cut into the usual web map tiles.
function fillMaps(dir: Dir, now: number) {
  const made = now - 41 * DAY;
  dir.file("README.md", 540, made - 2 * DAY);
  dir.file("harbor-chart.svg", 48211, made - 3 * DAY);
  dir.dir("charts", made - 3 * DAY, (charts) => {
    STATIONS.forEach((station, i) => charts.file(`${station}.svg`, 9000 + (hash(station) % 9000), made - 3 * DAY - i * 3600));
  });
  dir.dir("tiles", made, (tiles) => {
    for (let z = 0; z <= 8; z++) {
      tiles.dir(String(z), made, (zd) => {
        const n = 1 << z;
        for (let x = 0; x < n; x++) {
          zd.dir(String(x), made, (xd) => {
            const r = rng(hash(`t${z}/${x}`));
            for (let y = 0; y < n; y++) xd.file(`${y}.png`, 1800 + Math.floor(r() * 26000), made - r.int(0, 4000));
          });
        }
      });
    }
  });
}

// photos/library/<year>/<MM-DD place>/IMG_####.jpg, numbered the way a camera numbers them.
function fillLibrary(dir: Dir, now: number) {
  const thisYear = new Date(now * 1000).getUTCFullYear();
  let counter = 1;
  const years: number[] = [];
  for (let year = 2016; year <= thisYear; year++) years.push(year);
  // Numbers run on from year to year, so they are worked out for every year up front.
  const plan = years.map((year) => {
    const r = rng(hash(`lib${year}`));
    const shoots: { name: string; t: number; frames: number; first: number }[] = [];
    for (let m = 1; m <= 12; m++) {
      const count = r.int(2, 5);
      const days: number[] = [];
      for (let k = 0; k < count; k++) days.push(r.int(1, daysIn(year, m)));
      days.sort((a, b) => a - b);
      for (const d of days) {
        const t = dayStart(year, m, d) + r.int(5, 20) * 3600;
        if (t > now - 9 * DAY) continue;
        const frames = r.int(16, 120);
        shoots.push({ name: `${pad(m)}-${pad(d)} ${r.pick(PLACES)} ${r.pick(MOMENTS)}`, t, frames, first: counter });
        counter = ((counter + frames - 1) % 9999) + 1;
      }
    }
    return { year, shoots };
  });
  for (const { year, shoots } of plan) {
    if (!shoots.length) continue;
    dir.dir(String(year), shoots[shoots.length - 1]!.t + 2 * DAY, (y) => {
      for (const shoot of shoots) {
        y.dir(shoot.name, shoot.t + DAY, (s) => {
          const r = rng(hash(`${year}/${shoot.name}`));
          let t = shoot.t;
          for (let i = 0; i < shoot.frames; i++) {
            const n = ((shoot.first + i - 1) % 9999) + 1;
            t += r.int(4, 300);
            s.file(`IMG_${pad(n, 4)}.jpg`, 2400000 + Math.floor(r() * 4200000), t);
            if (r.chance(0.03)) s.file(`IMG_${pad(n, 4)}.mov`, 18000000 + Math.floor(r() * 90000000), t + 5);
          }
        });
      }
    });
  }
}

// harbor/: the code that runs the gauges, the site and the charts. Its build output and its
// dependencies are left out of the search by its .gitignore and by okfs's own list.
function fillHarbor(dir: Dir, now: number) {
  const r = rng(hash("harbor"));
  const recent = (days: number) => now - Math.floor(r() * days * DAY);
  dir.file(".gitignore", 58, now - 400 * DAY, "target/\ndist/\ncoverage/\n*.log\n.turbo/\n");
  dir.file("README.md", 2210, now - 6 * DAY);
  dir.file("package.json", 1043, now - 3 * DAY);
  dir.file("bun.lock", 186402, now - 3 * DAY);
  dir.file("tsconfig.json", 612, now - 200 * DAY);
  dir.file("turbo.json", 488, now - 90 * DAY);
  dir.file("Cargo.toml", 742, now - 11 * DAY);
  dir.file("Cargo.lock", 98211, now - 11 * DAY);
  dir.file("LICENSE", 1071, now - 900 * DAY);
  dir.file("flake.nix", 1830, now - 40 * DAY);
  dir.dir("apps", now - 2 * 3600, (apps) => {
    for (const app of ["web", "dashboard", "tide-api", "gauge-daemon", "mobile"]) {
      apps.dir(app, recent(20), (a) => fillPackage(a, `apps/${app}`, now, app === "tide-api" || app === "gauge-daemon" ? "rust" : "ts", 3));
    }
  });
  dir.dir("packages", now - 5 * 3600, (pkgs) => {
    for (const name of PACKAGES) pkgs.dir(name, recent(60), (p) => fillPackage(p, `packages/${name}`, now, "ts", 1));
  });
  dir.dir("crates", now - 26 * 3600, (crates) => {
    for (const name of CRATES) crates.dir(name, recent(45), (c) => fillPackage(c, `crates/${name}`, now, "rust", 1));
  });
  dir.dir("docs", now - 6 * DAY, (docs) => {
    const sections = ["getting-started", "gauges", "stations", "api", "deploy", "tiles", "datums", "runbooks", "decisions"];
    for (const section of sections) {
      docs.dir(section, recent(80), (s) => {
        const q = rng(hash(`docs/${section}`));
        const n = q.int(6, 22);
        for (let i = 0; i < n; i++) s.file(`${pad(i + 1)}-${slug(`${q.pick(LIBS)} ${q.pick(PARTS)}`)}.md`, 1200 + q.int(0, 9000), recent(300));
      });
    }
  });
  dir.dir("scripts", now - 30 * DAY, (s) => {
    for (const name of ["bootstrap.sh", "release.sh", "seed-db.py", "render-tiles.sh", "backfill.py", "check-gauges.sh", "deploy.sh"]) s.file(name, 800 + r.int(0, 4000), recent(200));
  });
  // Left out: node_modules by okfs's own list of names, target/ and dist/ by the .gitignore above.
  dir.dir("node_modules", now - 3 * DAY, (nm) => fillNodeModules(nm, now));
  dir.dir("target", now - 26 * 3600, (t) => {
    for (const profile of ["debug", "release"]) {
      t.dir(profile, now - 26 * 3600, (p) => {
        p.dir("deps", now - 26 * 3600, (deps) => {
          const q = rng(hash(`target/${profile}`));
          for (let i = 0; i < 2400; i++) {
            const crate = `${q.pick(NPM).replace(/[@/.-]/g, "_")}-${(q() * 0xffffffff >>> 0).toString(16).padStart(8, "0")}${pad(i % 100)}`;
            deps.file(`lib${crate}.rlib`, 40000 + q.int(0, 2000000), now - 26 * 3600 - q.int(0, 200000));
            if (q.chance(0.5)) deps.file(`${crate}.d`, 400 + q.int(0, 4000), now - 26 * 3600);
          }
        });
        p.dir("build", now - 26 * 3600, null);
        p.dir("incremental", now - 26 * 3600, null);
      });
    }
  });
  dir.dir("dist", now - 2 * DAY, (d) => {
    for (let i = 0; i < 180; i++) d.file(`chunk-${(hash(`c${i}`) >>> 0).toString(36)}.js`, 4000 + i * 311, now - 2 * DAY);
  });
}

function fillPackage(dir: Dir, path: string, now: number, lang: string, scale: number) {
  const r = rng(hash(path));
  const recent = (days: number) => now - Math.floor(r() * days * DAY) - 600;
  const name = path.split("/").pop()!;
  if (lang === "rust") {
    dir.file("Cargo.toml", 400 + r.int(0, 600), recent(90));
    dir.file("README.md", 900 + r.int(0, 3000), recent(200));
    dir.dir("src", recent(10), (src) => {
      src.file(name.includes("daemon") || name.includes("api") ? "main.rs" : "lib.rs", 2000 + r.int(0, 9000), recent(10));
      const n = r.int(8, 30) * scale;
      const used = new Set();
      for (let i = 0; i < n; i++) {
        const file = `${r.pick(LIBS).replace(/-/g, "_")}.rs`;
        if (used.has(file)) continue;
        used.add(file);
        src.file(file, 600 + r.int(0, 14000), recent(120));
      }
      if (scale > 1) {
        for (const sub of ["routes", "store", "proto"]) {
          src.dir(sub, recent(30), (s) => {
            for (let i = 0; i < r.int(6, 18); i++) s.file(`${slug(`${r.pick(LIBS)} ${r.pick(LIBS)}`).replace(/-/g, "_")}.rs`, 700 + r.int(0, 8000), recent(90));
          });
        }
      }
    });
    dir.dir("tests", recent(30), (t) => {
      for (let i = 0; i < r.int(2, 9); i++) t.file(`${r.pick(LIBS).replace(/-/g, "_")}_${i}.rs`, 800 + r.int(0, 5000), recent(120));
    });
    if (r.chance(0.5)) dir.dir("benches", recent(200), (b) => b.file("throughput.rs", 1800, recent(200)));
    return;
  }
  dir.file("package.json", 500 + r.int(0, 900), recent(30));
  dir.file("README.md", 800 + r.int(0, 3000), recent(200));
  dir.file("CHANGELOG.md", 1500 + r.int(0, 20000), recent(30));
  dir.file("tsconfig.json", 300 + r.int(0, 200), recent(400));
  dir.dir("src", recent(5), (src) => {
    src.file("index.ts", 300 + r.int(0, 1500), recent(20));
    const groups = scale > 1 ? ["components", "hooks", "lib", "routes", "styles", "stores"] : ["components", "lib", "hooks"];
    for (const group of groups) {
      if (scale === 1 && r.chance(0.3)) continue;
      src.dir(group, recent(20), (g) => {
        const n = r.int(4, 24) * scale;
        const used = new Set();
        for (let i = 0; i < n; i++) {
          const base = group === "components" ? r.pick(PARTS) : group === "hooks" ? `use-${r.pick(LIBS)}` : r.pick(LIBS);
          const ext = group === "components" || group === "routes" ? "tsx" : group === "styles" ? "css" : "ts";
          const file = `${base}.${ext}`;
          if (used.has(file)) continue;
          used.add(file);
          g.file(file, 400 + r.int(0, 12000), recent(150));
          if (group === "components" && r.chance(0.5)) g.file(`${base}.test.tsx`, 600 + r.int(0, 5000), recent(150));
        }
      });
    }
  });
  dir.dir("test", recent(40), (t) => {
    for (let i = 0; i < r.int(2, 8); i++) t.file(`${r.pick(LIBS)}.test.ts`, 700 + r.int(0, 6000), recent(150));
  });
  if (scale > 1) {
    dir.dir("public", recent(100), (p) => {
      p.file("favicon.svg", 812, recent(400));
      p.file("index.html", 1430, recent(100));
      p.file("robots.txt", 24, recent(400));
      for (let i = 0; i < 20; i++) p.file(`og-${STATIONS[i]}.png`, 40000 + r.int(0, 90000), recent(200));
    });
  }
}

function fillNodeModules(dir: Dir, now: number) {
  const r = rng(hash("node_modules"));
  const seen = new Set();
  const add = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const scoped = name.startsWith("@");
    const fillPkg = (p: Dir) => {
      const q = rng(hash(name));
      p.file("package.json", 600 + q.int(0, 3000), now - q.int(30, 900) * DAY);
      p.file("README.md", 1000 + q.int(0, 12000), now - q.int(30, 900) * DAY);
      p.file("LICENSE", 1080, now - 900 * DAY);
      p.dir(q.chance(0.5) ? "dist" : "lib", now - 30 * DAY, (lib) => {
        const n = q.int(4, 60);
        for (let i = 0; i < n; i++) lib.file(`${q.pick(LIBS)}${i ? `-${i}` : ""}.${q.chance(0.3) ? "d.ts" : "js"}`, 300 + q.int(0, 30000), now - 30 * DAY);
      });
    };
    if (scoped) {
      const [scope, base] = name.split("/") as [string, string];
      let s = dir.child(scope) as Dir | undefined;
      if (!s) s = dir.dir(scope, now - 3 * DAY, null);
      s.list();
      s.dir(base, now - 3 * DAY, fillPkg);
    } else dir.dir(name, now - 3 * DAY, fillPkg);
  };
  for (const name of NPM) add(name);
  // The long tail every lockfile has.
  for (let i = 0; i < 520; i++) add(`${r.pick(LIBS)}-${r.pick(PARTS)}${r.chance(0.3) ? `-${r.int(2, 9)}` : ""}`);
}

// recordings/<site>/<YYYY-MM-DD>/<hh-mm>.flac: a hydrophone on each site, a few minutes every few hours.
function fillRecordings(dir: Dir, now: number) {
  const sites = ["harbor-mouth", "kelp-bed", "north-pier", "oyster-reef", "pilot-station", "sand-spit", "mill-creek", "south-beacon"];
  dir.file("README.md", 700, now - 160 * DAY);
  for (const site of sites) {
    dir.dir(site, now - 3 * DAY, (s) => {
      const r = rng(hash(`rec/${site}`));
      const days = r.int(220, 320);
      for (let k = days; k >= 3; k--) {
        if (r.chance(0.12)) continue;
        const t = Math.floor((now - k * DAY) / DAY) * DAY;
        s.dir(ymd(t), t + DAY, (d) => {
          const q = rng(hash(`rec/${site}/${k}`));
          for (let h = 0; h < 24; h += q.int(2, 5)) {
            const at = t + h * 3600 + q.int(0, 50) * 60;
            const name = `${pad(new Date(at * 1000).getUTCHours())}-${pad(new Date(at * 1000).getUTCMinutes())}`;
            d.file(`${name}.flac`, 9000000 + q.int(0, 16000000), at + 360);
            if (q.chance(0.15)) d.file(`${name}.json`, 400 + q.int(0, 300), at + 400);
          }
        });
      }
    });
  }
}

// notes/<year>/<MM>/<YYYY-MM-DD>.md: a note most days.
function fillNotes(dir: Dir, now: number) {
  const today = new Date(now * 1000);
  const thisYear = today.getUTCFullYear();
  for (let year = 2019; year <= thisYear; year++) {
    dir.dir(String(year), year === thisYear ? now - 5 * 3600 : dayStart(year, 12, 31) + 72000, (y) => {
      const lastMonth = year === thisYear ? today.getUTCMonth() + 1 : 12;
      for (let m = 1; m <= lastMonth; m++) {
        const end = year === thisYear && m === lastMonth ? today.getUTCDate() : daysIn(year, m);
        y.dir(pad(m), dayStart(year, m, end) + 72000, (month) => {
          const r = rng(hash(`notes/${year}/${m}`));
          for (let d = 1; d <= end; d++) {
            if (r.chance(0.2)) continue;
            const t = dayStart(year, m, d);
            const written = Math.min(now - 5 * 3600, t + r.int(17, 23) * 3600 + r.int(0, 3599));
            month.file(`${ymd(t)}.md`, 300 + r.int(0, 4200), written);
          }
        });
      }
    });
  }
}

function fillPapers(dir: Dir, now: number) {
  for (const topic of TOPICS) {
    dir.dir(topic, now - 18 * DAY, (t) => {
      const r = rng(hash(`papers/${topic}`));
      const n = r.int(30, 90);
      for (let i = 0; i < n; i++) {
        const year = r.int(1987, 2026);
        const words = [r.pick(PAPER_WORDS), r.pick(PAPER_WORDS), r.pick(PAPER_WORDS)].join("-");
        t.file(`${r.pick(SURNAMES)}-${year}-${words}.pdf`, 300000 + r.int(0, 9000000), now - r.int(18, 1500) * DAY);
      }
    });
  }
}

function fillScans(dir: Dir, now: number) {
  dir.file("README.md", 420, now - 64 * DAY);
  for (let box = 1; box <= 12; box++) {
    dir.dir(`logbook-${pad(box)}`, now - (64 + box) * DAY, (b) => {
      const r = rng(hash(`scan${box}`));
      const n = r.int(60, 140);
      for (let i = 1; i <= n; i++) b.file(`page-${pad(i, 3)}.jpg`, 900000 + r.int(0, 1500000), now - (64 + box) * DAY + i * 40);
    });
  }
  // Left out by the .okfsignore in the served folder: listed, and not searched.
  dir.dir("raw", now - 70 * DAY, (raw) => {
    for (let box = 1; box <= 12; box++) {
      raw.dir(`logbook-${pad(box)}`, now - 70 * DAY, (b) => {
        for (let i = 1; i <= 140; i++) b.file(`page-${pad(i, 3)}.tif`, 48000000, now - 70 * DAY + i * 40);
      });
    }
  });
}
