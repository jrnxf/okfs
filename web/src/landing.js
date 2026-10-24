// The page around okfs: okfs itself on the first screen with a short tutorial over it and the status line under
// it, the sections that drive an okfs of their own or ask its engine directly, and the scheme.
import { boot } from "./runtime.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const html = document.documentElement;
const store = {
  get: (key) => {
    try {
      return localStorage.getItem(`okfs-landing.${key}`);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(`okfs-landing.${key}`, value);
    } catch {
      // The choice lasts for this visit.
    }
  },
};
const fmt = (n) => n.toLocaleString("en-US");
const scheme = () => (html.dataset.theme === "light" ? "light" : "dark");
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// The search box's answers, in two columns. landing.html starts the list with the empty one.
const HIT_BASE = "grid-cols-[18px_minmax(0,1fr)] gap-x-2 break-inside-avoid py-2";
const HIT = `${HIT_BASE} group grid cursor-pointer border-b border-b-rule`;
const HIT_EMPTY = `${HIT_BASE} block cursor-default border-0 text-[15px] text-ink-3 [column-span:all]`;

// ---------- the page's own controls ----------

const schemeListeners = new Set();
/** The page's scheme, and every okfs's with it. `from` is the okfs that changed first, which is not told again. */
function setScheme(next, from) {
  html.dataset.theme = next;
  store.set("theme", next);
  $('meta[name="theme-color"]').setAttribute("content", next === "dark" ? "#0c0c0d" : "#e8e7e2");
  schemeListeners.forEach((fn) => fn(next, from));
}
$("#theme").addEventListener("click", () => setScheme(scheme() === "dark" ? "light" : "dark"));

let toastTimer;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 2800);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;opacity:0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}
for (const b of $$("[data-copy]")) {
  b.addEventListener("click", async () => {
    const ok = await copy(b.dataset.copy);
    const was = b.textContent;
    b.textContent = ok ? "Copied" : "Select it";
    setTimeout(() => (b.textContent = was), 1400);
  });
}

// ---------- the tutorial ----------

/**
 * A few hints over okfs, one at a time. Each asks for one real thing and gives way to the next when okfs says it
 * was done: a key pressed, an address it went to, a search, a scheme. Skip, Esc or the last hint ends it for good,
 * on this browser; after the last, a short note says so and fades by itself. "Show tutorial" in the bar starts it
 * again. `free` hands the keys to okfs once it ends.
 */
function makeTutorial({ free }) {
  const box = $("#tut");
  const again = $("#tut-again");
  const kb = (...keys) => keys.map((k) => `<kbd>${k}</kbd>`).join(" or ");
  const moved = (e) => ["j", "k", "ArrowDown", "ArrowUp"].includes(e.key) && !e.typing && !e.chord;
  // Moves between folders, from the address okfs went to: in, back up, or to a file.
  const into = (e) => e.to?.endsWith("/") && e.to.length > e.from.length && e.to.startsWith(e.from);
  const out = (e) => e.to?.endsWith("/") && e.to !== e.from && e.from.startsWith(e.to);
  const file = (e) => e.to !== undefined && !e.to.endsWith("/");
  const hello = "<b>This is okfs, running in your tab.</b>";
  const steps = matchMedia("(pointer: coarse)").matches
    ? [
        [`${hello} Tap a folder to open it.`, into],
        ["Tap the arrow at the top left to go back up.", out],
        ["Tap a file to open it.", file],
        ["Tap the magnifier and type any name. It searches the whole folder.", (e) => e.search],
        ["Tap the sun or moon at the top right to switch between dark and light.", (e) => e.scheme],
      ]
    : [
        [`${hello} Press ${kb("j", "↓")} to move down the list.`, moved],
        [`Press ${kb("l", "Enter")} to open the folder under the cursor.`, into],
        [`Press ${kb("h", "←")} to go back up.`, out],
        [`Move down to a file and press ${kb("Enter")} to open it.`, file],
        [`Press ${kb(/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K")} and type any name. It searches the whole folder.`, (e) => e.search],
        [`Press ${kb("t")} to switch between dark and light.`, (e) => e.scheme],
      ];
  const last = matchMedia("(pointer: coarse)").matches ? "That is all. The folder is yours to look around." : `That is all. Press ${kb("?")} in okfs for every key.`;
  let at = -1;
  let here = "/";
  let fading;

  function show(i) {
    if (i === steps.length) return finish();
    clearTimeout(fading);
    at = i;
    $("#tut-n").textContent = `${i + 1} of ${steps.length}`;
    $("#tut-say").innerHTML = steps[i][0];
    $("#tut-do").hidden = false;
    box.classList.remove("fin", "out");
    box.hidden = false;
    again.hidden = true;
  }
  function close() {
    clearTimeout(fading);
    box.hidden = true;
    box.classList.remove("fin", "out");
    again.hidden = false;
  }
  function end() {
    at = -1;
    store.set("tutorial", "done");
    const had = box.contains(document.activeElement);
    close();
    if (had) free();
  }
  /** The last hint is done: a note that says so, which nothing has to close and which lets clicks through. */
  function finish() {
    end();
    $("#tut-n").textContent = "Done";
    $("#tut-say").innerHTML = last;
    $("#tut-do").hidden = true;
    box.classList.add("fin");
    box.hidden = false;
    again.hidden = true;
    fading = setTimeout(() => {
      box.classList.add("out");
      fading = setTimeout(close, reduced ? 0 : 400);
    }, 3500);
  }
  /** Something happened in okfs: the hint on show is done if it asked for that. */
  function heard(e) {
    if (e.key === "Escape" && e.idle && at >= 0) return end();
    if (at >= 0 && at < steps.length && steps[at][1](e)) show(at + 1);
  }

  $("#tut-next").addEventListener("click", () => show(at + 1));
  $("#tut-skip").addEventListener("click", end);
  again.addEventListener("click", () => {
    show(0);
    box.focus();
  });

  return {
    start: () => (store.get("tutorial") === "done" ? (again.hidden = false) : show(0)),
    on: () => at >= 0,
    end,
    heard,
    went(path) {
      const to = path.split("?")[0];
      const from = here;
      here = to;
      if (to !== from) heard({ from, to });
    },
  };
}

// ---------- what shows while okfs starts ----------

// Placeholder rows in okfs's layout: the main list, then the folder under the cursor. Widths are fixed so the
// first paint is the same every time.
const WIDTHS = [[46, 58, 40, 64, 52, 44, 60, 38, 56, 48, 66, 42, 54, 50, 62, 36, 58, 44], [54, 40, 62, 48, 58, 36, 50, 44, 60]];
$$("#bones .col").forEach((col, i) => {
  for (const w of WIDTHS[i] ?? []) {
    const row = document.createElement("div");
    // The cursor's row, at the top of the list.
    const cursor = i === 0 && col.childElementCount === 0;
    row.className = `flex h-8.5 flex-none items-center gap-2.5 before:h-3 before:w-3.5 before:rounded-[3px] before:bg-ok-bone before:content-[''] motion-safe:before:animate-breathe under-760:h-10.5 ${
      cursor ? "-mx-3.5 bg-[color-mix(in_srgb,var(--spot)_12%,var(--ok-bg))] px-3.5 shadow-[inset_3px_0_0_var(--spot)]" : ""
    }`;
    row.innerHTML = `<i class="block h-2 rounded-[4px] bg-ok-bone motion-safe:animate-breathe" style="width:${w}%"></i>`;
    col.append(row);
  }
});
const say = document.createElement("div");
say.className =
  "say absolute top-11.5 right-0 bottom-7.5 grid w-1/2 place-content-center text-center [font:13px/1.5_var(--mono)] text-ok-faint under-760:w-full [&.err_b]:text-spot";
say.innerHTML = `<b class="block font-[400] text-ink" id="boot-text">Starting okfs</b><span id="boot-sub">in this tab, from this page alone</span>`;
$("#bones").append(say);

// ---------- driving okfs from outside its frame ----------

/** Presses, holds and types into okfs's page in a frame, the way a person would, by messages to it. */
function driver(handle) {
  return {
    key: (key, opts = {}) => handle.call("key", key, opts),
    hold: (key, ms, every = 50) => handle.call("hold", key, ms, every),
    down: (key, repeat) => handle.call("down", key, repeat),
    up: (key) => handle.call("up", key),
    type: (text, delay = 90) => handle.call("type", text, delay),
    /** Goes to an address in okfs's page, as the browser's back and forward do. */
    go: (url) => handle.call("go", url),
    palette: () => handle.call("palette"),
    closeAll: () => handle.call("closeAll"),
    scheme: (value) => handle.call("scheme", value),
  };
}

const prettyPath = (url) => {
  const u = new URL(url, "http://okfs.demo");
  const find = u.searchParams.get("find");
  return decodeURIComponent(u.pathname) + (find !== null ? `?find=${find}` : "");
};

// The things to try, in the status line. Disabled until okfs is up.
const chips = [
  ["j", "photos", "Hold j through the photos", async (d) => {
    await d.go("/photos/");
    await sleep(700);
    d.key("Home");
    await sleep(250);
    d.key("j");
    await sleep(500);
    await d.hold("j", 1400, 60);
  }],
  ["⌘K", "find", "Find anything", async (d) => {
    await d.closeAll();
    await d.palette();
    await sleep(350);
    await d.type("tide", 110);
  }],
  ["⏎", "list", "Every match in the list", (d) => d.go("/?find=readme")],
  [".", "hidden", "Show hidden: node_modules", async (d) => {
    await d.go("/harbor/");
    await sleep(700);
    d.key(".");
  }],
  ["▶", "film", "Play the timelapse", (d) => d.go("/harbor-timelapse.webm")],
  ["↗", "pdf", "Open the PDF", (d) => d.go("/annual-survey-2025.pdf")],
  ["r", "render", "Markdown, rendered", async (d) => {
    await d.go("/field-notes.md");
    await sleep(600);
    d.key("r");
  }],
  ["?", "keys", "All the keys", (d) => d.key("?")],
];
const chipButtons = chips.map(([k, short, label, run]) => {
  const b = document.createElement("button");
  b.type = "button";
  b.disabled = true;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.className =
    "cursor-pointer border-0 border-l border-l-rule bg-transparent px-3 py-0 text-ink-2 hover:bg-bg-2 hover:text-ink disabled:cursor-default disabled:bg-transparent disabled:opacity-45 [&.running]:bg-bg-2 [&.running]:text-ink under-1100:h-10 under-1100:truncate under-1100:border-r under-1100:border-l-0 under-1100:border-r-rule under-1100:px-1.5 under-1100:last:border-r-0 under-760:nth-[4n]:border-r-0 under-760:nth-[n+5]:border-t under-760:nth-[n+5]:border-t-rule";
  b.innerHTML = `<kbd class="mr-1.5 text-spot">${esc(k)}</kbd>${esc(short)}`;
  $("#keys").append(b);
  return [b, run];
});

// ---------- start ----------

async function main() {
  const bootText = $("#boot-text");
  const bootSub = $("#boot-sub");
  bootText.textContent = "Unpacking okfs's engine";
  const demo = await boot();
  window.__demo = demo;
  const { backend } = demo;

  $("#term-version").textContent = demo.stats.version;
  const frames = new Map();

  /** Mounts okfs in a container, opening at `start` with the page's scheme. A second mount replaces the first. */
  function mountIn(container, start, { pathEl, title, onKey, onNav, onReq, onScheme } = {}) {
    const old = frames.get(container);
    const sep = start.includes("?") ? "&" : "?";
    const at = start.includes("scheme=") ? start : `${start}${sep}scheme=${scheme()}`;
    let path = prettyPath(at);
    const handle = demo.mount(container, {
      start: at,
      title: title ?? "okfs, running in this page",
      class: "absolute inset-0 block size-full border-0 opacity-0 transition-opacity duration-400 ease-page [&.on]:opacity-100",
      on: {
        nav: (m) => {
          path = prettyPath(typeof m === "string" ? m : m.url);
          if (pathEl) pathEl.textContent = path;
          onNav?.(path);
        },
        key: (m) => !m.repeat && onKey?.(m.key, m),
        req: (m) => onReq?.(m.url),
        scheme: (m) => onScheme?.(m.scheme),
        toast: (m) => toast(m.text),
      },
    });
    void handle.whenReady().then(() => {
      requestAnimationFrame(() => handle.frame.classList.add("on"));
      if (old) setTimeout(() => old.handle.remove(), 400);
    });
    if (pathEl) pathEl.textContent = path;
    const entry = { handle, drive: driver(handle), path: () => path };
    frames.set(container, entry);
    return entry;
  }

  // Each frame follows the page's scheme: okfs's own `t` flips it.
  schemeListeners.add((next, from) => {
    for (const { handle, drive } of frames.values()) if (handle !== from) void drive.scheme(next);
  });

  // ---- the first screen ----
  const heroView = $("#view");
  const tutorial = makeTutorial({ free: () => hero.handle.frame.focus() });
  const hero = mountIn(heroView, "/", {
    pathEl: $("#path"),
    title: "okfs serving the demo folder tidewater",
    onKey: (key, m) => tutorial.heard({ key, ...m }),
    onNav: (path) => tutorial.went(path),
    onReq: (url) => {
      const q = new URL(url, "http://okfs.demo").searchParams.get("q") ?? "";
      if (url.startsWith("/api/search") && q.trim()) tutorial.heard({ search: true });
    },
    // okfs's own `t` or its menu changed its scheme: the page follows, and with it every other okfs.
    onScheme: (value) => (value === "dark" || value === "light") && value !== scheme() && setScheme(value, hero.handle),
  });
  schemeListeners.add(() => tutorial.heard({ scheme: true }));
  void hero.handle.whenReady().then(() => {
    setTimeout(() => $("#bones").classList.add("gone"), 250);
    tutorial.start();
  });

  let heroVisible = true;
  new IntersectionObserver(([e]) => (heroVisible = e.intersectionRatio > 0.3), { threshold: [0, 0.3, 0.6, 1] }).observe(heroView);

  // A key pressed on the page with nothing on it focused goes to okfs while okfs is on screen, so the hints
  // work without a click in first. The focus moves into okfs with it: the keys after go straight there.
  const OKFS_KEYS = new Set(["j", "k", "h", "l", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", "Home", "End", "/", ".", "t", "?"]);
  addEventListener("keydown", (e) => {
    if (e.defaultPrevented || !heroVisible) return;
    if (e.key === "Escape" && tutorial.on() && !e.target.closest?.("input, textarea, select")) return void tutorial.end();
    const free = e.target === document.body || e.target === html || ($("#tut").contains(e.target) && e.key !== "Enter" && e.key !== " ");
    const find = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k";
    if (!free || !(find || (!e.ctrlKey && !e.metaKey && !e.altKey && OKFS_KEYS.has(e.key)))) return;
    e.preventDefault();
    hero.handle.frame.focus();
    void hero.drive.key(find ? "k" : e.key, { ctrl: find });
    tutorial.heard({ key: e.key, chord: find, typing: false });
  });

  // The numbers in the status line.
  backend.onStatus((s) => {
    const n = s.ready ? s.indexed : s.seen;
    $("#st-count").textContent = fmt(n);
    if (!s.ready) {
      bootText.textContent = "Walking the folder";
      bootSub.textContent = `${fmt(s.seen)} entries so far`;
    }
    if (s.ready) {
      $("#st-walk").textContent = `${(s.walkMs / 1000).toFixed(2)} s`;
      $("#f-count").textContent = fmt(s.indexed);
    }
  });
  // Every search okfs's page makes is a search in the engine: show its time.
  const answer = backend.answer;
  backend.answer = async (url) => {
    const out = await answer(url);
    if (url.startsWith("/api/search") && out.status === 200) {
      try {
        const q = new URL(url, "http://okfs.demo").searchParams.get("q") ?? "";
        if (q.trim()) $("#st-search").textContent = `${JSON.parse(out.body).took.toFixed(1)} ms`;
      } catch {}
    }
    return out;
  };

  const heroDrive = hero.drive;
  for (const [b, run] of chipButtons) {
    b.disabled = false;
    b.addEventListener("click", async () => {
      b.classList.add("running");
      try {
        await heroDrive.closeAll();
        await run(heroDrive);
      } finally {
        setTimeout(() => b.classList.remove("running"), 600);
      }
    });
  }

  // ---- 01: the search box, straight to the engine ----
  const find = $("#find");
  const hits = $("#hits");
  const marked = (text, idx, offset) => {
    const at = new Set(idx.map((i) => i - offset));
    return [...text].map((c, i) => (at.has(i) ? `<mark class="bg-transparent text-spot">${esc(c)}</mark>` : esc(c))).join("");
  };
  let asked = 0;
  async function search(q) {
    const id = ++asked;
    if (!q.trim()) {
      hits.innerHTML = `<li class="${HIT_EMPTY}">Type a few letters of any name, or pick one above.</li>`;
      $("#find-ms").textContent = "-";
      $("#find-total").textContent = "0";
      return;
    }
    const found = await backend.search({ q, limit: 12 });
    if (id !== asked) return;
    $("#find-ms").textContent = found.took.toFixed(1);
    $("#f-ms").textContent = `${found.took.toFixed(0)} ms`;
    $("#find-total").textContent = fmt(found.total);
    $("#st-search").textContent = `${found.took.toFixed(1)} ms`;
    hits.innerHTML = found.hits.length
      ? found.hits
          .map((h) => {
            const slash = h.path.lastIndexOf("/");
            const name = h.path.slice(slash + 1);
            const dir = slash < 0 ? "/" : h.path.slice(0, slash);
            const shown = h.name ? marked(name, h.idx, 0) : marked(name, h.idx, slash + 1);
            return `<li class="${HIT}" data-path="${esc(h.path)}" data-dir="${h.dir ? 1 : 0}"><span class="[font:13px/1.6_var(--mono)] text-ink-3">${h.dir ? "/" : ""}</span><span class="truncate [font:600_19px/1.3_var(--sans)] group-hover:text-spot">${shown}</span><span class="col-[2] truncate [font:12.5px/1.4_var(--mono)] text-ink-3">${esc(dir)}</span></li>`;
          })
          .join("")
      : `<li class="${HIT_EMPTY}">Nothing matches. okfs looked through all ${fmt(found.indexed)} names.</li>`;
  }
  find.addEventListener("input", () => void search(find.value));
  hits.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-path]");
    if (!li) return;
    void heroDrive.go(`/${li.dataset.path.split("/").map(encodeURIComponent).join("/")}${li.dataset.dir === "1" ? "/" : ""}`);
    scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  });
  for (const q of ["tide", "img_0042", "north pier 2024", "button.tsx", "readme", "survey pdf", "kelp flac"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cursor-pointer border-0 bg-transparent p-0 text-ink-2 hover:text-spot";
    b.textContent = q;
    b.addEventListener("click", async () => {
      find.value = "";
      for (const ch of q) {
        find.value += ch;
        await search(find.value);
        await sleep(reduced ? 0 : 45);
      }
    });
    $("#samples").append(b);
  }
  // The box opens with one search made, so the section shows what an answer looks like.
  find.value = "tide";
  void search(find.value);

  // ---- sections with an okfs of their own, started when they come into view ----
  const lazy = (el, fn) =>
    new IntersectionObserver(
      ([e], obs) => {
        if (!e.isIntersecting) return;
        obs.disconnect();
        fn();
      },
      { rootMargin: "300px 0px" },
    ).observe(el);

  // 02: keys, with each key shown in the status line as it is pressed.
  const keysView = $("#keys-view");
  const hud = $("#hud");
  const showHud = (k) => {
    const label = { ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→", Enter: "⏎", Escape: "esc", " ": "space", Backspace: "⌫" }[k] ?? k;
    const el = document.createElement("kbd");
    el.className = "animate-[hud_.9s_var(--ease)_forwards] border border-rule px-1.5 py-0.75 [font:12px/1_var(--mono)] text-ink";
    el.textContent = label;
    hud.append(el);
    while (hud.children.length > 6) hud.firstChild.remove();
    setTimeout(() => el.remove(), 900);
  };
  let keys;
  lazy(keysView, () => {
    keys = mountIn(keysView, keysView.dataset.start, { pathEl: $('[data-path-for="keys"]'), onKey: showHud });
    void keys.handle.whenReady().then(async () => {
      await sleep(500);
      keys.drive.key("Home");
      keys.drive.key("l");
      await sleep(500);
      keys.drive.key("j");
    });
  });
  const hold = $("#hold");
  let holding = null;
  const startHold = (e) => {
    e.preventDefault();
    if (!keys || holding) return;
    hold.classList.add("down");
    showHud("j");
    let first = true;
    holding = setInterval(() => {
      void keys.drive.down("j", !first);
      first = false;
    }, 60);
  };
  const endHold = () => {
    if (!holding) return;
    clearInterval(holding);
    holding = null;
    hold.classList.remove("down");
    void keys?.drive.up("j");
  };
  hold.addEventListener("pointerdown", startHold);
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) hold.addEventListener(type, endHold);
  hold.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") startHold(e);
  });
  hold.addEventListener("keyup", endHold);

  // 03: previews of each kind.
  const kinds = [
    ["Picture", "/photos/05-headland.jpg", "#c05fb0"],
    ["Video", "/harbor-timelapse.webm", "#d9772b"],
    ["Sound", "/harbor-bell.wav", "#d9772b"],
    ["PDF", "/annual-survey-2025.pdf", "#8a8a86"],
    ["Markdown", "/field-notes.md", "#8a8a86"],
    ["Code", "/src/tide.rs", "#3f9b6c"],
    ["Table", "/stations.csv", "#b8922a"],
    ["JSON", "/gauges.json", "#b8922a"],
    ["Drawing", "/data/station-map.svg", "#c05fb0"],
    ["Web page", "/tide-chart.html", "#8a8a86"],
    ["Zip", "/survey-2026.zip", "#8a6fd1"],
  ];
  const previewsView = $("#previews-view");
  let previews;
  const kindBox = $("#kinds");
  const pressKind = (path) => $$("button", kindBox).forEach((k) => k.setAttribute("aria-pressed", String(k.dataset.path === path)));
  for (const [label, path, color] of kinds) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.path = path;
    b.style.setProperty("--c", color);
    b.className =
      "inline-flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-ink-2 hover:text-ink aria-pressed:text-ink aria-pressed:underline aria-pressed:decoration-spot aria-pressed:decoration-2 aria-pressed:underline-offset-6";
    b.innerHTML = `<i class="size-[9px] rounded-[50%] bg-(--c)"></i>${label}`;
    b.addEventListener("click", () => {
      pressKind(path);
      if (previews) void previews.drive.go(path);
      else previewsView.dataset.start = path;
    });
    kindBox.append(b);
  }
  pressKind(previewsView.dataset.start);
  lazy(previewsView, () => (previews = mountIn(previewsView, previewsView.dataset.start, { pathEl: $('[data-path-for="previews"]') })));

  // 04: themes. okfs reads ?theme= when its page starts, so each choice starts it again.
  const themesView = $("#themes-view");
  const themeList = $("#theme-list");
  const blurbs = {
    default: "Warm greys and one orange.",
    "tokyo-night": "Neon at night, crisp blue by day.",
    catppuccin: "Pastel Latte and Mocha.",
    "rose-pine": "Soft rose and pine.",
    gruvbox: "Retro, warm, high contrast.",
    kanagawa: "Ink, gold and indigo.",
    everforest: "Calm greens.",
    nord: "Arctic blue-greys.",
    solarized: "The classic, one blue accent.",
    one: "One Light and One Dark.",
    flexoki: "Inky, paper-warm.",
  };
  let themeId = "tokyo-night";
  let themeScheme = scheme();
  const themeInfos = await backend.answer("/").then((r) => JSON.parse(r.body.match(/>(.*)</s)[1]).themes);
  const showTheme = () => {
    $$("button", themeList).forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.id === themeId)));
    $$("[data-scheme]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scheme === themeScheme)));
    // The folder with field-notes.md under the cursor, rendered: the list, the icons and the prose all take the theme.
    const shown = mountIn(themesView, `/?theme=${themeId}&scheme=${themeScheme}`, { pathEl: $('[data-path-for="themes"]') });
    void shown.handle.whenReady().then(async () => {
      const d = shown.drive;
      await sleep(250);
      d.key("Home");
      for (let i = 0; i < 11; i++) d.key("j");
      await sleep(450);
      d.key("r");
    });
  };
  for (const t of themeInfos) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.id = t.id;
    // Rows of five, then of three, and on a phone a list with the swatches beside the name. Every cell rules
    // its right and bottom edge; the list's frame clips the ones that fall on its own edge.
    b.className =
      "group grid h-full w-full cursor-pointer gap-1.5 border-0 border-r border-b border-r-rule border-b-rule bg-transparent px-4 pt-4 pb-4.5 text-left aria-pressed:shadow-[inset_0_3px_0_var(--spot)] under-760:grid-cols-[auto_minmax(0,1fr)] under-760:items-center under-760:gap-x-3.5";
    const [bg, fg, accent] = t.dark;
    const [lbg, , laccent] = t.light;
    const dot = "size-3.5 rounded-[50%] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ink)_18%,transparent)]";
    b.innerHTML = `<span class="flex gap-0.75 text-[14px] text-ink-2 under-760:[grid-row:span_2]" aria-hidden="true">${[lbg, bg, fg, accent, laccent].map((c) => `<i class="${dot}" style="background:${c}"></i>`).join("")}</span><b class="font-sans text-[20px] leading-[1.1] font-[700] font-stretch-[112%] group-hover:text-spot">${esc(t.name)}</b><span class="text-[14px] text-ink-2">${blurbs[t.id] ?? ""}</span>`;
    b.addEventListener("click", () => {
      themeId = t.id;
      showTheme();
    });
    li.append(b);
    themeList.append(li);
  }
  for (const b of $$("[data-scheme]")) {
    b.addEventListener("click", () => {
      themeScheme = b.dataset.scheme;
      showTheme();
    });
  }
  lazy(themesView, showTheme);

  // 05: the folder, followed.
  const liveView = $("#live-view");
  let live;
  const today = new Date();
  const monthDir = `notes/${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}`;
  liveView.dataset.start = `/${monthDir}/`;
  $('[data-path-for="live"]').textContent = `/${monthDir}/`;
  lazy(liveView, () => (live = mountIn(liveView, liveView.dataset.start, { pathEl: $('[data-path-for="live"]') })));
  let written = 0;
  $("#write").addEventListener("click", async () => {
    written += 1;
    const stamp = new Date();
    const name = `visitor-${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}${String(stamp.getSeconds()).padStart(2, "0")}.md`;
    const t0 = performance.now();
    await backend.write(monthDir, name, `# A note from a visitor\n\nWritten at ${stamp.toISOString()} from the okfs demo page.\n`);
    const ms = performance.now() - t0;
    $("#wrote").innerHTML = `Wrote <code>${name}</code>. The index read the folder again in ${ms.toFixed(1)} ms and told the open page. A search for <code>visitor</code> finds ${written === 1 ? "it" : `all ${written}`}.`;
    if (live && live.path() !== `/${monthDir}/`) void live.drive.go(`/${monthDir}/`);
  });
}

main().catch((error) => {
  console.error(error);
  $("#boot-text").textContent = "okfs could not start in this browser.";
  $("#boot-sub").textContent = "It needs WebAssembly and DecompressionStream.";
  $(".say").classList.add("err");
});
