// Starts the built okfs on a folder and says where it listens.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "./fixture";

/** The binary under test: OKFS_BIN, or the release build beside this checkout. */
const BIN = process.env.OKFS_BIN ?? resolve(import.meta.dirname, "../../target/release/okfs");

export interface Served {
  /** Where the page is, with the key on it when okfs asked for one. */
  link: string;
  /** The address without a key. */
  origin: string;
  /** The folder served. */
  root: string;
  stop: () => void;
}

/** Runs okfs on a fresh fixture folder. `args` are okfs's own, such as `--key`. */
export async function serve(args: string[] = []): Promise<Served> {
  const home = mkdtempSync(join(tmpdir(), "okfs-e2e-"));
  const root = join(home, "files");
  mkdirSync(root);
  build(root);
  const child: ChildProcess = spawn(BIN, [root, "--port", "0", "--no-open", ...args], {
    // Thumbnails are cached under the home's cache folder: a run starts with none, as a visitor's first visit does.
    env: { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stop = () => {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  };
  const link = await new Promise<string>((done, fail) => {
    let seen = "";
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`okfs exited with ${code} before it listened:\n${seen}`)));
    child.stdout!.on("data", (data: Buffer) => {
      seen += data.toString();
      const found = /^ {2}at {7}(\S+)/m.exec(seen);
      if (found) done(found[1]!);
    });
    setTimeout(() => fail(new Error(`okfs did not listen in 20 s:\n${seen}`)), 20_000).unref();
  }).catch((error) => {
    stop();
    throw error;
  });
  const origin = new URL(link).origin;
  return { link, origin, root, stop };
}
