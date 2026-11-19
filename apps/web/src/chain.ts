/** Pure helpers for the claim page (tested under Node). */

export interface NetworkInfo {
  chainId: string;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** The token rewards are paid in; null when they are paid in the native token, absent if unknown. */
  rewardToken?: { address: string; name: string; symbol: string; decimals: number } | null;
  distributor: string;
}

/** A chain id as the API or the build wrote it, text or number; null when it is neither. */
function chainIdOf(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  return typeof v === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v) ? BigInt(v) : null;
}

/**
 * The network details the page works with. A page built with them already holds the chain and the
 * contract its wallet requests go to, so the API's answer is taken only when it names the same two
 * (an address in any case): whoever answers for the API cannot point a claim at another contract.
 * With no answer, or one that differs, the built-in details are used. Null when there are none at all.
 */
export function trustedNetwork(api: NetworkInfo | null, builtIn: NetworkInfo | null): NetworkInfo | null {
  const answer = typeof api === "object" ? api : null;
  if (!builtIn || !answer) return builtIn ?? answer;
  const chain = chainIdOf(builtIn.chainId);
  const sameChain = chain !== null && chainIdOf(answer.chainId) === chain;
  const sameContract = typeof answer.distributor === "string" && typeof builtIn.distributor === "string" && answer.distributor.toLowerCase() === builtIn.distributor.toLowerCase();
  return sameChain && sameContract ? answer : builtIn;
}

/** Symbol of the reward asset: tLONG on LONGYU, where the native token is BNB. */
export function rewardSymbol(n: NetworkInfo): string {
  return n.rewardToken === null ? n.nativeCurrency.symbol : n.rewardToken?.symbol ?? "tLONG";
}

/** EIP-747 parameters so the wallet shows the reward token. Null when there is no token to add. */
export function watchAssetParams(n: NetworkInfo) {
  const t = n.rewardToken;
  return t ? { type: "ERC20" as const, options: { address: t.address, symbol: t.symbol, decimals: t.decimals } } : null;
}

/** EIP-3085 parameters so browser wallets can add the LONGYU network with one click. */
export function addChainParams(n: NetworkInfo) {
  return {
    chainId: `0x${BigInt(n.chainId).toString(16)}`,
    chainName: n.chainName,
    nativeCurrency: n.nativeCurrency,
    rpcUrls: [n.rpcUrl],
    blockExplorerUrls: [n.explorerUrl],
  };
}

export function formatAmount(wei: bigint, places = 4): string {
  const one = 10n ** 18n;
  const whole = wei / one;
  const frac = (wei % one).toString().padStart(18, "0").slice(0, places).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Where LONGYU MINE runs in a browser and where its Android app downloads, from the address the
 * page was built with. Null when there is none or it is not an https address: then no link shows.
 */
export function mineLinks(mineUrl: string): { web: string; android: string } | null {
  let url: URL;
  try {
    url = new URL(mineUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return { web: `${url.origin}/`, android: `${url.origin}/download/android` };
}

/** What the contract will pay: entitlement minus what this address already claimed. */
export function owed(cumulative: bigint, claimed: bigint): bigint {
  return cumulative > claimed ? cumulative - claimed : 0n;
}

/** An answer from the API that is not a success: the HTTP status and the API's error code, when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: unknown) {
    super(`The LONGYU API answered ${status}.`);
    this.status = status;
    this.code = typeof code === "string" ? code : null;
  }
}

/**
 * What a failed request for the proof means. "nothing": the API's normal answer when no root is
 * claimable yet or the address is not in it. "chain": the API did not answer or is in trouble, so
 * the proof is read from the chain. "error": the API refused the request.
 */
export function proofFailure(e: unknown): "nothing" | "chain" | "error" {
  if (!(e instanceof ApiError)) return "chain";
  if (e.status === 404 && (e.code === "no_active_root" || e.code === "no_entitlement")) return "nothing";
  return e.status >= 500 ? "chain" : "error";
}

/** The public RPC answers eth_getLogs for at most this many blocks at a time. */
export const LOG_WINDOW = 50_000n;
/** LONGYU makes a block every 250 ms. */
export const BLOCKS_PER_SECOND = 4n;
/** How far back from the head the search goes when the estimate misses: a little over eight days. */
export const MAX_LOG_WINDOWS = 60;

export type BlockRange = { fromBlock: bigint; toBlock: bigint };

/**
 * Where to look for the event of a root posted at `postedAt` (seconds), in order; the caller stops
 * at the first hit. First the window around the block that time points to, with 25,000 blocks of
 * margin on each side, then back from the head window by window.
 */
export function logWindows(head: { number: bigint; timestamp: bigint }, postedAt: bigint): BlockRange[] {
  const windows: BlockRange[] = [];
  if (postedAt > 0n) {
    const age = head.timestamp > postedAt ? head.timestamp - postedAt : 0n;
    const guess = head.number > age * BLOCKS_PER_SECOND ? head.number - age * BLOCKS_PER_SECOND : 0n;
    const fromBlock = guess > LOG_WINDOW / 2n ? guess - LOG_WINDOW / 2n : 0n;
    const last = fromBlock + LOG_WINDOW - 1n;
    windows.push({ fromBlock, toBlock: last < head.number ? last : head.number });
  }
  for (let toBlock = head.number, i = 0; i < MAX_LOG_WINDOWS && toBlock >= 0n; i++, toBlock -= LOG_WINDOW) {
    windows.push({ fromBlock: toBlock >= LOG_WINDOW ? toBlock - LOG_WINDOW + 1n : 0n, toBlock });
  }
  return windows;
}
