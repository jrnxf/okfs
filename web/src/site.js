// The okfs site's front page: a catalogue page with okfs on the screen of a drawn computer, the numbers the
// page measures as okfs starts, the themes as finishes, and the install coupon. okfs is the real one: the
// same runtime as the demo, fed the demo's data from one file the build writes beside this page.
import { boot } from "./runtime.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const html = document.documentElement;
const fmt = (n) => n.toLocaleString("en-US");
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const scheme = () => (html.dataset.theme === "light" ? "light" : "dark");

// ---------- the scheme, and every okfs with it ----------

const schemeListeners = new Set();
function setScheme(next) {
  html.dataset.theme = next;
  try {
    localStorage.setItem("okfs-site.theme", next);
  } catch {
    // The choice lasts for this visit.
  }
  $('meta[name="theme-color"]').setAttribute("content", next === "dark" ? "#1a1815" : "#f3ecdc");
  schemeListeners.forEach((fn) => fn(next));
}
$("#theme").addEventListener("click", () => setScheme(scheme() === "dark" ? "light" : "dark"));

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

// ---------- okfs ----------

/** The demo's data, from the file the build names in the page: the same blocks the demo page carries inline. */
async function start() {
  const blocks = await (await fetch(html.dataset.okfsData)).json();
  for (const [id, { type, text }] of Object.entries(blocks)) {
    const el = document.createElement("script");
    el.type = type;
    el.id = id;
    el.textContent = text;
    document.head.append(el);
  }
  return boot();
}

function driver(handle) {
  return {
    key: (key, opts = {}) => handle.call("key", key, opts),
    go: (url) => handle.call("go", url),
    scheme: (value) => handle.call("scheme", value),
  };
}

const demo = start();
demo.catch((error) => {
  console.error(error);
  $("#boot").textContent = "okfs could not start in this browser. The demo link beside it may work.";
});

/** okfs's frames fade in once okfs is ready in them: see `mountIn`. */
const FADE = "border-0 opacity-0 transition-opacity duration-350 ease-[ease] [&.on]:opacity-100";

/** okfs in `container` at `start`, in the page's scheme. A second mount replaces the first once it is ready. */
async function mountIn(container, at, title, look) {
  const { mount } = await demo;
  const old = $("iframe.okfs-frame", container);
  const sep = at.includes("?") ? "&" : "?";
  const handle = mount(container, { start: `${at}${sep}scheme=${scheme()}`, title, class: `${look} ${FADE}` });
  const drive = driver(handle);
  const follow = (next) => void drive.scheme(next);
  schemeListeners.add(follow);
  void handle.whenReady().then(() => {
    requestAnimationFrame(() => handle.frame.classList.add("on"));
    if (old) setTimeout(() => old.remove(), 400);
  });
  return { handle, drive, follow };
}

// ---------- Fig. 1: okfs on the screen, drawn wide and scaled to fit the glass ----------

const screen = $("#screen");
function fit() {
  const w = screen.clientWidth;
  const portrait = screen.clientHeight > w;
  const fw = portrait ? 420 : 1000;
  const fh = portrait ? 560 : 750;
  screen.style.setProperty("--k", (w / fw).toFixed(4));
  screen.style.setProperty("--fw", `${fw}px`);
  screen.style.setProperty("--fh", `${fh}px`);
}
new ResizeObserver(fit).observe(screen);
fit();
// Drawn at --fw by --fh, and scaled by --k to the width of the glass.
const ON_SCREEN = "absolute top-0 left-0 h-[var(--fh,750px)] w-[var(--fw,1000px)] origin-top-left [transform:scale(var(--k,.6))]";
void mountIn($("#view"), "/photos/", "okfs serving the demo folder, on the screen", ON_SCREEN).then(({ handle }) =>
  handle.whenReady().then(() => $("#boot")?.remove()),
);

// ---------- Fig. 2: measured here ----------

demo.then(({ backend, stats }) => {
  $("#b-size").textContent = `${fmt(Math.round(stats.wasmBytes / 1024))} KB`;
  $("#b-unpack").textContent = `${stats.unpackMs.toFixed(0)} ms`;
  $("#b-compile").textContent = `${stats.compileMs.toFixed(0)} ms`;
  backend.onStatus((s) => {
    $("#b-count").textContent = fmt(s.ready ? s.indexed : s.seen);
    const boot = $("#boot-sub");
    if (!s.ready) {
      if (boot) boot.textContent = `reading the folder: ${fmt(s.seen)}`;
      return;
    }
    $("#b-walk").textContent = `${(s.walkMs / 1000).toFixed(2)} s`;
    $("#run").disabled = false;
  });
});
$("#run").addEventListener("click", async () => {
  const { backend } = await demo;
  const list = $("#runs");
  list.innerHTML = "";
  for (const q of ["img_0042", "north pier 2024", "survey pdf", "button.tsx", "kelp flac"]) {
    const r = await backend.search({ q, limit: 1 });
    const li = document.createElement("li");
    li.className =
      "grid grid-cols-[2.4em_1fr_auto] gap-2 border-b border-b-rule-faint py-1.5 before:text-ink-2 before:content-[counter(r)_'.'] before:[counter-increment:r]";
    li.innerHTML = `<span>"${esc(q)}", ${fmt(r.total)} matches</span><b class="font-[600] text-spot-ink">${r.took.toFixed(1)} ms</b>`;
    list.append(li);
    await sleep(reduced ? 0 : 160);
  }
});

// ---------- Fig. 3: the themes, as finishes ----------

const blurbs = { default: "The plain one.", paper: "Warm, set in a serif.", terminal: "Monospace and square.", fjord: "Cool and roomy.", riso: "Two-ink print." };
let themeId = "paper";
let plate = null;
function showTheme() {
  $$("#chips button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === themeId)));
  $("#theme-cap").textContent = `Plate: the ${themeId} finish, ${scheme()}.`;
  if (plate) schemeListeners.delete(plate.follow);
  // okfs reads ?theme= when its page starts, so each finish starts it again, with field-notes.md rendered.
  void mountIn($("#theme-view"), `/?theme=${themeId}`, `okfs in its ${themeId} theme`, "absolute inset-0 size-full").then((shown) => {
    plate = shown;
    // The plate starts in the page's scheme; it is started again when the scheme changes, so its caption holds.
    schemeListeners.delete(shown.follow);
    void shown.handle.whenReady().then(async () => {
      await sleep(250);
      shown.drive.key("Home");
      for (let i = 0; i < 11; i++) shown.drive.key("j");
      await sleep(450);
      shown.drive.key("r");
    });
  });
}
new IntersectionObserver(
  async ([e], obs) => {
    if (!e.isIntersecting) return;
    obs.disconnect();
    const { backend } = await demo;
    const themes = await backend.answer("/").then((r) => JSON.parse(r.body.match(/>(.*)</s)[1]).themes);
    for (const t of themes) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className =
        "grid w-full grid-cols-[70px_1fr] items-center gap-3 rounded-[3px] border border-rule-soft bg-transparent p-2 text-left [font:400_15px/1.25_var(--serif)] aria-pressed:border-spot aria-pressed:shadow-[inset_0_0_0_1px_var(--spot)]";
      b.dataset.id = t.id;
      const [bg, , accent] = t.dark;
      const [lbg, , laccent] = t.light;
      b.innerHTML = `<span class="flex h-[34px] overflow-hidden rounded-[2px] border border-[rgba(0,0,0,.2)] *:flex-1" aria-hidden="true"><i style="background:${lbg}"></i><i style="background:${laccent}"></i><i style="background:${bg}"></i><i style="background:${accent}"></i></span><span><b class="block font-[600]">${esc(t.name)}</b><small class="text-[13px] text-ink-2">${blurbs[t.id] ?? ""}</small></span>`;
      b.addEventListener("click", () => {
        themeId = t.id;
        showTheme();
      });
      li.append(b);
      $("#chips").append(li);
    }
    showTheme();
    schemeListeners.add(() => showTheme());
  },
  { rootMargin: "300px 0px" },
).observe($("#finishes"));

// ---------- the order coupon ----------

// Every way's commands are in the page, so a reader without scripts sees them too: a tick shows one.
function showWay(way) {
  for (const el of $$(".way")) el.hidden = el.dataset.way !== way;
}
for (const btn of $$(".way button")) {
  btn.addEventListener("click", async () => {
    btn.textContent = (await copy(btn.previousElementSibling.textContent)) ? "Copied" : "Select it";
    setTimeout(() => (btn.textContent = "Copy"), 1400);
  });
}
for (const r of $$('input[name="way"]')) r.addEventListener("change", () => showWay(r.value));
showWay($('input[name="way"]:checked').value);
