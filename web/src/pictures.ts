// The demo folder's pictures and its one sound, drawn in the visitor's browser from a seed: landscapes in the
// style of the tidewater photos, nautical chart tiles, scanned logbook pages, and a harbor bell. Nothing of them
// is stored: the same seed draws the same picture.
import { rng } from "./tree";

type RGB = [number, number, number];
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** One encoded picture. */
export interface Drawn {
  type: string;
  bytes: Uint8Array;
}

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const css = ([r, g, b]: RGB, a = 1) => `rgba(${r},${g},${b},${a})`;
const mix = (a: RGB, b: RGB, t: number) => a.map((v, i) => Math.round(v + (b[i]! - v) * t)) as RGB;

// sky top, sky at the horizon, sun, three ranges far to near, water at the top, water at the foot
const PALETTES: [string, string, string, string[], string, string][] = [
  ["#26365e", "#e58a6a", "#ffd9b0", ["#8a5a7c", "#5d3f68", "#3a2a4e"], "#e9a27a", "#3b2c52"],
  ["#1b2a4a", "#f3b27a", "#fff1c9", ["#9c6b6a", "#6b4a5e", "#3e2f45"], "#f0b88a", "#2c2742"],
  ["#0b1630", "#3a4f7a", "#e8eefc", ["#2e3d63", "#1f2c4c", "#131c33"], "#43588a", "#0a1226"],
  ["#9fb4c7", "#e3e8ec", "#ffffff", ["#b3c0cc", "#94a4b3", "#73879a"], "#d5dde4", "#7f93a6"],
  ["#3d7fc0", "#bfe3f5", "#fffbe8", ["#6d9bb8", "#4f7a96", "#2f5670"], "#8cc5e3", "#1f4f78"],
  ["#2b1b3d", "#ff7b54", "#ffe3a3", ["#a24a5c", "#6d2f4f", "#3a1a38"], "#ff9a6b", "#2a1636"],
  ["#14323a", "#7fb5a8", "#f2fbf2", ["#4f7f78", "#355f5b", "#1f3e3d"], "#9fcfbf", "#163634"],
  ["#3a2e5c", "#c9a4d8", "#fff3ff", ["#8e78ab", "#6a5888", "#463a63"], "#d8b8e6", "#3a2e5c"],
];

/** A landscape, 1200 by 800: sky, sun, three mountain ranges, and their light on the water. */
export function landscape(ctx: Ctx, seed: number, w = 1200, h = 800) {
  const r = rng(seed);
  const [skyTop, skyHor, sun, ranges, watTop, watBot] = PALETTES[seed % PALETTES.length]!.map((c) => (Array.isArray(c) ? c.map(hex) : hex(c))) as [RGB, RGB, RGB, RGB[], RGB, RGB];
  const horizon = Math.round(h * (0.62 + r() * 0.12));
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, css(skyTop));
  sky.addColorStop(1, css(skyHor));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, horizon);
  const water = ctx.createLinearGradient(0, horizon, 0, h);
  for (let i = 0; i <= 6; i++) water.addColorStop(i / 6, css(mix(watTop, watBot, (i / 6) ** 0.6)));
  ctx.fillStyle = water;
  ctx.fillRect(0, horizon, w, h - horizon);
  const sx = (0.2 + r() * 0.6) * w;
  const sy = horizon - (0.08 + r() * 0.24) * h;
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, h * 0.32);
  glow.addColorStop(0, css(sun, 0.85));
  glow.addColorStop(0.45, css(sun, 0.35));
  glow.addColorStop(1, css(sun, 0));
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, horizon);
  ctx.clip();
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, horizon);
  if (seed % PALETTES.length === 2) {
    for (let i = 0; i < 160; i++) {
      const b = 150 + Math.floor(r() * 105);
      ctx.fillStyle = `rgb(${b},${b},${b})`;
      ctx.fillRect(r() * w, r() * horizon * 0.7, 1.4, 1.4);
    }
  }
  ranges.forEach((color, i) => {
    const base = horizon - (ranges.length - i) * (40 + r() * 40) + 40;
    const amp = (30 + r() * 40) * (1 + 0.3 * (ranges.length - i));
    const jag = 30 + r() * 40;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    let x = 0;
    while (x <= w + 40) {
      const y = base + (r() * 2 - 1) * amp * (0.6 + 0.4 * Math.sin(x / (80 + r() * 120)));
      ctx.lineTo(x, Math.min(y, horizon - 1));
      x += jag * 0.4 + r() * jag * 0.6;
      if (r() < 0.25) {
        ctx.lineTo(x, Math.min(y - amp * (0.4 + r()), horizon - 1));
        x += 6 + r() * jag * 0.5;
      }
    }
    ctx.lineTo(w + 40, horizon);
    ctx.closePath();
    ctx.fillStyle = css(color);
    ctx.fill();
  });
  ctx.restore();
  for (let i = 0; i < 140; i++) {
    const y = horizon + 4 + r() * (h - horizon - 8);
    const near = (y - horizon) / (h - horizon);
    const cx = sx + (r() + r() + r() - 1.5) * (40 + near * 110);
    const len = (20 + r() * 70) * (0.4 + near * 1.6);
    ctx.fillStyle = css(mix(sun, watTop, 0.25 + near * 0.6));
    ctx.fillRect(cx - len / 2, y, len, Math.max(1, 1 + near * 3));
  }
  for (let i = 0; i < 120; i++) {
    const y = horizon + 4 + r() * (h - horizon - 8);
    const c = mix(mix(watTop, watBot, ((y - horizon) / (h - horizon)) * 0.6 + 0.1), [255, 255, 255], 0.12);
    ctx.fillStyle = css(c);
    ctx.fillRect(r() * w, y, 30 + r() * 130, 1);
  }
  if (seed % PALETTES.length === 3) {
    ctx.fillStyle = "rgba(235,240,244,0.28)";
    ctx.fillRect(0, 0, w, h);
  }
}

/** A tile of the harbor chart, 256 square: depth bands, perhaps a shore, the grid and soundings. */
export function tile(ctx: Ctx, seed: number, size = 256) {
  const r = rng(seed);
  const land = "rgb(241,234,214)";
  ctx.fillStyle = "rgb(200,224,238)";
  ctx.fillRect(0, 0, size, size);
  const blob = (cx: number, cy: number, rad: number, points: number) => {
    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
      const a = (i / points) * Math.PI * 2;
      const k = 0.7 + r() * 0.6;
      ctx[i ? "lineTo" : "moveTo"](cx + Math.cos(a) * rad * k, cy + Math.sin(a) * rad * k);
    }
    ctx.closePath();
  };
  ([["rgb(214,232,242)", 0], ["rgb(190,219,236)", 1], ["rgb(168,206,230)", 2]] as [string, number][]).forEach(([fill, depth]) => {
    for (let k = 0; k < 3; k++) {
      blob(r() * size, r() * size, 40 + r() * 100 - depth * 20, 18);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = "rgb(120,160,190)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  });
  let shore: [number, number] | null = null;
  if (r() < 0.6) {
    const side = Math.floor(r() * 3);
    shore = side === 0 ? [0, r() * size] : side === 1 ? [size, r() * size] : [r() * size, 0];
    blob(shore[0], shore[1], 60 + r() * 110, 26);
    ctx.fillStyle = land;
    ctx.fill();
    ctx.strokeStyle = "rgb(150,130,100)";
    ctx.stroke();
  }
  ctx.strokeStyle = "rgb(150,180,205)";
  for (let g = 0; g < size; g += 64) {
    ctx.beginPath();
    ctx.moveTo(g + 0.5, 0);
    ctx.lineTo(g + 0.5, size);
    ctx.moveTo(0, g + 0.5);
    ctx.lineTo(size, g + 0.5);
    ctx.stroke();
  }
  ctx.fillStyle = "rgb(60,90,120)";
  ctx.font = "10px sans-serif";
  for (let i = 0; i < 14; i++) {
    const x = 8 + r() * (size - 28);
    const y = 18 + r() * (size - 28);
    if (shore && Math.hypot(x - shore[0], y - shore[1]) < 70) continue;
    ctx.fillText(String(1 + Math.floor(r() * 18)), x, y);
  }
}

/** A page of the harbor master's tide logbook, 720 by 960, as a scanner sees it. */
export function scan(ctx: Ctx, seed: number, w = 720, h = 960) {
  const r = rng(seed);
  const paper = ctx.createRadialGradient(w / 2, h / 2, h * 0.1, w / 2, h / 2, h * 0.75);
  paper.addColorStop(0, "rgb(240,231,207)");
  paper.addColorStop(1, "rgb(214,200,168)");
  ctx.fillStyle = "rgb(90,80,70)";
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((r() - 0.5) * 0.025);
  ctx.translate(-w / 2, -h / 2);
  ctx.fillStyle = paper;
  ctx.fillRect(6, 6, w - 12, h - 12);
  const ink = "rgb(52,58,92)";
  const top = 112;
  const row = 29;
  const cols = [56, 160, 288, 416, 544, w - 56];
  ctx.strokeStyle = "rgb(170,150,120)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 28; i++) {
    ctx.beginPath();
    ctx.moveTo(56, top + i * row + 0.5);
    ctx.lineTo(w - 56, top + i * row + 0.5);
    ctx.stroke();
  }
  for (const x of cols) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, top);
    ctx.lineTo(x + 0.5, top + 27 * row);
    ctx.stroke();
  }
  ctx.fillStyle = ink;
  ctx.font = "italic 22px Georgia, serif";
  ctx.fillText(`Harbour tide log ${1961 + (seed % 28)}`, 56, 72);
  ctx.font = "italic 16px Georgia, serif";
  const sea = ["calm", "fresh", "swell", "fog", "rain", "SW 4", "NE 3"];
  for (let i = 1; i < 27; i++) {
    if (r() < 0.08) continue;
    const y = top + i * row + 20;
    const cells = [String(i).padStart(2, "0"), `${String(Math.floor(r() * 24)).padStart(2, "0")}:${Math.floor(r() * 6)}0`, (0.3 + r() * 3.4).toFixed(2), (0.3 + r() * 3.4).toFixed(2), sea[Math.floor(r() * sea.length)]!];
    cells.forEach((c, k) => ctx.fillText(c, cols[k]! + 12 + (r() - 0.5) * 5, y + (r() - 0.5) * 4));
  }
  ctx.restore();
}

/** The harbor bell: 4 s of 16-bit mono WAV at 22,050 Hz, struck once. */
export function bell() {
  const rate = 22050;
  const n = rate * 4;
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + n * 2, true);
  text(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, n * 2, true);
  // A bell's partials sit at these ratios to its hum note, each fading at its own pace.
  const partials: [number, number, number][] = [[0.5, 0.35, 1.1], [1, 1, 1.6], [1.183, 0.5, 2.2], [1.506, 0.45, 2.8], [2, 0.3, 3.6], [2.514, 0.2, 4.6], [3.011, 0.12, 6]];
  const base = 392;
  const r = rng(7);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    for (const [ratio, amp, decay] of partials) v += amp * Math.exp(-t * decay) * Math.sin(2 * Math.PI * base * ratio * t + ratio);
    v += t < 0.01 ? (r() * 2 - 1) * (1 - t / 0.01) * 0.6 : 0;
    const env = Math.min(1, t / 0.002);
    out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, (v * env) / 3)) * 32767, true);
  }
  return new Uint8Array(out.buffer);
}

/** The real tidewater set's pictures, by path, each with the seed that draws it. */
export const NAMED: [string, number][] = [
  ["harbor-at-dawn.jpg", 1000],
  ["ridge-line.jpg", 1004],
  ["photos/01-low-tide.jpg", 1009],
  ["photos/02-north-pier.jpg", 1001],
  ["photos/03-salt-marsh.jpg", 1006],
  ["photos/04-night-watch.jpg", 1002],
  ["photos/05-headland.jpg", 1013],
  ["photos/06-fog-bank.jpg", 1003],
  ["photos/07-east-channel.jpg", 1012],
  ["photos/08-last-light.jpg", 1005],
];

/**
 * Draws every picture with `canvas(w, h)` (an OffscreenCanvas, or a canvas element) and `encode(canvas, type,
 * quality)` to bytes. Returns { pool: { photo, tile, scan }, named: { path: bytes } }, each as { type, bytes }.
 */
export async function drawAll<C extends OffscreenCanvas | HTMLCanvasElement>(
  canvas: (w: number, h: number) => C,
  encode: (canvas: C, type: string, quality?: number) => Promise<Uint8Array>,
) {
  const draw = async (fn: (ctx: Ctx, seed: number, w: number, h: number) => void, seed: number, w: number, h: number, type: string, quality?: number): Promise<Drawn> => {
    const c = canvas(w, h);
    fn(c.getContext("2d") as Ctx, seed, w, h);
    return { type, bytes: await encode(c, type, quality) };
  };
  const pool: { photo: Drawn[]; tile: Drawn[]; scan: Drawn[] } = { photo: [], tile: [], scan: [] };
  const named: Record<string, Drawn> = {};
  for (const [path, seed] of NAMED) named[path] = await draw(landscape, seed, 1200, 800, "image/jpeg", 0.84);
  for (let i = 0; i < 24; i++) pool.photo.push(await draw(landscape, 1100 + i, 1200, 800, "image/jpeg", 0.82));
  for (let i = 0; i < 16; i++) pool.tile.push(await draw(tile, 2000 + i, 256, 256, "image/png"));
  for (let i = 0; i < 6; i++) pool.scan.push(await draw(scan, 3000 + i, 720, 960, "image/jpeg", 0.8));
  named["harbor-bell.wav"] = { type: "audio/wav", bytes: bell() };
  return { pool, named };
}
