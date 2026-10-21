// The engine: okfs's index compiled to WebAssembly, over the demo tree. JSON in, JSON out.
import { File } from "./tree.js";
import { wasiHost } from "./wasi.js";

export async function startEngine(module, root, { log, onRead } = {}) {
  const host = wasiHost(root, { log, onRead });
  const instance = await WebAssembly.instantiate(module, host.imports);
  host.bind(instance);
  const x = instance.exports;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const call = (fn, text) => {
    const data = enc.encode(text);
    const ptr = x.okfs_alloc(data.length);
    new Uint8Array(x.memory.buffer, ptr, data.length).set(data);
    const out = fn(ptr, data.length);
    x.okfs_free(ptr, data.length);
    return out;
  };
  const read = (ptr) => dec.decode(new Uint8Array(x.memory.buffer, ptr, x.okfs_reply_len()));
  const json = (ptr) => JSON.parse(read(ptr));
  if (call(x.okfs_open, "/tidewater") !== 0) throw new Error("the engine could not open the folder");
  return {
    build: () => x.okfs_build(),
    len: () => x.okfs_len(),
    /** The JSON text, as the server sends it. */
    search: (query) => read(call(x.okfs_search, JSON.stringify(query))),
    recent: (all) => read(x.okfs_recent(all ? 1 : 0)),
    list: (query) => json(call(x.okfs_list, JSON.stringify(query))),
    reread: (dir) => json(call(x.okfs_reread, dir)),
    /** Writes a file into the tree and has the index read its folder again. Returns what the feed told, as JSON text. */
    write: ({ dir, name, size, mtime }) => {
      let at = root.child("tidewater");
      for (const part of dir.split("/").filter(Boolean)) at = at?.child(part);
      if (!at?.isDir) return "[]";
      at.remove(name);
      at.add(new File(name, size, mtime));
      at.mtime = mtime;
      return read(call(x.okfs_reread, dir));
    },
  };
}
