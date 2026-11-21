/**
 * The work the phone does for a mining session. No native imports, so the unit tests run it.
 * - The puzzle: a counter for which sha256("<nonce>:<counter>") starts with `bits` zero bits.
 * - The chain check: read a state root posted on BSC, rebuild it from LONGYU's own data and compare.
 *   A state root is keccak256(version 0, the block's state root, the storage root of the message
 *   passer at 0x4200…0016, the block hash). BSC is read directly, not through the LONGYU API.
 */
import { concat, decodeFunctionResult, encodeFunctionData, keccak256, numberToHex, parseAbi, sha256, stringToBytes, type Hex } from "viem";

interface ChainCheckDefaults {
  l2RpcUrl: string;
  l1RpcUrl: string;
  outputOracle: string;
}

/**
 * The addresses of the build's network: chain-check.production.json for the mainnet app, the testnet's
 * for the others. The comparison is written out here, not imported (see variant.ts), so a release bundle
 * holds one of the two files.
 */
const defaults: ChainCheckDefaults =
  process.env.EXPO_PUBLIC_APP_VARIANT === "production" ? require("../../chain-check.production.json") : require("../../chain-check.testnet.json");

export const chainCheck = {
  l2RpcUrl: process.env.EXPO_PUBLIC_L2_RPC_URL || defaults.l2RpcUrl,
  l1RpcUrl: process.env.EXPO_PUBLIC_L1_RPC_URL || defaults.l1RpcUrl,
  outputOracle: (process.env.EXPO_PUBLIC_L1_OUTPUT_ORACLE || defaults.outputOracle) as Hex,
};

const MESSAGE_PASSER = "0x4200000000000000000000000000000000000016";
const ZERO32: Hex = `0x${"00".repeat(32)}`;
const oracleAbi = parseAbi([
  "function latestOutputIndex() view returns (uint256)",
  "function getL2Output(uint256 index) view returns ((bytes32 outputRoot, uint128 timestamp, uint128 l2BlockNumber))",
]);

export interface RootParts {
  stateRoot: Hex;
  messagePasserRoot: Hex;
  blockHash: Hex;
}

export interface ChainCheck {
  index: bigint;
  l2Block: bigint;
  parts: RootParts;
  /** True when the rebuilt state root is the one posted on BSC. */
  match: boolean;
}

/** Leading zero bits of a hash. */
export function zeroBits(hash: Uint8Array): number {
  let n = 0;
  for (const byte of hash) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

/** Finds the puzzle's counter. Hands the thread back every few thousand tries, so the screen stays live. */
export async function solvePuzzle(nonce: string, bits: number, pause: () => Promise<void> = () => new Promise((r) => setTimeout(r, 0))): Promise<string> {
  for (let i = 0; ; i++) {
    if (zeroBits(sha256(stringToBytes(`${nonce}:${i}`), "bytes")) >= bits) return String(i);
    if (i % 2000 === 1999) await pause();
  }
}

export function outputRootOf(p: RootParts): Hex {
  return keccak256(concat([ZERO32, p.stateRoot, p.messagePasserRoot, p.blockHash]));
}

type Fetch = typeof fetch;

async function rpc<T>(url: string, method: string, params: unknown[], fetcher: Fetch): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error || body.result === undefined) throw new Error(body.error?.message ?? `${method} failed`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

async function oracleCall<F extends "latestOutputIndex" | "getL2Output">(functionName: F, args: readonly bigint[], fetcher: Fetch) {
  const data = encodeFunctionData({ abi: oracleAbi, functionName, args } as never);
  const result = await rpc<Hex>(chainCheck.l1RpcUrl, "eth_call", [{ to: chainCheck.outputOracle, data }, "latest"], fetcher);
  return decodeFunctionResult({ abi: oracleAbi, functionName, data: result } as never) as F extends "latestOutputIndex"
    ? bigint
    : { outputRoot: Hex; l2BlockNumber: bigint };
}

const isHash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

/** Rebuilds the state root posted at `index` (the newest when none is given) and compares it with BSC. */
export async function checkChain(index?: bigint, fetcher: Fetch = fetch): Promise<ChainCheck> {
  const at = index ?? (await oracleCall("latestOutputIndex", [], fetcher));
  const posted = await oracleCall("getL2Output", [at], fetcher);
  const block = numberToHex(posted.l2BlockNumber);
  const [header, proof] = await Promise.all([
    rpc<{ stateRoot?: unknown; hash?: unknown }>(chainCheck.l2RpcUrl, "eth_getBlockByNumber", [block, false], fetcher),
    rpc<{ storageHash?: unknown }>(chainCheck.l2RpcUrl, "eth_getProof", [MESSAGE_PASSER, [], block], fetcher),
  ]);
  if (!isHash(header.stateRoot) || !isHash(header.hash) || !isHash(proof.storageHash)) throw new Error("LONGYU returned an incomplete block");
  const parts = { stateRoot: header.stateRoot, messagePasserRoot: proof.storageHash, blockHash: header.hash };
  return { index: at, l2Block: posted.l2BlockNumber, parts, match: outputRootOf(parts).toLowerCase() === posted.outputRoot.toLowerCase() };
}
