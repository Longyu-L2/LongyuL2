/**
 * Pure helpers for the bridge page (tested under Node): configuration checks, amounts, the
 * withdrawal list kept in the browser, status labels and the on-chain wiring check.
 *
 * Contract facts below were read from BNB Chain's opbnb v0.5.6 contracts-bedrock, the version
 * LONGYU is deployed from (chain/testnet/deploy-rollup.sh): OptimismPortal 2.8.1-beta.1 (legacy,
 * L2OutputOracle based), L1StandardBridge 2.2.0, L2StandardBridge 1.10.0, OptimismMintableERC20 1.3.0.
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

export const L1_CHAIN_ID = 97;
export const L2_CHAIN_ID = 668801;
export const DECIMALS = 18;
export const DEFAULT_L1_RPC = "https://bsc-testnet-rpc.publicnode.com";
export const L1_EXPLORER = "https://testnet.bscscan.com";

/** L2 predeploys (opbnb src/libraries/Predeploys.sol). */
export const L2_STANDARD_BRIDGE: Address = "0x4200000000000000000000000000000000000010";
export const L2_CROSS_DOMAIN_MESSENGER: Address = "0x4200000000000000000000000000000000000007";
export const L2_TO_L1_MESSAGE_PASSER: Address = "0x4200000000000000000000000000000000000016";
/** The L2 bridge's stand-in token address for the native asset (BNB on LONGYU). */
export const LEGACY_ERC20_ETH: Address = "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000";

/** Gas the receiving bridge is guaranteed on the other chain, for deposits and withdrawals. */
export const MIN_GAS_LIMIT = 200_000;

export const STORAGE_KEY = "longyu.bridge.withdrawals.v1";
export const MAX_TRACKED = 20;

// ------------------------------------------------------------------ ABIs (only what the page calls)

export const portalAbi = parseAbi([
  "function version() view returns (string)",
  "function l2Oracle() view returns (address)",
  "function paused() view returns (bool)",
  "event WithdrawalFinalized(bytes32 indexed withdrawalHash, bool success)",
]);
export const outputOracleAbi = parseAbi([
  "function FINALIZATION_PERIOD_SECONDS() view returns (uint256)",
  "function SUBMISSION_INTERVAL() view returns (uint256)",
  "function L2_FOURIER_MILLISECONDS_BLOCK_TIME() view returns (uint256)",
  "function latestOutputIndex() view returns (uint256)",
  "function nextBlockNumber() view returns (uint256)",
  "function getL2Output(uint256 _l2OutputIndex) view returns ((bytes32 outputRoot, uint128 timestamp, uint128 l2BlockNumber))",
]);
export const l1BridgeAbi = parseAbi([
  "function messenger() view returns (address)",
  "function depositERC20To(address _l1Token, address _l2Token, address _to, uint256 _amount, uint32 _minGasLimit, bytes _extraData)",
]);
export const l2BridgeAbi = parseAbi([
  "function otherBridge() view returns (address)",
  "function withdrawTo(address _l2Token, address _to, uint256 _amount, uint32 _minGasLimit, bytes _extraData) payable",
]);
export const messengerAbi = parseAbi([
  "function portal() view returns (address)",
  "function otherMessenger() view returns (address)",
  "function relayMessage(uint256 _nonce, address _sender, address _target, uint256 _value, uint256 _minGasLimit, bytes _message) payable",
  "event RelayedMessage(bytes32 indexed msgHash)",
  "event FailedRelayedMessage(bytes32 indexed msgHash)",
]);
export const mintableAbi = parseAbi([
  "function remoteToken() view returns (address)",
  "function bridge() view returns (address)",
  "function decimals() view returns (uint8)",
]);
export const finalizeBridgeAbi = parseAbi([
  "function finalizeBridgeETH(address _from, address _to, uint256 _amount, bytes _extraData) payable",
  "function finalizeBridgeERC20(address _localToken, address _remoteToken, address _from, address _to, uint256 _amount, bytes _extraData)",
]);

// ------------------------------------------------------------------ configuration

/** Build-time values (build.mjs); empty strings when unset. */
export interface RawConfig {
  l1Portal?: string | null;
  l1OutputOracle?: string | null;
  l1StandardBridge?: string | null;
  l1Token?: string | null;
  l2Token?: string | null;
  l2RpcUrl?: string | null;
  l1RpcUrl?: string | null;
  explorerUrl?: string | null;
}

export interface BridgeConfig {
  l1Portal: Address;
  l1OutputOracle: Address;
  l1StandardBridge: Address;
  l1Token: Address;
  l2Token: Address;
  l2RpcUrl: string;
  l1RpcUrl: string;
  /** LONGYU explorer base URL without a trailing slash; null when not configured. */
  explorerUrl: string | null;
}

export type ConfigResult = { ok: true; config: BridgeConfig } | { ok: false; problems: string[] };

const ADDRESS_ENV = {
  l1Portal: "L1_PORTAL",
  l1OutputOracle: "L1_OUTPUT_ORACLE",
  l1StandardBridge: "L1_STANDARD_BRIDGE",
  l1Token: "L1_TOKEN",
  l2Token: "L2_TOKEN",
} as const;

/** A checksummed address, or null for anything malformed, wrongly checksummed or zero. */
export function parseAddress(value: string | null | undefined): Address | null {
  const v = (value ?? "").trim();
  if (!isAddress(v, { strict: true }) || /^0x0{40}$/i.test(v)) return null;
  return getAddress(v);
}

/** An https URL (http only for localhost, as the page's CSP allows), without credentials. */
export function parseUrl(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.username || u.password || u.hash) return null;
  if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost")) return null;
  return v;
}

/** Checks every build-time value. Addresses are never guessed: a missing or bad one closes the bridge. */
export function parseConfig(raw: RawConfig | null | undefined): ConfigResult {
  const r = raw ?? {};
  const problems: string[] = [];
  const addresses = {} as Record<keyof typeof ADDRESS_ENV, Address>;
  for (const [key, env] of Object.entries(ADDRESS_ENV) as [keyof typeof ADDRESS_ENV, string][]) {
    const value = (r[key] ?? "").trim();
    const parsed = parseAddress(value);
    if (!value) problems.push(`${env} is missing`);
    else if (!parsed) problems.push(`${env} is not a valid address`);
    else addresses[key] = parsed;
  }
  const seen = new Set(Object.values(addresses).map((a) => a.toLowerCase()));
  if (seen.size !== Object.keys(addresses).length) problems.push("two of the addresses are the same");

  const l2RpcUrl = parseUrl(r.l2RpcUrl);
  if (!(r.l2RpcUrl ?? "").trim()) problems.push("L2_RPC_URL is missing");
  else if (!l2RpcUrl) problems.push("L2_RPC_URL is not an https URL");
  const l1RpcUrl = parseUrl((r.l1RpcUrl ?? "").trim() || DEFAULT_L1_RPC);
  if (!l1RpcUrl) problems.push("L1_RPC_URL is not an https URL");
  let explorerUrl: string | null = null;
  if ((r.explorerUrl ?? "").trim()) {
    explorerUrl = parseUrl(r.explorerUrl)?.replace(/\/+$/, "") ?? null;
    if (!explorerUrl) problems.push("EXPLORER_URL is not an https URL");
  }
  if (problems.length || !l2RpcUrl || !l1RpcUrl) return { ok: false, problems };
  return { ok: true, config: { ...addresses, l2RpcUrl, l1RpcUrl, explorerUrl } };
}

// ------------------------------------------------------------------ amounts

/**
 * Exact base units from a decimal string: digits with an optional point and at most `decimals`
 * fraction digits. Null for empty, negative, signed, scientific, hex, comma or over-precise input.
 */
export function parseAmount(input: string, decimals = DECIMALS): bigint | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(input.trim());
  if (!m) return null;
  const whole = m[1] ?? "";
  const frac = m[2] ?? "";
  if (!whole && !frac) return null;
  if (frac.length > decimals || whole.length > 60) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** The exact decimal form of base units, trailing zeros removed. */
export function formatAmount(units: bigint, decimals = DECIMALS): string {
  const negative = units < 0n;
  const v = negative ? -units : units;
  const one = 10n ** BigInt(decimals);
  const frac = decimals ? (v % one).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${v / one}${frac ? `.${frac}` : ""}`;
}

const RESERVE_GAS = 500_000n;
const RESERVE_FLOOR = 50_000_000_000_000n;

/**
 * What stays in the wallet when a share of tBNB is picked, since tBNB also pays for gas: enough at
 * this gas price for an approval and the transaction after it, and never under 0.00005.
 */
export function gasReserve(gasPrice: bigint): bigint {
  const need = gasPrice > 0n ? gasPrice * RESERVE_GAS : 0n;
  return need > RESERVE_FLOOR ? need : RESERVE_FLOOR;
}

/**
 * The amount a share button fills in: `percent` (1 to 100) of the balance, and never more than is
 * left after `reserve`. A share under the whole is cut to six decimals so the field stays readable.
 */
export function shareAmount(balance: bigint, percent: number, reserve = 0n, decimals = DECIMALS): bigint {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new RangeError("percent must be 1 to 100");
  const spendable = balance > reserve ? balance - reserve : 0n;
  const share = (balance * BigInt(percent)) / 100n;
  const amount = share < spendable ? share : spendable;
  if (percent === 100 || decimals <= 6) return amount;
  const cut = amount - (amount % 10n ** BigInt(decimals - 6));
  return cut > 0n ? cut : amount;
}

// ------------------------------------------------------------------ tracked withdrawals

export function parseTxHash(input: string): Hex | null {
  const v = input.trim();
  return /^0x[0-9a-fA-F]{64}$/.test(v) ? (v.toLowerCase() as Hex) : null;
}

/** The stored list: valid hashes only, newest first, no repeats, at most MAX_TRACKED. */
export function loadTracked(raw: string | null | undefined): Hex[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: Hex[] = [];
  for (const item of value) {
    const hash = typeof item === "string" ? parseTxHash(item) : null;
    if (hash && !out.includes(hash)) out.push(hash);
    if (out.length === MAX_TRACKED) break;
  }
  return out;
}

/**
 * Puts a hash first. Over the limit, the oldest finalized withdrawal goes before any open one,
 * so a withdrawal still waiting to be proven or finalized is not dropped while a done one remains.
 */
export function addTracked(list: readonly Hex[], hash: string, done: ReadonlySet<string> = new Set()): Hex[] {
  const h = parseTxHash(hash);
  if (!h) return [...list];
  const next = [h, ...list.filter((x) => x !== h)];
  while (next.length > MAX_TRACKED) {
    let drop = -1;
    for (let i = next.length - 1; i > 0; i--) if (done.has(next[i]!)) { drop = i; break; }
    next.splice(drop > 0 ? drop : next.length - 1, 1);
  }
  return next;
}

export function removeTracked(list: readonly Hex[], hash: string): Hex[] {
  return list.filter((x) => x !== hash.toLowerCase());
}

// ------------------------------------------------------------------ withdrawal status

export type Tone = "wait" | "ready" | "done" | "bad";
export interface StatusView {
  label: string;
  action: "prove" | "finalize" | null;
  tone: Tone;
}

const VIEWS: Record<string, StatusView> = {
  // viem's getWithdrawalStatus results
  "waiting-to-prove": { label: "Waiting to prove", action: null, tone: "wait" },
  "ready-to-prove": { label: "Ready to prove", action: "prove", tone: "ready" },
  "waiting-to-finalize": { label: "Waiting to finalize", action: null, tone: "wait" },
  "ready-to-finalize": { label: "Ready to finalize", action: "finalize", tone: "ready" },
  finalized: { label: "Finalized", action: null, tone: "done" },
  // the page's own states for a pasted or fresh hash
  pending: { label: "Not on LONGYU yet", action: null, tone: "wait" },
  reverted: { label: "Failed on LONGYU", action: null, tone: "bad" },
  "not-withdrawal": { label: "Not a withdrawal", action: null, tone: "bad" },
  error: { label: "Status unavailable", action: null, tone: "bad" },
};

/** Label and next action for a status. While the portal is paused, nothing can be proven or finalized. */
export function statusView(status: string, opts: { paused?: boolean } = {}): StatusView {
  const view = VIEWS[status] ?? { label: "Unknown", action: null, tone: "bad" };
  if (opts.paused && view.action) return { label: "Paused on BSC", action: null, tone: "wait" };
  return view;
}

/** "45 min", "5 h 12 min", "6 d 23 h": rounded up, so the time shown is never short. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 min";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) {
    const m = minutes % 60;
    return m ? `${Math.floor(minutes / 60)} h ${m} min` : `${minutes / 60} h`;
  }
  const hours = Math.ceil(minutes / 60);
  const h = hours % 24;
  return h ? `${Math.floor(hours / 24)} d ${h} h` : `${hours / 24} d`;
}

/** How long after an output's block exists the proposer's transaction lands on BSC (measured: 87 to 120 s). */
export const PROPOSER_DELAY_SECONDS = 120;

/**
 * Seconds until the output that covers a withdrawal is on BSC: the first proposed block at or after
 * the withdrawal's block, counted from LONGYU's newest block at LONGYU's block time, plus the
 * proposer's delay. viem's getTimeToProve is not used: it reads the oracle's L2_BLOCK_TIME, which is
 * whole seconds (1) on this chain, four times the real 250 ms.
 */
export function secondsToProve(a: { withdrawalBlock: bigint; nextOutputBlock: bigint; submissionInterval: bigint; head: bigint; blockTimeMs: bigint }): number {
  let target = a.nextOutputBlock;
  if (target < a.withdrawalBlock && a.submissionInterval > 0n) {
    const behind = a.withdrawalBlock - target;
    target += ((behind + a.submissionInterval - 1n) / a.submissionInterval) * a.submissionInterval;
  }
  const blocksLeft = target > a.head ? target - a.head : 0n;
  return Number((blocksLeft * a.blockTimeMs + 999n) / 1000n) + PROPOSER_DELAY_SECONDS;
}

export interface WithdrawalMessage {
  sender: Hex;
  target: Hex;
  value: bigint;
  data: Hex;
}

/**
 * What a withdrawal carries, read from its message: a standard-bridge withdrawal is
 * relayMessage(..., L2StandardBridge -> L1StandardBridge, finalizeBridgeETH | finalizeBridgeERC20(...)).
 * For display only; null fields when the message is something else.
 */
export function describeWithdrawal(w: WithdrawalMessage, cfg: Pick<BridgeConfig, "l1StandardBridge" | "l1Token" | "l2Token">) {
  const none = { asset: null, amount: null, to: null } as const;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (w.data === "0x") return w.value > 0n ? { asset: "tBNB" as const, amount: w.value, to: getAddress(w.target) } : none;
  if (!same(w.sender, L2_CROSS_DOMAIN_MESSENGER)) return none;
  try {
    const relay = decodeFunctionData({ abi: messengerAbi, data: w.data });
    if (relay.functionName !== "relayMessage") return none;
    const [, sender, target, , , message] = relay.args;
    if (!same(sender, L2_STANDARD_BRIDGE) || !same(target, cfg.l1StandardBridge)) return none;
    const inner = decodeFunctionData({ abi: finalizeBridgeAbi, data: message });
    if (inner.functionName === "finalizeBridgeETH") return { asset: "tBNB" as const, amount: inner.args[2], to: inner.args[1] };
    const [localToken, remoteToken, , to, amount] = inner.args;
    if (same(localToken, cfg.l1Token) && same(remoteToken, cfg.l2Token)) return { asset: "tLONG" as const, amount, to };
  } catch {
    // not a standard-bridge message
  }
  return none;
}

/** keccak256(abi.encode(version, stateRoot, messagePasserStorageRoot, latestBlockhash)), as Hashing.hashOutputRootProof. */
export function outputRootOf(p: { version: Hex; stateRoot: Hex; messagePasserStorageRoot: Hex; latestBlockhash: Hex }): Hex {
  const b32 = { type: "bytes32" } as const;
  return keccak256(encodeAbiParameters([b32, b32, b32, b32], [p.version, p.stateRoot, p.messagePasserStorageRoot, p.latestBlockhash]));
}

// ------------------------------------------------------------------ on-chain wiring check

/** Values read from both chains before any transaction, to catch a wrong or swapped address. */
export interface Observed {
  l1ChainId: number;
  l2ChainId: number;
  /** OptimismPortal.version() */
  portalVersion: string;
  /** OptimismPortal.l2Oracle() */
  portalOracle: string;
  /** L1StandardBridge.messenger(): LONGYU's L1CrossDomainMessenger */
  bridgeMessenger: string;
  /** L1CrossDomainMessenger.portal() */
  messengerPortal: string;
  /** L2StandardBridge.otherBridge() */
  l2OtherBridge: string;
  /** L2CrossDomainMessenger.otherMessenger() */
  l2OtherMessenger: string;
  /** L2 tLONG remoteToken() and bridge() */
  l2TokenRemote: string;
  l2TokenBridge: string;
  l1TokenDecimals: number;
  l2TokenDecimals: number;
}

/** Major version of a semver string such as "2.8.1-beta.1"; NaN when malformed. */
export function portalMajor(version: string): number {
  const m = /^(\d+)\./.exec(version);
  return m ? Number(m[1]) : Number.NaN;
}

/** Everything that does not line up; empty when the configured contracts are LONGYU's. */
export function wiringProblems(o: Observed, cfg: BridgeConfig): string[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const p: string[] = [];
  if (o.l1ChainId !== L1_CHAIN_ID) p.push(`L1_RPC_URL serves chain ${o.l1ChainId}, not ${L1_CHAIN_ID}`);
  if (o.l2ChainId !== L2_CHAIN_ID) p.push(`L2_RPC_URL serves chain ${o.l2ChainId}, not ${L2_CHAIN_ID}`);
  // viem treats portals below v3 as L2OutputOracle portals; v3 and later use dispute games.
  const major = portalMajor(o.portalVersion);
  if (!(major >= 1 && major < 3)) p.push(`portal version ${o.portalVersion} is not an L2OutputOracle portal`);
  if (!same(o.portalOracle, cfg.l1OutputOracle)) p.push("L1_OUTPUT_ORACLE is not the portal's output oracle");
  if (!same(o.messengerPortal, cfg.l1Portal)) p.push("L1_PORTAL is not the portal of the bridge's messenger");
  if (!same(o.l2OtherBridge, cfg.l1StandardBridge)) p.push("L1_STANDARD_BRIDGE is not LONGYU's L1 bridge");
  if (!same(o.l2OtherMessenger, o.bridgeMessenger)) p.push("the L1 bridge's messenger is not LONGYU's");
  if (!same(o.l2TokenRemote, cfg.l1Token)) p.push("L2_TOKEN is not the LONGYU copy of L1_TOKEN");
  if (!same(o.l2TokenBridge, L2_STANDARD_BRIDGE)) p.push("L2_TOKEN is not minted by the L2 standard bridge");
  if (o.l1TokenDecimals !== DECIMALS || o.l2TokenDecimals !== DECIMALS) p.push("tLONG must have 18 decimals on both chains");
  return p;
}

// ------------------------------------------------------------------ wallet and links

// Shared with the claim page, which does not carry the bridge's code.
export { CANCELLED, errorMessage, isUnknownChain } from "./wallet-core.ts";

export function l1TxUrl(hash: string): string {
  return `${L1_EXPLORER}/tx/${hash}`;
}

export function l2TxUrl(explorerUrl: string | null, hash: string): string | null {
  return explorerUrl ? `${explorerUrl}/tx/${hash}` : null;
}

export function shortHex(h: string): string {
  return h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}

/** EIP-3085 parameters for LONGYU testnet. */
export function longyuChainParams(cfg: Pick<BridgeConfig, "l2RpcUrl" | "explorerUrl">) {
  return {
    chainId: `0x${L2_CHAIN_ID.toString(16)}`,
    chainName: "LONGYU Testnet",
    nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: DECIMALS },
    rpcUrls: [cfg.l2RpcUrl],
    ...(cfg.explorerUrl ? { blockExplorerUrls: [cfg.explorerUrl] } : {}),
  };
}
