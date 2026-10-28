// The engine: okfs's index compiled to WebAssembly, over the demo tree. JSON in, JSON out.
import { type Dir, File, type Node } from "./tree";
import { wasiHost, type WasiOptions } from "./wasi";

/** The engine's exports, as the host calls them. */
type Ptr = number;
interface EngineExports {
  memory: WebAssembly.Memory;
  okfs_alloc(len: number): Ptr;
  okfs_free(ptr: Ptr, len: number): void;
  okfs_reply_len(): number;
  okfs_open(ptr: Ptr, len: number): number;
  okfs_build(): number;
  okfs_len(): number;
  okfs_search(ptr: Ptr, len: number): Ptr;
  okfs_recent(all: number): Ptr;
  okfs_list(ptr: Ptr, len: number): Ptr;
  okfs_reread(ptr: Ptr, len: number): Ptr;
}

export async function startEngine(module: WebAssembly.Module, root: Dir, { log, onRead }: WasiOptions = {}) {
  const host = wasiHost(root, { log, onRead });
  const instance = await WebAssembly.instantiate(module, host.imports);
  host.bind(instance);
  const x = instance.exports as unknown as EngineExports;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const call = (fn: (ptr: Ptr, len: number) => number, text: string) => {
    const data = enc.encode(text);
    const ptr = x.okfs_alloc(data.length);
    new Uint8Array(x.memory.buffer, ptr, data.length).set(data);
    const out = fn(ptr, data.length);
    x.okfs_free(ptr, data.length);
    return out;
  };
  const read = (ptr: Ptr) => dec.decode(new Uint8Array(x.memory.buffer, ptr, x.okfs_reply_len()));
  const json = (ptr: Ptr) => JSON.parse(read(ptr));
  if (call(x.okfs_open, "/tidewater") !== 0) throw new Error("the engine could not open the folder");
  return {
    build: () => x.okfs_build(),
    len: () => x.okfs_len(),
    /** The JSON text, as the server sends it. */
    search: (query: unknown) => read(call(x.okfs_search, JSON.stringify(query))),
    recent: (all: unknown) => read(x.okfs_recent(all ? 1 : 0)),
    list: (query: unknown) => json(call(x.okfs_list, JSON.stringify(query))),
    reread: (dir: string) => json(call(x.okfs_reread, dir)),
    /** Writes a file into the tree and has the index read its folder again. Returns what the feed told, as JSON text. */
    write: ({ dir, name, size, mtime }: { dir: string; name: string; size: number; mtime: number }) => {
      let at: Node | null | undefined = root.child("tidewater");
      for (const part of dir.split("/").filter(Boolean)) at = (at as Dir | undefined)?.child(part);
      if (!at?.isDir) return "[]";
      at.remove(name);
      at.add(new File(name, size, mtime));
      at.mtime = mtime;
      return read(call(x.okfs_reread, dir));
    },
  };
}
