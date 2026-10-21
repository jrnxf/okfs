// The landing page around okfs: the hero frame and its self-driving tour, the sections that drive okfs
// or ask its engine directly, the A/B directions and the scheme.
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

// ---------- the page's own controls ----------

function setDir(dir) {
  html.dataset.dir = dir;
  store.set("dir", dir);
  for (const b of $$("[data-set-dir]")) b.setAttribute("aria-pressed", String(b.dataset.setDir === dir));
}
for (const b of $$("[data-set-dir]")) b.addEventListener("click", () => setDir(b.dataset.setDir));
setDir(html.dataset.dir);

const schemeListeners = new Set();
$("#theme").addEventListener("click", () => {
  const next = scheme() === "dark" ? "light" : "dark";
  html.dataset.theme = next;
  store.set("theme", next);
  $('meta[name="theme-color"]').setAttribute("content", next === "dark" ? "#060607" : "#f7f6f4");
  schemeListeners.forEach((fn) => fn(next));
});

const nav = $("#nav");
addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 8), { passive: true });

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

// ---------- driving okfs from outside its frame ----------

/** Presses, holds and types into okfs's page in a frame, the way a person would, by messages to it. */
function driver(handle, { onKey } = {}) {
  const shown = (key, ctrl) => onKey?.(ctrl ? `⌃${key.toUpperCase()}` : key);
  return {
    key(key, opts = {}) {
      shown(key, opts.ctrl);
      return handle.call("key", key, opts);
    },
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

// ---------- start ----------

async function main() {
  const bootText = $("#boot-text");
  bootText.textContent = "Unpacking okfs's engine";
  const demo = await boot();
  window.__demo = demo;
  const { backend } = demo;

  $("#st-wasm").textContent = `${(demo.stats.wasmBytes / 1e6).toFixed(1)} MB`;
  $("#term-version").textContent = demo.stats.version;
  const frames = new Map();

  /** Mounts okfs in a container, opening at `start` with the page's scheme. A second mount replaces the first. */
  function mountIn(container, start, { pathEl, title, onKey, onTouch } = {}) {
    const old = frames.get(container);
    const sep = start.includes("?") ? "&" : "?";
    const at = start.includes("scheme=") ? start : `${start}${sep}scheme=${scheme()}`;
    let path = prettyPath(at);
    const handle = demo.mount(container, {
      start: at,
      title: title ?? "okfs, running in this page",
      on: {
        nav: (m) => {
          path = prettyPath(typeof m === "string" ? m : m.url);
          if (pathEl) pathEl.textContent = path;
        },
        key: (m) => !m.repeat && onKey?.(m.key),
        touch: () => onTouch?.(),
        toast: (m) => toast(m.text),
      },
    });
    void handle.whenReady().then(() => {
      requestAnimationFrame(() => handle.frame.classList.add("on"));
      if (old) setTimeout(() => old.handle.remove(), 400);
    });
    if (pathEl) pathEl.textContent = path;
    const entry = { handle, drive: driver(handle, { onKey: container.onKey }), path: () => path };
    frames.set(container, entry);
    return entry;
  }

  // Each frame follows the page's scheme: okfs's own `t` flips it.
  schemeListeners.add((next) => {
    for (const { drive } of frames.values()) void drive.scheme(next);
  });

  // ---- the hero ----
  let touched = false;
  function stopTour() {
    touched = true;
    $("#driving")?.classList.remove("on");
  }
  const heroView = $("#hero-view");
  const heroPath = $("#hero-path");
  const hero = mountIn(heroView, "/", { pathEl: heroPath, title: "okfs serving the demo folder tidewater", onTouch: () => stopTour(), onKey: () => stopTour() });
  void hero.handle.whenReady().then(() => setTimeout(() => $("#hero-boot").classList.add("gone"), 250));

  // The numbers under the window.
  let counted = 0;
  backend.onStatus((s) => {
    const n = s.ready ? s.indexed : s.seen;
    counted = n;
    $("#st-count").textContent = fmt(n);
    if (!s.ready) bootText.textContent = `Walking the folder: ${fmt(s.seen)} entries`;
    if (s.ready) {
      $("#st-walk").innerHTML = `${(s.walkMs / 1000).toFixed(2)} s`;
      $("#f-count").textContent = fmt(s.indexed);
      $("#term-count").textContent = fmt(s.indexed);
    }
  });
  const searchStat = (found, q) => {
    $("#st-search").innerHTML = `<em>${found.took.toFixed(1)}</em> ms`;
    $("#st-search-q").textContent = `"${q.length > 18 ? `${q.slice(0, 17)}...` : q}", ${fmt(found.total)} matches`;
  };
  // Every search okfs's page makes is a search in the engine: show its time.
  const answer = backend.answer;
  backend.answer = async (url) => {
    const out = await answer(url);
    if (url.startsWith("/api/search") && out.status === 200) {
      try {
        const q = new URL(url, "http://okfs.demo").searchParams.get("q") ?? "";
        if (q.trim()) searchStat(JSON.parse(out.body), q);
      } catch {}
    }
    return out;
  };

  // ---- the hero drives itself until someone takes over ----
  const driving = $("#driving");
  const drivingKey = $("#driving-key");
  let heroVisible = true;
  new IntersectionObserver(([e]) => (heroVisible = e.intersectionRatio > 0.3), { threshold: [0, 0.3, 0.6, 1] }).observe(heroView);
  // The pill says the tour is driving: never for what a visitor started.
  const showKey = (k) => {
    if (touched) return;
    drivingKey.textContent = k;
    driving.classList.add("on");
  };
  const heroDrive = driver(hero.handle, { onKey: showKey });

  async function step(fn, wait) {
    while (!heroVisible && !touched) await sleep(300);
    if (touched) throw new Error("stopped");
    fn();
    await sleep(wait);
    if (touched) throw new Error("stopped");
  }
  async function tour() {
    // Not with reduced motion, and not on a touch screen: the palette's input would bring up the keyboard.
    const touch = matchMedia("(pointer: coarse)").matches || innerWidth < 760;
    if (reduced || touch || new URLSearchParams(location.search).get("tour") === "0") return;
    await hero.handle.whenReady();
    await sleep(1600);
    const d = heroDrive;
    try {
      for (;;) {
        await d.go("/");
        await sleep(900);
        d.key("Home");
        await sleep(500);
        for (let i = 0; i < 6; i++) await step(() => d.key("j"), 330);
        await step(() => d.key("l"), 900);
        await step(() => d.key("j"), 900);
        await step(() => showKey("j held"), 0);
        await d.hold("j", 1300, 60);
        if (touched) throw new Error("stopped");
        await step(() => {}, 1800);
        await step(() => d.key("k", { ctrl: true }), 600);
        showKey("tide");
        await d.type("tide", 120);
        if (touched) throw new Error("stopped");
        await step(() => {}, 1700);
        showKey(".rs");
        await d.type(" rs", 140);
        if (touched) throw new Error("stopped");
        await step(() => {}, 1500);
        await step(() => d.key("Enter"), 2200);
        await step(() => d.key("Escape"), 700);
        await step(() => d.key("k", { ctrl: true }), 500);
        showKey("north pier");
        await d.type("north pier 2024", 80);
        if (touched) throw new Error("stopped");
        await step(() => {}, 900);
        await step(() => d.key("Enter", { ctrl: true }), 2600);
        await step(() => d.key("j"), 350);
        await step(() => d.key("j"), 350);
        await step(() => d.key("j"), 1500);
        await step(() => d.key("Escape"), 900);
        await step(() => d.go("/harbor/"), 1100);
        await step(() => d.key("."), 1800);
        await step(() => d.key("."), 900);
        driving.classList.remove("on");
        await step(() => {}, 1200);
      }
    } catch {
      driving.classList.remove("on");
    }
  }
  void tour();

  // ---- chips: each one a thing to try in the hero ----
  const chips = [
    ["j", "Hold j through the photos", async (d) => {
      await d.go("/photos/");
      await sleep(700);
      d.key("Home");
      await sleep(250);
      d.key("j");
      await sleep(500);
      await d.hold("j", 1400, 60);
    }],
    ["⌘K", "Find anything", async (d) => {
      await d.closeAll();
      await d.palette();
      await sleep(350);
      await d.type("tide", 110);
    }],
    ["⏎", "Every match in the list", (d) => d.go("/?find=readme")],
    [".", "Show hidden: node_modules", async (d) => {
      await d.go("/harbor/");
      await sleep(700);
      d.key(".");
    }],
    ["▶", "Play the timelapse", (d) => d.go("/harbor-timelapse.webm")],
    ["⎙", "Open the PDF", (d) => d.go("/annual-survey-2025.pdf")],
    ["r", "Markdown, rendered", async (d) => {
      await d.go("/field-notes.md");
      await sleep(600);
      d.key("r");
    }],
    ["?", "All the keys", (d) => d.key("?")],
  ];
  const chipBox = $("#chips");
  for (const [k, label, run] of chips) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.innerHTML = `<kbd>${k}</kbd>${label}`;
    b.addEventListener("click", async () => {
      stopTour();
      b.classList.add("running");
      try {
        await heroDrive.closeAll();
        await run(heroDrive);
      } finally {
        setTimeout(() => b.classList.remove("running"), 600);
      }
    });
    chipBox.append(b);
  }

  // ---- 01: the search box, straight to the engine ----
  const find = $("#find");
  const hits = $("#hits");
  const times = [];
  const bars = $("#bars");
  for (let i = 0; i < 40; i++) bars.append(document.createElement("i"));
  const drawBars = () => {
    const max = Math.max(40, ...times);
    $$("i", bars).forEach((bar, i) => {
      const t = times[times.length - 40 + i];
      bar.style.height = t === undefined ? "2px" : `${Math.max(3, (t / max) * 56)}px`;
    });
  };
  drawBars();
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const marked = (text, idx, offset) => {
    const at = new Set(idx.map((i) => i - offset));
    return [...text].map((c, i) => (at.has(i) ? `<mark>${esc(c)}</mark>` : esc(c))).join("");
  };
  let asked = 0;
  async function search(q) {
    const id = ++asked;
    if (!q.trim()) {
      hits.innerHTML = `<li class="empty">Type a few letters of any name, or pick one on the left.</li>`;
      $("#find-ms").textContent = "-";
      $("#find-total").textContent = "0";
      return;
    }
    const found = await backend.search({ q, limit: 9 });
    if (id !== asked) return;
    times.push(found.took);
    drawBars();
    $("#find-ms").textContent = found.took.toFixed(1);
    $("#f-ms").textContent = `${found.took.toFixed(0)} ms`;
    $("#find-total").textContent = fmt(found.total);
    searchStat(found, q);
    hits.innerHTML = found.hits.length
      ? found.hits
          .map((h) => {
            const slash = h.path.lastIndexOf("/");
            const name = h.path.slice(slash + 1);
            const dir = slash < 0 ? "/" : h.path.slice(0, slash);
            const shown = h.name ? marked(name, h.idx, 0) : marked(name, h.idx, slash + 1);
            return `<li data-path="${esc(h.path)}" data-dir="${h.dir ? 1 : 0}"><svg class="glyph"><use href="#i-${h.dir ? "folder" : "file"}"/></svg><span class="name">${shown}</span><span class="dir">${esc(dir)}</span></li>`;
          })
          .join("")
      : `<li class="empty">Nothing matches. okfs looked through all ${fmt(found.indexed)} names.</li>`;
  }
  find.addEventListener("input", () => void search(find.value));
  hits.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-path]");
    if (!li) return;
    stopTour();
    void heroDrive.go(`/${li.dataset.path.split("/").map(encodeURIComponent).join("/")}${li.dataset.dir === "1" ? "/" : ""}`);
    $("#hero-window").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
  });
  for (const q of ["tide", "img_0042", "north pier 2024", "button.tsx", "readme", "survey pdf", "kelp flac"]) {
    const b = document.createElement("button");
    b.type = "button";
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

  // 02: keys, with each key shown as it is pressed.
  const keysView = $("#keys-view");
  const hud = $("#hud");
  const showHud = (k) => {
    const label = { ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→", Enter: "⏎", Escape: "esc", " ": "space", Backspace: "⌫" }[k] ?? k;
    const el = document.createElement("kbd");
    el.textContent = label;
    hud.append(el);
    while (hud.children.length > 5) hud.firstChild.remove();
    setTimeout(() => el.remove(), 900);
  };
  keysView.onKey = showHud;
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
    ["PDF", "/annual-survey-2025.pdf", "#6b6b68"],
    ["Markdown", "/field-notes.md", "#6b6b68"],
    ["Code", "/src/tide.rs", "#3f9b6c"],
    ["Table", "/stations.csv", "#b8922a"],
    ["JSON", "/gauges.json", "#b8922a"],
    ["Drawing", "/data/station-map.svg", "#c05fb0"],
    ["Web page", "/tide-chart.html", "#6b6b68"],
    ["Zip", "/survey-2026.zip", "#8a6fd1"],
  ];
  const previewsView = $("#previews-view");
  let previews;
  const kindBox = $("#kinds");
  const pressKind = (path) => $$(".kind", kindBox).forEach((k) => k.setAttribute("aria-pressed", String(k.dataset.path === path)));
  for (const [label, path, color] of kinds) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kind";
    b.dataset.path = path;
    b.style.setProperty("--c", color);
    b.innerHTML = `<i></i>${label}`;
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
    default: "The contract's own values.",
    paper: "Warm, bookish, serif.",
    terminal: "Monospace, square, tight.",
    fjord: "Cool and roomy.",
    riso: "Two-ink print. Loud.",
  };
  let themeId = "paper";
  let themeScheme = scheme();
  const themeInfos = await backend.answer("/").then((r) => JSON.parse(r.body.match(/>(.*)</s)[1]).themes);
  const showTheme = () => {
    $$(".theme", themeList).forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.id === themeId)));
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
    const b = document.createElement("button");
    b.type = "button";
    b.className = "theme";
    b.dataset.id = t.id;
    const [bg, fg, accent] = t.dark;
    const [lbg, lfg, laccent] = t.light;
    b.innerHTML = `<span class="sw"><i style="background:${lbg}"></i><i style="background:${bg}"></i><i style="background:${fg}"></i><i style="background:${accent}"></i><i style="background:${laccent}"></i></span><b>${t.name}</b><span>${blurbs[t.id] ?? ""}</span>`;
    b.addEventListener("click", () => {
      themeId = t.id;
      showTheme();
    });
    themeList.append(b);
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
    $("#wrote").innerHTML = `Wrote <code>${name}</code>. The index read the folder again in ${ms.toFixed(1)} ms and told the open page; search for <code>visitor</code> finds ${written === 1 ? "it" : `all ${written}`}.`;
    if (live && live.path() !== `/${monthDir}/`) void live.drive.go(`/${monthDir}/`);
  });
}

main().catch((error) => {
  console.error(error);
  const text = $("#boot-text");
  if (text) text.textContent = "okfs could not start in this browser.";
});
