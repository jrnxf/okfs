// The index's own thread: okfs's first walk of the whole tree, then every search and recent list.
import { startEngine } from "./engine.js";
import { makeTree } from "./tree.js";

let engine = null;
const waiting = [];

self.onmessage = async ({ data }) => {
  if (data.op === "start") {
    const root = makeTree(data.now);
    let seen = 0;
    let last = 0;
    engine = await startEngine(data.module, root, {
      onRead: (_dir, n) => {
        seen += n;
        const t = performance.now();
        if (t - last > 40) {
          last = t;
          self.postMessage({ op: "progress", seen });
        }
      },
    });
    const began = performance.now();
    engine.build();
    self.postMessage({ op: "ready", len: engine.len(), seen, ms: performance.now() - began });
    for (const message of waiting.splice(0)) answer(message);
    return;
  }
  if (!engine) waiting.push(data);
  else answer(data);
};

function answer({ op, id, arg }) {
  const text = op === "search" ? engine.search(arg) : op === "recent" ? engine.recent(arg) : op === "write" ? engine.write(arg) : "null";
  self.postMessage({ id, text });
}
