// Writes src/verify/compilers.json: every Solidity release LONGYU Scan can verify with, each pinned to
// the SHA-256 of its official build. Run after a new compiler release and commit the result:
//   node scripts/compilers.mjs
// The explorer refuses any compiler that is not in that file or whose download has another hash.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LIST = "https://binaries.soliditylang.org/wasm/list.json";
/** The first release whose build takes the standard JSON input the explorer sends. */
const OLDEST = [0, 5, 0];

const res = await fetch(LIST, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) throw new Error(`${LIST} answered ${res.status}`);
const list = await res.json();
const byPath = new Map(list.builds.map((b) => [b.path, b]));

const parts = (v) => v.split(".").map(Number);
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
};

const out = [];
for (const [version, path] of Object.entries(list.releases)) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`unexpected version ${version}`);
  const [a, b, c] = parts(version);
  if (a < OLDEST[0] || (a === OLDEST[0] && (b < OLDEST[1] || (b === OLDEST[1] && c < OLDEST[2])))) continue;
  const build = byPath.get(path);
  if (!build) throw new Error(`no build for ${path}`);
  if (!/^soljson-v\d+\.\d+\.\d+\+commit\.[0-9a-f]{8}\.js$/.test(path)) throw new Error(`unexpected file name ${path}`);
  if (!/^0x[0-9a-f]{64}$/.test(build.sha256)) throw new Error(`unexpected hash for ${path}`);
  if (build.version !== version || build.longVersion !== path.slice("soljson-v".length, -".js".length)) throw new Error(`${path} does not agree with its entry`);
  out.push({ version, long: build.longVersion, path, sha256: build.sha256.slice(2) });
}
out.sort((x, y) => newer(x.version, y.version));

const file = fileURLToPath(new URL("../src/verify/compilers.json", import.meta.url));
writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${out.length} compilers, ${out[out.length - 1].version} to ${out[0].version}`);
