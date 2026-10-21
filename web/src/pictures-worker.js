// Draws the demo folder's pictures off the page's thread: see pictures.js.
import { drawAll } from "./pictures.js";

self.onmessage = async () => {
  const out = await drawAll(
    (w, h) => new OffscreenCanvas(w, h),
    async (canvas, type, quality) => new Uint8Array(await (await canvas.convertToBlob({ type, quality })).arrayBuffer()),
  );
  const buffers = [...Object.values(out.named), ...Object.values(out.pool).flat()].map((p) => p.bytes.buffer);
  self.postMessage(out, buffers);
};
