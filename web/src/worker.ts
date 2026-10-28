// The index's own thread: okfs's first walk of the whole tree, then every search and recent list.
import { startEngine } from "./engine";
import { makeTree } from "./tree";

type Engine = Awaited<ReturnType<typeof startEngine>>;
interface Message {
  op: string;
  id?: number;
  arg?: any;
}

let engine: Engine | null = null;
const waiting: Message[] = [];

self.onmessage = async ({ data }: MessageEvent) => {
  if (data.op === "start") {
    const root = makeTree(data.now);
    let seen = 0;
    let last = 0;
    engine = await startEngine(data.module, root, {
      onRead: (_dir: unknown, n: number) => {
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

function answer({ op, id, arg }: Message) {
  const text = op === "search" ? engine!.search(arg) : op === "recent" ? engine!.recent(arg) : op === "write" ? engine!.write(arg) : "null";
  self.postMessage({ id, text });
}
