/**
 * What the public endpoint serves. Every request is checked here before the node sees it: only the
 * methods a wallet, a dapp or the bridge needs, each with a cost that the rate limit counts.
 */

/** Cost of each served method. Reads of one record cost 1; calls that run the EVM or scan blocks cost 4. */
export const METHODS: Readonly<Record<string, number>> = Object.freeze({
  eth_chainId: 1,
  eth_blockNumber: 1,
  eth_syncing: 1,
  eth_accounts: 1,
  eth_gasPrice: 1,
  eth_maxPriorityFeePerGas: 1,
  eth_feeHistory: 1,
  eth_getBalance: 1,
  eth_getTransactionCount: 1,
  eth_getCode: 1,
  eth_getStorageAt: 1,
  eth_getBlockByNumber: 1,
  eth_getBlockByHash: 1,
  eth_getBlockTransactionCountByNumber: 1,
  eth_getBlockTransactionCountByHash: 1,
  eth_getTransactionByHash: 1,
  eth_getTransactionByBlockHashAndIndex: 1,
  eth_getTransactionByBlockNumberAndIndex: 1,
  eth_getTransactionReceipt: 1,
  net_version: 1,
  net_listening: 1,
  web3_clientVersion: 1,
  eth_sendRawTransaction: 2,
  eth_call: 4,
  eth_estimateGas: 4,
  eth_createAccessList: 4,
  eth_getLogs: 4,
  // The bridge proves withdrawals with a storage proof of the message passer.
  eth_getProof: 4,
  eth_getBlockReceipts: 4,
});

export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const LIMIT_EXCEEDED = -32005;

export type Id = string | number | null;

/**
 * The node reads object keys without regard to case and lets the last match win, so "Method" or
 * "FROMBLOCK" would mean something to it that the checks here never saw. The rule that closes this:
 * every object the policy reads a field from (the request itself and the eth_getLogs filter) may hold
 * only the exact keys listed here, and the node is sent a fresh encoding of the checked values, never
 * the client's own bytes. Objects the policy never looks into (a call, state overrides) pass as given.
 */
const REQUEST_KEYS: ReadonlySet<string> = new Set(["jsonrpc", "id", "method", "params"]);
const FILTER_KEYS: ReadonlySet<string> = new Set(["fromBlock", "toBlock", "blockHash", "address", "topics"]);

/** Deepest nesting of arrays and objects in params; real calls stay under ten levels. */
export const MAX_DEPTH = 32;

/** A block range an eth_getLogs query covers; null stands for the chain's newest block. */
export type LogRange = { from: bigint | null; to: bigint | null };

export type Verdict =
  | { kind: "forward"; id: Id; idSafe: boolean; method: string; params: unknown; cost: number; logRange?: LogRange }
  | { kind: "local"; id: Id; idSafe: boolean; method: string; result: unknown }
  | { kind: "reject"; id: Id; idSafe: boolean; method: string | null; code: number; message: string };

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * An id can be repeated back exactly when it is a string, null or a whole number JavaScript holds
 * without rounding. Requests with any other id are refused, since the node is never sent their bytes.
 */
export function idOf(req: unknown): { id: Id; safe: boolean } {
  if (typeof req !== "object" || req === null || Array.isArray(req) || !own(req, "id")) return { id: null, safe: false };
  const id = (req as { id: unknown }).id;
  if (id === null || typeof id === "string") return { id, safe: true };
  if (typeof id === "number" && Number.isSafeInteger(id)) return { id, safe: true };
  return { id: null, safe: false };
}

/** True when a value nests arrays and objects more than `left` levels deep. */
function tooDeep(v: unknown, left: number): boolean {
  if (typeof v !== "object" || v === null) return false;
  if (left === 0) return true;
  for (const inner of Array.isArray(v) ? v : Object.values(v)) if (tooDeep(inner, left - 1)) return true;
  return false;
}

function block(v: unknown): bigint | null | "invalid" {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return "invalid";
  if (v === "latest" || v === "pending" || v === "safe" || v === "finalized") return null;
  if (v === "earliest") return 0n;
  if (!/^0x[0-9a-fA-F]{1,16}$/.test(v)) return "invalid";
  return BigInt(v);
}

/**
 * The blocks an eth_getLogs query covers: a range, "hash" for a single block by hash, "lagging" for
 * a start at safe or finalized, or "invalid".
 */
export function logRange(params: unknown): LogRange | "hash" | "lagging" | "invalid" {
  if (!Array.isArray(params) || params.length !== 1) return "invalid";
  const filter: unknown = params[0];
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return "invalid";
  if (Object.keys(filter).some((k) => !FILTER_KEYS.has(k))) return "invalid";
  const f = filter as { blockHash?: unknown; fromBlock?: unknown; toBlock?: unknown };
  if (f.blockHash !== undefined && f.blockHash !== null) return typeof f.blockHash === "string" ? "hash" : "invalid";
  // Safe and finalized lie behind the newest block by a distance not known here. Counting them as the
  // newest block is right for toBlock, where it can only overstate the range, and wrong for fromBlock.
  if (f.fromBlock === "safe" || f.fromBlock === "finalized") return "lagging";
  const from = block(f.fromBlock);
  const to = block(f.toBlock);
  if (from === "invalid" || to === "invalid") return "invalid";
  return { from, to };
}

/** Number of blocks a range covers once the newest block is known. */
export function rangeLength(range: LogRange, head: bigint): bigint {
  const from = range.from ?? head;
  const to = range.to ?? head;
  return to >= from ? to - from + 1n : 0n;
}

/**
 * A method name as the access log writes it. A served name is written whole. Any other is text the
 * client chose, of any length and with line breaks if it likes: the log gets a constant mark and at most
 * 40 of its letters, digits and underscores, so a name can neither forge a line nor fill the log.
 */
export function logName(method: string | null): string {
  if (method === null) return "?";
  if (own(METHODS, method)) return method;
  return `unserved:${method.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40)}`;
}

/** Decides what happens to one JSON-RPC request object. */
export function classify(req: unknown, opts: { chainId: bigint }): Verdict {
  const { id, safe: idSafe } = idOf(req);
  const reject = (code: number, message: string, method: string | null = null): Verdict => ({ kind: "reject", id, idSafe, method, code, message });
  if (typeof req !== "object" || req === null || Array.isArray(req)) return reject(INVALID_REQUEST, "invalid request");
  if (Object.keys(req).some((k) => !REQUEST_KEYS.has(k))) return reject(INVALID_REQUEST, "invalid request: only jsonrpc, id, method and params are accepted");
  const r = req as { jsonrpc?: unknown; method?: unknown; params?: unknown };
  if (r.jsonrpc !== "2.0" || typeof r.method !== "string") return reject(INVALID_REQUEST, "invalid request");
  // A request without an id is a notification, which gets no answer; nothing served here is one.
  if (!own(req, "id")) return reject(INVALID_REQUEST, "invalid request: an id is required");
  // The node is sent a fresh encoding of the id and the answer repeats it, so it must survive both exactly.
  if (!idSafe) return reject(INVALID_REQUEST, "invalid request: the id must be a string or a whole number");
  const method = r.method;
  if (r.params !== undefined && !Array.isArray(r.params)) return reject(INVALID_PARAMS, "params must be an array", method);
  const cost = own(METHODS, method) ? METHODS[method] : undefined;
  if (cost === undefined) return reject(METHOD_NOT_FOUND, `the method ${method.slice(0, 64)} is not available on this endpoint`, method);

  // The chain's identity never changes: answered here, since wallets ask for it constantly. Alone or in
  // a batch, the node is never asked for its client version, which names its software and release.
  if (method === "eth_chainId") return { kind: "local", id, idSafe, method, result: `0x${opts.chainId.toString(16)}` };
  if (method === "net_version") return { kind: "local", id, idSafe, method, result: opts.chainId.toString() };
  if (method === "web3_clientVersion") return { kind: "local", id, idSafe, method, result: "LONGYU" };
  // Deeper than anything real, and too deep to encode again for the node.
  if (tooDeep(r.params, MAX_DEPTH)) return reject(INVALID_PARAMS, "params are nested too deeply", method);
  if (method === "eth_getLogs") {
    const range = logRange(r.params);
    if (range === "invalid") return reject(INVALID_PARAMS, "eth_getLogs takes one filter with fromBlock and toBlock, or blockHash, and may add address and topics; no other fields", method);
    if (range === "lagging") return reject(INVALID_PARAMS, "eth_getLogs cannot start at safe or finalized on this endpoint; give fromBlock as a block number", method);
    if (range !== "hash") return { kind: "forward", id, idSafe, method, params: r.params, cost, logRange: range };
  }
  return { kind: "forward", id, idSafe, method, params: r.params, cost };
}
