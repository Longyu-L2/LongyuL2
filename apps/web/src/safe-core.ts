/**
 * Pure helpers for the Safe page (tested under Node): the link that carries a transaction between
 * signers, the Safe transaction hash, the approvals sent with an execution and the calls the page
 * can name.
 *
 * The page works with Safe v1.3.0 and with approvals made on the chain: each signer calls
 * approveHash, and the execution names the signers who approved. No signature is passed around and
 * nothing is stored off the chain. Every transaction is a plain call (operation 0) that pays no
 * refund: the remaining Safe transaction fields are always zero.
 */
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isAddress,
  isHex,
  parseAbi,
  size,
  toFunctionSelector,
  zeroAddress,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import { emissionScheduleAbi, faucetAbi, longTokenAbi, migrationDistributorAbi, miningDistributorAbi, miningVaultAbi, paymentRouterAbi } from "@longyu/abis";
import { DECIMALS, DEFAULT_L1_RPC, L1_CHAIN_ID, L2_CHAIN_ID, errorMessage, formatAmount, parseAddress, parseUrl } from "./bridge-core.ts";
import { PROFILE } from "./profile.ts";

export const SAFE_VERSION = "1.3.0";
/** Where a Safe keeps its guard: keccak256("guard_manager.guard.address"). */
export const GUARD_SLOT: Hex = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
/** The start of a Safe's module list. */
export const SENTINEL: Address = "0x0000000000000000000000000000000000000001";
/** The longest call data a link may carry. */
export const MAX_DATA_BYTES = 4_096;

export const safeAbi = parseAbi([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function approvedHashes(address owner, bytes32 hash) view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  "function getStorageAt(uint256 offset, uint256 length) view returns (bytes)",
  "function approveHash(bytes32 hashToApprove)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
]);

// ------------------------------------------------------------------ configuration

/** Build-time values (build.mjs); empty strings when unset. */
export interface RawSafeConfig {
  l1RpcUrl?: string | null;
  l2RpcUrl?: string | null;
  explorerUrl?: string | null;
}

export interface SafeConfig {
  l1RpcUrl: string;
  l2RpcUrl: string;
  /** LONGYU explorer base URL without a trailing slash; null when not configured. */
  explorerUrl: string | null;
}

export type SafeConfigResult = { ok: true; config: SafeConfig } | { ok: false; problems: string[] };

export function parseSafeConfig(raw: RawSafeConfig | null | undefined): SafeConfigResult {
  const r = raw ?? {};
  const problems: string[] = [];
  const l2RpcUrl = parseUrl(r.l2RpcUrl);
  if (!(r.l2RpcUrl ?? "").trim()) problems.push("L2_RPC_URL is missing");
  else if (!l2RpcUrl) problems.push("L2_RPC_URL is not an https URL");
  const l1RpcUrl = (r.l1RpcUrl ?? "").trim() ? parseUrl(r.l1RpcUrl) : DEFAULT_L1_RPC;
  if (!l1RpcUrl) problems.push("L1_RPC_URL is not an https URL");
  let explorerUrl: string | null = null;
  if ((r.explorerUrl ?? "").trim()) {
    explorerUrl = parseUrl(r.explorerUrl)?.replace(/\/+$/, "") ?? null;
    if (!explorerUrl) problems.push("EXPLORER_URL is not an https URL");
  }
  if (problems.length || !l1RpcUrl || !l2RpcUrl) return { ok: false, problems };
  return { ok: true, config: { l1RpcUrl, l2RpcUrl, explorerUrl } };
}

// ------------------------------------------------------------------ the transaction and its link

export type SafeChainId = typeof L1_CHAIN_ID | typeof L2_CHAIN_ID;
export const CHAIN_NAMES: Record<SafeChainId, string> = { [L1_CHAIN_ID]: PROFILE.l1.name, [L2_CHAIN_ID]: PROFILE.l2.name };

/** The four fields of a Safe transaction that this page sets; the others are always zero. */
export interface SafeTx {
  to: Address;
  value: bigint;
  data: Hex;
  nonce: bigint;
}

export interface SafeLink {
  chainId: SafeChainId;
  safe: Address;
  tx: SafeTx | null;
}

/** The page address fragment for a Safe, with a transaction when there is one. */
export function encodeLink(link: SafeLink): string {
  const p = new URLSearchParams({ chain: String(link.chainId), safe: link.safe });
  if (link.tx) {
    p.set("to", link.tx.to);
    p.set("value", link.tx.value.toString());
    p.set("data", link.tx.data);
    p.set("nonce", link.tx.nonce.toString());
  }
  return `#${p.toString()}`;
}

const SAFE_KEYS = ["chain", "safe"];
const TX_KEYS = ["chain", "safe", "to", "value", "data", "nonce"];
const UINT256_MAX = 2n ** 256n - 1n;

/** Reads a fragment written by encodeLink. Null for anything else: a link is never half understood. */
export function parseLink(fragment: string): SafeLink | null {
  const entries: [string, string][] = [];
  new URLSearchParams(fragment.replace(/^#/, "")).forEach((value, key) => entries.push([key, value]));
  const keys = entries.map(([k]) => k).sort();
  const is = (expected: string[]) => keys.length === expected.length && [...expected].sort().every((k, i) => k === keys[i]);
  const withTx = is(TX_KEYS);
  if (!withTx && !is(SAFE_KEYS)) return null;
  const get = (key: string) => entries.find(([k]) => k === key)![1];

  const chainId = Number(get("chain"));
  if (get("chain") !== String(chainId) || (chainId !== L1_CHAIN_ID && chainId !== L2_CHAIN_ID)) return null;
  const safe = parseAddress(get("safe"));
  if (!safe) return null;
  if (!withTx) return { chainId, safe, tx: null };

  const to = parseAddress(get("to"));
  const data = get("data").toLowerCase();
  if (!to || !/^(0|[1-9]\d{0,77})$/.test(get("value")) || !/^(0|[1-9]\d{0,17})$/.test(get("nonce"))) return null;
  if (!/^0x([0-9a-f]{2})*$/.test(data) || data.length > 2 + 2 * MAX_DATA_BYTES) return null;
  const value = BigInt(get("value"));
  if (value > UINT256_MAX) return null;
  return { chainId, safe, tx: { to, value, data: data as Hex, nonce: BigInt(get("nonce")) } };
}

/** The hash signers approve: Safe v1.3.0's EIP-712 hash of the transaction, for one Safe on one chain. */
export function safeTxHash(chainId: number, safe: Address, tx: SafeTx): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: {
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SafeTx",
    message: { to: tx.to, value: tx.value, data: tx.data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: tx.nonce },
  });
}

/** Arguments of the Safe's own getTransactionHash, which the page compares with safeTxHash. */
export const hashArgs = (tx: SafeTx) => [tx.to, tx.value, tx.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, tx.nonce] as const;
export const execArgs = (tx: SafeTx, signatures: Hex) => [tx.to, tx.value, tx.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures] as const;

export type Stage = "used" | "ready" | "queued";
/** Where a transaction stands against the Safe's next nonce. */
export function stageOf(txNonce: bigint, safeNonce: bigint): Stage {
  return txNonce < safeNonce ? "used" : txNonce === safeNonce ? "ready" : "queued";
}

// ------------------------------------------------------------------ approvals

const numeric = (x: string, y: string) => (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0);

/**
 * The signers an execution names: those who approved on the chain, and the sender when the sender
 * is a signer (a Safe accepts its sender without an approval). The Safe checks exactly `threshold`
 * of them, in ascending address order. Null when there are too few.
 */
export function chooseSigners(owners: readonly Address[], approved: ReadonlySet<string>, sender: Address | null, threshold: number): Address[] | null {
  if (!Number.isInteger(threshold) || threshold < 1) return null;
  const me = sender?.toLowerCase();
  const able = owners.filter((o) => approved.has(o.toLowerCase()) || o.toLowerCase() === me);
  const unique = [...new Map(able.map((o) => [o.toLowerCase(), o])).values()].sort(numeric);
  return unique.length >= threshold ? unique.slice(0, threshold) : null;
}

/**
 * The `signatures` argument for signers whose approval the Safe looks up itself (type 1): the
 * signer's address as r, zero as s, 1 as v, 65 bytes each, in ascending address order.
 */
export function packApprovals(signers: readonly Address[]): Hex {
  const sorted = [...new Set(signers.map((s) => s.toLowerCase()))].sort(numeric);
  return `0x${sorted.map((s) => `${s.slice(2).padStart(64, "0")}${"0".repeat(64)}01`).join("")}`;
}

// ------------------------------------------------------------------ calls the page can name

/**
 * A call is named only when its selector is in this list, never from text in a link: a link could
 * otherwise show a harmless name for a selector that does something else.
 */
const adminAbi = parseAbi([
  // Tokens
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  // Ownership
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
  "function renounceOwnership()",
  // The Safe's own settings (sent to the Safe itself)
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function removeOwner(address prevOwner, address owner, uint256 _threshold)",
  "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
  "function changeThreshold(uint256 _threshold)",
  "function enableModule(address module)",
  "function disableModule(address prevModule, address module)",
  "function setGuard(address guard)",
  "function setFallbackHandler(address handler)",
  // LONGYU Swap factory
  "function setFeeTo(address _feeTo)",
  "function setFeeToSetter(address _feeToSetter)",
  // Rollup contracts on BSC and the upgrade admin on both chains
  "function upgrade(address _proxy, address _implementation)",
  "function upgradeAndCall(address _proxy, address _implementation, bytes _data) payable",
  "function changeProxyAdmin(address _proxy, address _newAdmin)",
  "function setProxyType(address _address, uint8 _type)",
  "function setImplementationName(address _address, string _name)",
  "function setAddressManager(address _address)",
  "function setAddress(string _name, address _address)",
  "function setUpgrading(bool _upgrading)",
  "function setUnsafeBlockSigner(address _unsafeBlockSigner)",
  "function setBatcherHash(bytes32 _batcherHash)",
  "function setGasConfig(uint256 _overhead, uint256 _scalar)",
  "function setGasConfigEcotone(uint32 _basefeeScalar, uint32 _blobbasefeeScalar)",
  "function setGasLimit(uint64 _gasLimit)",
  "function setRequired(uint256 _required)",
  "function setRecommended(uint256 _recommended)",
  "function setImplementation(uint32 _gameType, address _impl)",
  "function setInitBond(uint32 _gameType, uint256 _initBond)",
]);

const SIMPLE_TYPE = /^(address|bool|string|bytes([1-9]|[12]\d|3[0-2])?|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256))$/;

export interface KnownCall {
  selector: Hex;
  /** For people: "transfer(address to, uint256 amount)". */
  signature: string;
  fn: AbiFunction;
  /** True when the page's form can take every argument. */
  simple: boolean;
}

const inputsKey = (fn: AbiFunction) => JSON.stringify(fn.inputs, (key, value: unknown) => (key === "name" || key === "internalType" ? undefined : value));

/** Every call that changes state, by selector. Two calls with one selector and different arguments make the selector unknown. */
function catalogue(abis: readonly Abi[]): KnownCall[] {
  const bySelector = new Map<string, KnownCall | null>();
  for (const abi of abis) {
    for (const item of abi) {
      if (item.type !== "function" || item.stateMutability === "view" || item.stateMutability === "pure") continue;
      const selector = toFunctionSelector(item);
      const seen = bySelector.get(selector);
      if (seen === undefined) {
        const signature = `${item.name}(${item.inputs.map((i) => `${i.type}${i.name ? ` ${i.name}` : ""}`).join(", ")})`;
        bySelector.set(selector, { selector, signature, fn: item, simple: item.inputs.every((i) => SIMPLE_TYPE.test(i.type)) });
      } else if (seen && (seen.fn.name !== item.name || inputsKey(seen.fn) !== inputsKey(item))) bySelector.set(selector, null);
    }
  }
  return [...bySelector.values()].filter((c): c is KnownCall => c !== null).sort((x, y) => (x.signature.toLowerCase() < y.signature.toLowerCase() ? -1 : 1));
}

declare const __NETWORK__: string;
// Only the testnet has a faucet. In a build the test is a constant, so a mainnet build leaves its calls out.
const faucetAbis = typeof __NETWORK__ === "undefined" || __NETWORK__ === "testnet" ? [faucetAbi] : [];
export const CALLS: readonly KnownCall[] = catalogue([adminAbi, longTokenAbi, miningVaultAbi, miningDistributorAbi, ...faucetAbis, migrationDistributorAbi, paymentRouterAbi, emissionScheduleAbi] as readonly Abi[]);
const CALL_BY_SELECTOR = new Map(CALLS.map((c) => [c.selector, c]));

export interface DecodedCall {
  call: KnownCall;
  args: { name: string; type: string; value: string }[];
}

/**
 * Names a call and its arguments. Null when the selector is unknown or the data is not exactly the
 * encoding of the decoded arguments (extra bytes, a non-standard layout): such data is shown raw.
 */
export function decodeCall(input: Hex): DecodedCall | null {
  const data = input.toLowerCase() as Hex;
  if (size(data) < 4) return null;
  const call = CALL_BY_SELECTOR.get(data.slice(0, 10) as Hex);
  if (!call) return null;
  try {
    const { args = [] } = decodeFunctionData({ abi: [call.fn], data });
    if (encodeFunctionData({ abi: [call.fn], functionName: call.fn.name, args }).toLowerCase() !== data) return null;
    return { call, args: call.fn.inputs.map((input, i) => ({ name: input.name || `#${i + 1}`, type: input.type, value: formatValue(args[i]) })) };
  } catch {
    return null;
  }
}

/** A decoded value as text. Large whole numbers also show as a multiple of 10^18, the unit of BNB and LONG. */
export function formatValue(value: unknown): string {
  if (typeof value === "bigint") return value >= 10n ** 15n ? `${value} (${formatAmount(value)} × 10^${DECIMALS})` : value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

/**
 * One argument typed into the form. Whole numbers may be written with an exponent ("5e18",
 * "1.5e18") when that is exact. Throws with a short message for anything else.
 */
export function parseArg(type: string, text: string): unknown {
  const t = text.trim();
  if (!SIMPLE_TYPE.test(type)) throw new Error(`The form cannot take ${type}. Use raw data.`);
  if (type === "string") return text;
  if (type === "address") {
    if (!isAddress(t, { strict: true })) throw new Error("Not a valid address.");
    return getAddress(t);
  }
  if (type === "bool") {
    if (t !== "true" && t !== "false") throw new Error("Use true or false.");
    return t === "true";
  }
  if (type.startsWith("bytes")) {
    const bytes = type === "bytes" ? null : Number(type.slice(5));
    if (!isHex(t, { strict: true }) || t.length % 2 !== 0) throw new Error("Use hex bytes starting with 0x.");
    if (bytes !== null && size(t) !== bytes) throw new Error(`Needs exactly ${bytes} bytes.`);
    return t.toLowerCase();
  }
  const signed = type.startsWith("int");
  const bits = BigInt(Number(type.replace(/^u?int/, "")));
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e(\d{1,2}))?$/.exec(t);
  if (!m) throw new Error("Use a whole number.");
  const [, minus = "", whole = "", fraction = "", exponent = "0"] = m;
  if (fraction.length > Number(exponent)) throw new Error("Use a whole number.");
  const magnitude = BigInt(whole + fraction) * 10n ** BigInt(Number(exponent) - fraction.length);
  const n = minus ? -magnitude : magnitude;
  const [min, max] = signed ? [-(2n ** (bits - 1n)), 2n ** (bits - 1n) - 1n] : [0n, 2n ** bits - 1n];
  if (n < min || n > max) throw new Error(`Out of range for ${type}.`);
  return n;
}

/** Call data for a known call from the form's texts, one per argument. */
export function encodeCall(call: KnownCall, texts: readonly string[]): Hex {
  if (texts.length !== call.fn.inputs.length) throw new Error("Fill in every argument.");
  const args = call.fn.inputs.map((input, i) => {
    try {
      return parseArg(input.type, texts[i]!);
    } catch (e) {
      throw new Error(`${input.name || `#${i + 1}`}: ${(e as Error).message}`);
    }
  });
  return encodeFunctionData({ abi: [call.fn], functionName: call.fn.name, args });
}

/** Raw call data typed into the form: hex bytes, or nothing. Null when malformed or too long for a link. */
export function parseData(text: string): Hex | null {
  const t = text.trim().toLowerCase();
  if (t === "" || t === "0x") return "0x";
  if (!/^0x([0-9a-f]{2})+$/.test(t) || t.length > 2 + 2 * MAX_DATA_BYTES) return null;
  return t as Hex;
}

// ------------------------------------------------------------------ messages

const REVERTS: [RegExp, string][] = [
  [/GS013/, "The transaction inside would fail."],
  [/GS02[0-6]/, "Not enough approvals."],
  [/GS030/, "Only a signer of this Safe can approve."],
  [/GS031/, "Only the Safe itself can do that."],
];

/** A short message for the page; a Safe's refusals are put in plain words. */
export function safeErrorMessage(e: unknown): string {
  let text = "";
  for (let cur = e as { shortMessage?: unknown; message?: unknown; cause?: unknown } | undefined, i = 0; cur && typeof cur === "object" && i < 8; cur = cur.cause as typeof cur, i++) {
    text += ` ${String(cur.shortMessage ?? "")} ${String(cur.message ?? "")}`;
  }
  const short = errorMessage(e);
  if (short === "Cancelled in your wallet.") return short;
  for (const [pattern, message] of REVERTS) if (pattern.test(text)) return message;
  return short;
}
