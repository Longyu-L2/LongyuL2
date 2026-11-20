/**
 * The Solidity compilers LONGYU Scan verifies with. compilers.json (written by scripts/compilers.mjs)
 * pins every release to the SHA-256 of its official build. A build is downloaded the first time
 * someone asks for it, kept on disk, and its hash is checked every time it is read: a file that is
 * not the pinned one is never run.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CompilerBuild {
  /** 0.8.28 */
  version: string;
  /** 0.8.28+commit.7893614a */
  long: string;
  /** The file's name on the compiler's download site; nothing else is ever asked for. */
  path: string;
  sha256: string;
}

/** Newest first. */
export const COMPILERS: readonly CompilerBuild[] = JSON.parse(readFileSync(new URL("./compilers.json", import.meta.url), "utf8"));
const BY_VERSION = new Map(COMPILERS.map((c) => [c.version, c]));

/** "v0.8.28+commit.7893614a", "0.8.28+commit.7893614a" or "0.8.28". A commit that is not the release's is refused. */
export function findCompiler(text: string): CompilerBuild | null {
  const m = /^v?(\d{1,2}\.\d{1,2}\.\d{1,3})(\+commit\.[0-9a-f]{8})?$/.exec(text.trim());
  if (!m) return null;
  const build = BY_VERSION.get(m[1]!);
  if (!build || (m[2] && `${m[1]}${m[2]}` !== build.long)) return null;
  return build;
}

const SOURCE = "https://binaries.soliditylang.org/wasm/";
/** No build is larger than this; a longer answer is not a compiler. */
const MAX_BYTES = 64 * 1024 * 1024;

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export type Download = (url: string) => Promise<Uint8Array>;

const download: Download = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`compiler download answered ${res.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("compiler download is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

export class CompilerStore {
  private readonly dir: string;
  private readonly loading = new Map<string, Promise<Buffer>>();

  constructor(dir = join(tmpdir(), "longyu-scan-compilers"), private readonly fetchBuild: Download = download) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  /** The build's bytes, checked against its pinned hash. Asked for twice at once, it is downloaded once. */
  load(build: CompilerBuild): Promise<Buffer> {
    const running = this.loading.get(build.version);
    if (running) return running;
    const work = this.read(build).finally(() => this.loading.delete(build.version));
    this.loading.set(build.version, work);
    return work;
  }

  private async read(build: CompilerBuild): Promise<Buffer> {
    // The name comes from the pinned list, never from a request.
    const file = join(this.dir, build.path);
    const kept = await readFile(file).catch(() => null);
    if (kept && sha256(kept) === build.sha256) return kept;
    if (kept) await rm(file, { force: true });
    const fresh = Buffer.from(await this.fetchBuild(`${SOURCE}${build.path}`));
    if (sha256(fresh) !== build.sha256) throw new Error(`compiler ${build.long} does not have its pinned hash`);
    // Written under another name and moved into place, so a half-written file is never read.
    const partial = `${file}.${randomBytes(6).toString("hex")}.part`;
    await writeFile(partial, fresh, { mode: 0o600 });
    await rename(partial, file).catch(async (e) => {
      await rm(partial, { force: true });
      throw e;
    });
    return fresh;
  }
}
