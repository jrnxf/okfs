// Draws the demo folder's pictures off the page's thread: see pictures.js.
import { drawAll } from "./pictures";

self.onmessage = async () => {
  const out = await drawAll(
    (w: number, h: number) => new OffscreenCanvas(w, h),
    async (canvas: OffscreenCanvas, type: string, quality?: number) => new Uint8Array(await (await canvas.convertToBlob({ type, quality })).arrayBuffer()),
  );
  const buffers = [...Object.values(out.named), ...Object.values(out.pool).flat()].map((p) => p.bytes.buffer as ArrayBuffer);
  self.postMessage(out, buffers);
};
