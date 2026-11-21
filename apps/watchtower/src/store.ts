/**
 * The watchtower's own records, as files in STATE_DIR (a volume): the mining roots it accepted, and
 * the state roots it found right. Each file is written whole and renamed into place.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import type { RootStore, Verified } from "./mining.ts";

const KEEP_ROOTS = 30;
const ROOT_FILE = /^day-(\d{1,20})-(0x[0-9a-f]{64})\.json$/;

function writeWhole(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export function fileRootStore(dir: string): RootStore {
  const roots = join(dir, "mining-roots");
  mkdirSync(roots, { recursive: true });
  const list = () =>
    readdirSync(roots)
      .map((f) => ROOT_FILE.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ file: m[0], day: BigInt(m[1]!), root: m[2] as Hex }))
      .sort((a, b) => (a.day === b.day ? 0 : a.day > b.day ? -1 : 1));
  const read = (file: string) => JSON.parse(readFileSync(join(roots, file), "utf8")) as Verified;
  return {
    get(root) {
      const hit = list().find((r) => r.root === root.toLowerCase());
      return hit ? read(hit.file) : null;
    },
    put(v) {
      writeWhole(join(roots, `day-${v.day}-${v.root.toLowerCase()}.json`), JSON.stringify(v));
      for (const old of list().slice(KEEP_ROOTS)) rmSync(join(roots, old.file), { force: true });
    },
    recent(n) {
      return list().slice(0, n).map((r) => read(r.file));
    },
  };
}

/** The state roots found right, as "index:root", kept across restarts so they are not asked again. */
export function fileCheckedSet(dir: string): { set: Set<string>; save(): void } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state-roots-checked.json");
  let initial: string[] = [];
  try {
    initial = JSON.parse(readFileSync(path, "utf8")) as string[];
  } catch {
    initial = [];
  }
  const set = new Set(initial.filter((k) => /^\d{1,20}:0x[0-9a-f]{64}$/.test(k)));
  return { set, save: () => writeWhole(path, JSON.stringify([...set])) };
}
