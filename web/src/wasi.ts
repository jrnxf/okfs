// A WASI preview 1 host for okfs's engine: the sixteen calls it imports, over a folder held in memory.
// The folder is a tree of Dir and File nodes (see tree.js). A Dir fills itself the first time it is read.
/* eslint-disable no-bitwise */
import type { Dir, Node } from "./tree";

const E = { SUCCESS: 0, BADF: 8, INVAL: 28, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, ROFS: 69 };
const T = { CHAR: 2, DIR: 3, FILE: 4 };
const ALL_RIGHTS = 0xffffffffffffffffn;

/** A node of the served folder, as the host sees it (see tree.ts). */
export type WasiNode = Node;
export interface WasiOptions {
  log?: (line: string) => void;
  onRead?: (dir: Node, count: number) => void;
}

export function wasiHost(rootDir: Dir, { log = () => {}, onRead }: WasiOptions = {}) {
  let memory!: WebAssembly.Memory;
  let view!: DataView;
  let bytes!: Uint8Array;
  const fresh = () => {
    if (!view || view.buffer !== memory.buffer) {
      view = new DataView(memory.buffer);
      bytes = new Uint8Array(memory.buffer);
    }
  };
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const str = (ptr: number, len: number) => dec.decode(bytes.subarray(ptr, ptr + len));
  // fd 3 is the preopen "/", which holds the served folder.
  const fds = new Map<number, { node: Node; pos: number }>([[3, { node: rootDir, pos: 0 }]]);
  let nextFd = 4;
  let ino = 1;
  const inoOf = (node: Node & { ino?: number }) => (node.ino ||= ++ino);
  let out = "";

  function lookup(from: Node, path: string): Node | null {
    let node: Node | null | undefined = from;
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue;
      if (!node.isDir) return null;
      node = node.child(part);
      if (!node) return null;
    }
    return node;
  }

  function filestat(ptr: number, node: Node) {
    view.setBigUint64(ptr, 1n, true);
    view.setBigUint64(ptr + 8, BigInt(inoOf(node)), true);
    view.setUint8(ptr + 16, node.isDir ? T.DIR : T.FILE);
    view.setBigUint64(ptr + 24, 1n, true);
    view.setBigUint64(ptr + 32, BigInt(node.isDir ? 4096 : node.size), true);
    const ns = BigInt(node.mtime) * 1000000000n;
    view.setBigUint64(ptr + 40, ns, true);
    view.setBigUint64(ptr + 48, ns, true);
    view.setBigUint64(ptr + 56, ns, true);
  }

  const imports: Record<string, (...args: any[]) => number> = {
    args_get: () => E.SUCCESS,
    args_sizes_get: (argc: number, size: number) => {
      fresh();
      view.setUint32(argc, 0, true);
      view.setUint32(size, 0, true);
      return E.SUCCESS;
    },
    environ_get: () => E.SUCCESS,
    environ_sizes_get: (count: number, size: number) => {
      fresh();
      view.setUint32(count, 0, true);
      view.setUint32(size, 0, true);
      return E.SUCCESS;
    },
    clock_time_get: (id: number, _precision: number, ptr: number) => {
      fresh();
      const ms = id === 0 ? Date.now() : performance.now();
      view.setBigUint64(ptr, BigInt(Math.round(ms * 1e6)), true);
      return E.SUCCESS;
    },
    random_get: (ptr: number, len: number) => {
      fresh();
      crypto.getRandomValues(bytes.subarray(ptr, ptr + len));
      return E.SUCCESS;
    },
    fd_write: (fd: number, iovs: number, count: number, written: number) => {
      fresh();
      let n = 0;
      for (let i = 0; i < count; i++) {
        const p = view.getUint32(iovs + i * 8, true);
        const l = view.getUint32(iovs + i * 8 + 4, true);
        if (fd === 1 || fd === 2) out += str(p, l);
        n += l;
      }
      view.setUint32(written, n, true);
      let nl: number;
      while ((nl = out.indexOf("\n")) >= 0) {
        log(out.slice(0, nl));
        out = out.slice(nl + 1);
      }
      return fd === 1 || fd === 2 ? E.SUCCESS : E.BADF;
    },
    fd_close: (fd: number) => (fds.delete(fd) ? E.SUCCESS : E.BADF),
    fd_fdstat_get: (fd: number, ptr: number) => {
      fresh();
      let type: number;
      if (fd <= 2) type = T.CHAR;
      else {
        const open = fds.get(fd);
        if (!open) return E.BADF;
        type = open.node.isDir ? T.DIR : T.FILE;
      }
      view.setUint8(ptr, type);
      view.setUint16(ptr + 2, 0, true);
      view.setBigUint64(ptr + 8, ALL_RIGHTS, true);
      view.setBigUint64(ptr + 16, ALL_RIGHTS, true);
      return E.SUCCESS;
    },
    fd_filestat_get: (fd: number, ptr: number) => {
      fresh();
      const open = fds.get(fd);
      if (!open) return E.BADF;
      filestat(ptr, open.node);
      return E.SUCCESS;
    },
    fd_prestat_get: (fd: number, ptr: number) => {
      fresh();
      if (fd !== 3) return E.BADF;
      view.setUint8(ptr, 0);
      view.setUint32(ptr + 4, 1, true);
      return E.SUCCESS;
    },
    fd_prestat_dir_name: (fd: number, ptr: number, len: number) => {
      fresh();
      if (fd !== 3) return E.BADF;
      if (len >= 1) bytes[ptr] = 47; // "/"
      return E.SUCCESS;
    },
    path_open: (dirfd: number, _dirflags: number, path: number, len: number, oflags: number, _rb: bigint, _ri: bigint, _fdflags: number, fdOut: number) => {
      fresh();
      const at = fds.get(dirfd);
      if (!at) return E.BADF;
      if (oflags & (1 | 8)) return E.ROFS; // CREAT, TRUNC
      const node = lookup(at.node, str(path, len));
      if (!node) return E.NOENT;
      if (oflags & 2 && !node.isDir) return E.NOTDIR; // DIRECTORY
      const fd = nextFd++;
      fds.set(fd, { node, pos: 0 });
      view.setUint32(fdOut, fd, true);
      return E.SUCCESS;
    },
    path_filestat_get: (dirfd: number, _flags: number, path: number, len: number, ptr: number) => {
      fresh();
      const at = fds.get(dirfd);
      if (!at) return E.BADF;
      const node = lookup(at.node, str(path, len));
      if (!node) return E.NOENT;
      filestat(ptr, node);
      return E.SUCCESS;
    },
    path_readlink: () => E.INVAL,
    fd_read: (fd: number, iovs: number, count: number, readOut: number) => {
      fresh();
      const open = fds.get(fd);
      if (!open) return E.BADF;
      if (open.node.isDir) return E.ISDIR;
      const data = open.node.bytes();
      let n = 0;
      for (let i = 0; i < count; i++) {
        const p = view.getUint32(iovs + i * 8, true);
        const l = view.getUint32(iovs + i * 8 + 4, true);
        const chunk = data.subarray(open.pos, open.pos + l);
        bytes.set(chunk, p);
        open.pos += chunk.length;
        n += chunk.length;
        if (chunk.length < l) break;
      }
      view.setUint32(readOut, n, true);
      return E.SUCCESS;
    },
    fd_readdir: (fd: number, buf: number, bufLen: number, cookie: bigint, usedOut: number) => {
      fresh();
      const open = fds.get(fd);
      if (!open) return E.BADF;
      if (!open.node.isDir) return E.NOTDIR;
      const kids = open.node.list();
      onRead?.(open.node, kids.length);
      const end = buf + bufLen;
      let off = buf;
      const head = new DataView(new ArrayBuffer(24));
      const headBytes = new Uint8Array(head.buffer);
      for (let i = Number(cookie); i < kids.length; i++) {
        const kid = kids[i]!;
        const name = enc.encode(kid.name);
        head.setBigUint64(0, BigInt(i + 1), true);
        head.setBigUint64(8, BigInt(inoOf(kid)), true);
        head.setUint32(16, name.length, true);
        head.setUint8(20, kid.isDir ? T.DIR : T.FILE);
        const room = end - off;
        if (room < 24 + name.length) {
          bytes.set(headBytes.subarray(0, Math.min(24, room)), off);
          if (room > 24) bytes.set(name.subarray(0, room - 24), off + 24);
          view.setUint32(usedOut, bufLen, true);
          return E.SUCCESS;
        }
        bytes.set(headBytes, off);
        bytes.set(name, off + 24);
        off += 24 + name.length;
      }
      view.setUint32(usedOut, off - buf, true);
      return E.SUCCESS;
    },
    proc_exit: (code: number) => {
      throw new Error(`okfs engine exited with ${code}`);
    },
  };
  const wrapped: Record<string, (...args: any[]) => number> = {};
  for (const [name, fn] of Object.entries(imports)) wrapped[name] = fn;
  return {
    imports: { wasi_snapshot_preview1: wrapped },
    bind(instance: WebAssembly.Instance) {
      memory = instance.exports.memory as WebAssembly.Memory;
      fresh();
    },
  };
}
