/** The watchtower's views of the chains, over viem. Every read on LONGYU comes from its own node. */
import { concat, createPublicClient, createWalletClient, defineChain, fallback, http, keccak256, parseAbi, parseAbiItem, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.ts";
import type { OracleView, VerifierView } from "./challenger.ts";
import type { DistributorView, RootData } from "./mining.ts";

const oracleAbi = parseAbi([
  "function nextOutputIndex() view returns (uint256)",
  "function getL2Output(uint256) view returns ((bytes32 outputRoot, uint128 timestamp, uint128 l2BlockNumber))",
  "function finalizationPeriodSeconds() view returns (uint256)",
  "function challenger() view returns (address)",
  "function deleteL2Outputs(uint256)",
]);

const distributorAbi = parseAbi([
  "function activeRoot() view returns ((bytes32 root, uint64 day, uint64 postedAt, uint256 totalEntitled, bytes32 dataHash))",
  "function pendingRoot() view returns ((bytes32 root, uint64 day, uint64 postedAt, uint256 totalEntitled, bytes32 dataHash))",
  "function pendingClaimableAt() view returns (uint256)",
  "function paused() view returns (bool)",
  "function maxRewardPerDay() view returns (uint256)",
  "function claimed(address) view returns (uint256)",
  "function hasRole(bytes32, address) view returns (bool)",
  "function vetoPendingRoot()",
  "function pause()",
]);
const rootProposed = parseAbiItem("event RootProposed(uint64 indexed day, bytes32 root, uint256 totalEntitled, bytes32 dataHash, string dataURI, uint256 claimableAt)");
const GUARDIAN_ROLE = keccak256(toBytes("GUARDIAN_ROLE"));

/** A veto or a pause needs under 100,000 gas; so does deleting state roots. */
const ACTION_GAS = 200_000n;
/** RootProposed is searched for back this far, in steps (about 29 days of 250 ms blocks). */
const LOG_LOOKBACK = 10_000_000n;
const LOG_STEP = 50_000n;

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error || body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? `HTTP ${res.status}`}`);
  return body.result;
}

export function verifierView(nodeUrl: string): VerifierView & { chainIds(): Promise<{ l1: number; l2: number }> } {
  return {
    async safeHead() {
      const s = await rpc<{ safe_l2: { number: number } }>(nodeUrl, "optimism_syncStatus", []);
      return BigInt(s.safe_l2.number);
    },
    async outputAt(block) {
      const o = await rpc<{ outputRoot: Hex }>(nodeUrl, "optimism_outputAtBlock", [`0x${block.toString(16)}`]);
      return o.outputRoot;
    },
    async chainIds() {
      const c = await rpc<{ l1_chain_id: number; l2_chain_id: number }>(nodeUrl, "optimism_rollupConfig", []);
      return { l1: Number(c.l1_chain_id), l2: Number(c.l2_chain_id) };
    },
  };
}

const MESSAGE_PASSER = "0x4200000000000000000000000000000000000016";

/**
 * State roots rebuilt from a LONGYU RPC's own data (block header and the message passer's storage
 * root), as the phones do: the sequencer's data, so it catches a root that a stolen proposer key
 * posted, not a sequencer that lies. It stands in while this service's own node is behind.
 */
export function rpcRebuildView(rpcUrl: string): VerifierView {
  return {
    async safeHead() {
      const b = await rpc<{ number: Hex }>(rpcUrl, "eth_getBlockByNumber", ["latest", false]);
      return BigInt(b.number);
    },
    async outputAt(block) {
      const tag = `0x${block.toString(16)}`;
      const [b, proof] = await Promise.all([
        rpc<{ stateRoot: Hex; hash: Hex }>(rpcUrl, "eth_getBlockByNumber", [tag, false]),
        rpc<{ storageHash: Hex }>(rpcUrl, "eth_getProof", [MESSAGE_PASSER, [], tag]),
      ]);
      return keccak256(concat([`0x${"0".repeat(64)}`, b.stateRoot, proof.storageHash, b.hash]));
    },
  };
}

export function oracleView(config: Config): OracleView & { challenger(): Promise<Address> } {
  const transport = fallback(config.L1_RPC_URLS.map((u) => http(u, { timeout: 15_000 })));
  const chain = defineChain({ id: config.L1_CHAIN_ID, name: config.L1_CHAIN_ID === 56 ? "BSC" : "BSC Testnet", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: config.L1_RPC_URLS } } });
  const pub = createPublicClient({ chain, transport });
  const address = config.L1_OUTPUT_ORACLE;
  const view: OracleView & { challenger(): Promise<Address> } = {
    nextOutputIndex: () => pub.readContract({ address, abi: oracleAbi, functionName: "nextOutputIndex" }),
    async getL2Output(index) {
      const o = await pub.readContract({ address, abi: oracleAbi, functionName: "getL2Output", args: [index] });
      return { outputRoot: o.outputRoot, timestamp: BigInt(o.timestamp), l2BlockNumber: BigInt(o.l2BlockNumber) };
    },
    finalizationPeriodSeconds: () => pub.readContract({ address, abi: oracleAbi, functionName: "finalizationPeriodSeconds" }),
    challenger: () => pub.readContract({ address, abi: oracleAbi, functionName: "challenger" }),
  };
  if (config.CHALLENGER_KEY) {
    const account = privateKeyToAccount(config.CHALLENGER_KEY);
    const wallet = createWalletClient({ account, chain, transport });
    view.deleteL2Outputs = async (index) => {
      const fees = await pub.estimateFeesPerGas({ type: "legacy" }).catch(() => ({ gasPrice: config.CHALLENGER_MAX_FEE_PER_GAS_WEI }));
      const gasPrice = (fees.gasPrice ?? config.CHALLENGER_MAX_FEE_PER_GAS_WEI) * 2n;
      const hash = await wallet.writeContract({
        address, abi: oracleAbi, functionName: "deleteL2Outputs", args: [index], gas: ACTION_GAS, type: "legacy",
        gasPrice: gasPrice < config.CHALLENGER_MAX_FEE_PER_GAS_WEI ? gasPrice : config.CHALLENGER_MAX_FEE_PER_GAS_WEI,
      });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`deleteL2Outputs reverted in ${hash}`);
      return hash;
    };
  }
  return view;
}

const toRoot = (r: { root: Hex; day: bigint; postedAt: bigint; totalEntitled: bigint; dataHash: Hex }): RootData | null =>
  /^0x0{64}$/.test(r.root) ? null : { root: r.root, day: BigInt(r.day), postedAt: BigInt(r.postedAt), totalEntitled: r.totalEntitled, dataHash: r.dataHash };

export type DistributorReader = DistributorView & { guardianReady(): Promise<boolean | null>; readsFromFallback(): boolean };

export function distributorView(config: Config, address: Address): DistributorReader {
  const chain = defineChain({ id: config.L2_CHAIN_ID, name: "LONGYU", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [config.VERIFIER_GETH_URL] } } });
  // Reads come from this service's own node; only transactions go to the sequencer. While the node has
  // not yet reached the distributor's creation, reads come from FALLBACK_RPC_URL, and the health says so.
  const own = createPublicClient({ chain, transport: http(config.VERIFIER_GETH_URL, { timeout: 15_000 }) });
  const spare = config.FALLBACK_RPC_URL ? createPublicClient({ chain, transport: http(config.FALLBACK_RPC_URL, { timeout: 15_000 }) }) : null;
  let fromSpare = false;
  let decidedAt = 0;
  const client = async () => {
    if (spare && Date.now() - decidedAt > 60_000) {
      fromSpare = ((await own.getCode({ address }).catch(() => undefined)) ?? "0x") === "0x";
      decidedAt = Date.now();
    }
    return fromSpare && spare ? spare : own;
  };
  const send = createPublicClient({ chain, transport: http(config.L2_SEND_URL, { timeout: 15_000 }) });
  const account = config.GUARDIAN_KEY ? privateKeyToAccount(config.GUARDIAN_KEY) : null;
  const view: DistributorReader = {
    chainId: BigInt(config.L2_CHAIN_ID),
    address,
    active: async () => toRoot(await (await client()).readContract({ address, abi: distributorAbi, functionName: "activeRoot" })),
    pending: async () => toRoot(await (await client()).readContract({ address, abi: distributorAbi, functionName: "pendingRoot" })),
    claimableAt: async () => (await client()).readContract({ address, abi: distributorAbi, functionName: "pendingClaimableAt" }),
    paused: async () => (await client()).readContract({ address, abi: distributorAbi, functionName: "paused" }),
    maxRewardPerDay: async () => (await client()).readContract({ address, abi: distributorAbi, functionName: "maxRewardPerDay" }),
    claimed: async (account) => (await client()).readContract({ address, abi: distributorAbi, functionName: "claimed", args: [account] }),
    async dataUri(day, root) {
      const pub = await client();
      const head = await pub.getBlockNumber();
      for (let to = head; to >= 0n && head - to < LOG_LOOKBACK; to -= LOG_STEP) {
        const from = to >= LOG_STEP - 1n ? to - LOG_STEP + 1n : 0n;
        const logs = await pub.getLogs({ address, event: rootProposed, args: { day }, fromBlock: from, toBlock: to });
        const hit = logs.reverse().find((l) => l.args.root?.toLowerCase() === root.toLowerCase());
        if (hit) return hit.args.dataURI ?? null;
        if (from === 0n) break;
      }
      return null;
    },
    readsFromFallback: () => fromSpare,
    guardianReady: async () => (account ? (await client()).readContract({ address, abi: distributorAbi, functionName: "hasRole", args: [GUARDIAN_ROLE, account.address] }) : null),
  };
  if (account) {
    const wallet = createWalletClient({ account, chain, transport: http(config.L2_SEND_URL, { timeout: 15_000 }) });
    const act = async (functionName: "vetoPendingRoot" | "pause") => {
      const fees = await send.estimateFeesPerGas().catch(() => null);
      const cap = config.GUARDIAN_MAX_FEE_PER_GAS_WEI;
      const maxFeePerGas = fees?.maxFeePerGas && fees.maxFeePerGas * 2n < cap ? fees.maxFeePerGas * 2n : cap;
      const maxPriorityFeePerGas = fees?.maxPriorityFeePerGas && fees.maxPriorityFeePerGas < maxFeePerGas ? fees.maxPriorityFeePerGas : maxFeePerGas;
      const hash = await wallet.writeContract({ address, abi: distributorAbi, functionName, gas: ACTION_GAS, maxFeePerGas, maxPriorityFeePerGas });
      const receipt = await send.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
      return hash;
    };
    view.veto = () => act("vetoPendingRoot");
    view.pause = () => act("pause");
  }
  return view;
}

/** Reads a data file from an allowed origin only, without redirects and within a size limit. */
export function dataFetcher(origins: readonly string[], maxBytes: number): (url: string) => Promise<string> {
  const allowed = new Set(origins.map((o) => new URL(o).origin));
  return async (url) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error("not a URL");
    }
    if (!allowed.has(u.origin)) throw new Error(`${u.origin} is not an allowed origin`);
    const res = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`larger than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  };
}
