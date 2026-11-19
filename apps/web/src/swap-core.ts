/**
 * Pure helpers for the swap page (tested under Node): settings, the pool maths of LONGYU Swap and
 * the limits sent with every trade.
 *
 * LONGYU Swap is the Uniswap V2 contracts (contracts/dex): one pool per pair, a 0.3% fee taken from
 * the amount paid in, and a router whose "ETH" functions take the chain's native asset, BNB.
 */
import { parseAbi, type Address } from "viem";
import { DECIMALS, errorMessage, parseAddress, parseUrl } from "./bridge-core.ts";

/** Wrapped BNB, built into the chain; the router's wrapped token. */
export const WBNB: Address = "0x4200000000000000000000000000000000000006";
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** A trade not mined within this time of LONGYU's newest block is refused by the router. */
export const DEADLINE_SECONDS = 20 * 60;
/** Slippage choices in hundredths of a percent; the first is the default. */
export const SLIPPAGE_CHOICES = [50, 100, 300] as const;
/** From this price impact on, the page marks the quote in red. */
export const HIGH_IMPACT_BPS = 500;

// ------------------------------------------------------------------ ABIs (only what the page calls)

export const routerAbi = parseAbi([
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)",
  "function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256 amountToken, uint256 amountETH)",
]);
export const factoryAbi = parseAbi(["function getPair(address tokenA, address tokenB) view returns (address)"]);
export const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
]);
export const multicallAbi = parseAbi(["function getEthBalance(address addr) view returns (uint256 balance)"]);

// ------------------------------------------------------------------ configuration

/** Build-time values (build.mjs); empty strings when unset. */
export interface RawSwapConfig {
  router?: string | null;
  factory?: string | null;
  token?: string | null;
  rpcUrl?: string | null;
  explorerUrl?: string | null;
}

export interface SwapConfig {
  router: Address;
  factory: Address;
  /** tLONG on LONGYU. */
  token: Address;
  rpcUrl: string;
  /** LONGYU explorer base URL without a trailing slash; null when not configured. */
  explorerUrl: string | null;
}

export type SwapConfigResult = { ok: true; config: SwapConfig } | { ok: false; problems: string[] };

const ADDRESS_ENV = { router: "SWAP_ROUTER", factory: "SWAP_FACTORY", token: "L2_TOKEN" } as const;

/** Checks every build-time value. Addresses are never guessed: a missing or bad one closes the page. */
export function parseSwapConfig(raw: RawSwapConfig | null | undefined): SwapConfigResult {
  const r = raw ?? {};
  const problems: string[] = [];
  const addresses = {} as Record<keyof typeof ADDRESS_ENV, Address>;
  for (const [key, env] of Object.entries(ADDRESS_ENV) as [keyof typeof ADDRESS_ENV, string][]) {
    const value = (r[key] ?? "").trim();
    const parsed = parseAddress(value);
    if (!value) problems.push(`${env} is missing`);
    else if (!parsed) problems.push(`${env} is not a valid address`);
    else if (parsed === WBNB) problems.push(`${env} is the wrapped BNB contract`);
    else addresses[key] = parsed;
  }
  const seen = new Set(Object.values(addresses).map((a) => a.toLowerCase()));
  if (seen.size !== Object.keys(addresses).length) problems.push("two of the addresses are the same");

  const rpcUrl = parseUrl(r.rpcUrl);
  if (!(r.rpcUrl ?? "").trim()) problems.push("L2_RPC_URL is missing");
  else if (!rpcUrl) problems.push("L2_RPC_URL is not an https URL");
  let explorerUrl: string | null = null;
  if ((r.explorerUrl ?? "").trim()) {
    explorerUrl = parseUrl(r.explorerUrl)?.replace(/\/+$/, "") ?? null;
    if (!explorerUrl) problems.push("EXPLORER_URL is not an https URL");
  }
  if (problems.length || !rpcUrl) return { ok: false, problems };
  return { ok: true, config: { ...addresses, rpcUrl, explorerUrl } };
}

/** Values read from the chain before any transaction, to catch a wrong or swapped address. */
export interface SwapObserved {
  chainId: number;
  routerFactory: string;
  routerWrapped: string;
  tokenDecimals: number;
}

/** Everything that does not line up; empty when the configured contracts are LONGYU Swap's. */
export function swapWiringProblems(o: SwapObserved, cfg: SwapConfig, chainId: number): string[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const p: string[] = [];
  if (o.chainId !== chainId) p.push(`L2_RPC_URL serves chain ${o.chainId}, not ${chainId}`);
  if (!same(o.routerFactory, cfg.factory)) p.push("SWAP_FACTORY is not the router's factory");
  if (!same(o.routerWrapped, WBNB)) p.push("the router's wrapped token is not WBNB");
  if (o.tokenDecimals !== DECIMALS) p.push("tLONG must have 18 decimals");
  return p;
}

// ------------------------------------------------------------------ pool maths

/** A pool's reserves, named by asset. */
export interface Reserves {
  bnb: bigint;
  long: bigint;
}

/**
 * What a trade pays out: UniswapV2Library.getAmountOut. The 0.3% fee comes off the amount paid in,
 * and the result is rounded down, exactly as the pool computes it. Zero when there is nothing to trade.
 */
export function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const withFee = amountIn * 997n;
  return (withFee * reserveOut) / (reserveIn * 1000n + withFee);
}

/** The amount of B worth `amountA` at the pool's ratio: UniswapV2Library.quote, rounded down. */
export function quote(amountA: bigint, reserveA: bigint, reserveB: bigint): bigint {
  if (amountA <= 0n || reserveA <= 0n || reserveB <= 0n) return 0n;
  return (amountA * reserveB) / reserveA;
}

/** The least the sender accepts: `amount` less the slippage, rounded down. */
export function minimumOut(amount: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new RangeError("slippage must be 0 to 10000");
  return amount <= 0n ? 0n : (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * How far a trade moves its own price, in hundredths of a percent and rounded up: the shortfall of
 * `out` against the same trade at the pool's current ratio, after the fee. The fee itself is not impact.
 */
export function impactBps(amountIn: bigint, out: bigint, reserveIn: bigint, reserveOut: bigint): number {
  const ideal = quote(amountIn * 997n, reserveIn * 1000n, reserveOut);
  if (ideal <= 0n || out >= ideal) return 0;
  return Number(((ideal - out) * 10_000n + ideal - 1n) / ideal);
}

/** Reserves by asset, from the pair's own order. Null when the pair is not the tLONG/WBNB pair. */
export function orderReserves(token0: string, token1: string, token: string, reserve0: bigint, reserve1: bigint): Reserves | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (same(token0, WBNB) && same(token1, token)) return { bnb: reserve0, long: reserve1 };
  if (same(token0, token) && same(token1, WBNB)) return { bnb: reserve1, long: reserve0 };
  return null;
}

/** What `liquidity` pool tokens return when burned, rounded down as the pair does. */
export function shareOf(liquidity: bigint, totalSupply: bigint, reserves: Reserves): Reserves {
  if (liquidity <= 0n || totalSupply <= 0n) return { bnb: 0n, long: 0n };
  return { bnb: (liquidity * reserves.bnb) / totalSupply, long: (liquidity * reserves.long) / totalSupply };
}

/** `percent` (1 to 100) of a balance, rounded down; 100 is the whole balance. */
export function portion(balance: bigint, percent: number): bigint {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new RangeError("percent must be 1 to 100");
  return (balance * BigInt(percent)) / 100n;
}

// ------------------------------------------------------------------ display

/**
 * Base units as a decimal with at most `places` fraction digits, rounded down so the page never
 * shows more than there is. An amount too small to show reads "<0.000001".
 */
export function formatShort(units: bigint, places = 6, decimals = DECIMALS): string {
  if (units <= 0n) return "0";
  const step = 10n ** BigInt(decimals - places);
  const cut = units / step;
  if (cut === 0n) return `<0.${"0".repeat(places - 1)}1`;
  const one = 10n ** BigInt(places);
  const frac = (cut % one).toString().padStart(places, "0").replace(/0+$/, "");
  return `${cut / one}${frac ? `.${frac}` : ""}`;
}

/** "0.42%" from hundredths of a percent. */
export function formatBps(bps: number): string {
  if (bps <= 0) return "0%";
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

const MOVED = "The price moved. Check the new quote.";
const REVERTS: [RegExp, string][] = [
  // The router's own limits: the amounts fell below the minimums sent with the trade.
  [/UniswapV2Router: INSUFFICIENT_(OUTPUT|A|B)_AMOUNT/, MOVED],
  [/UniswapV2Router: EXPIRED/, "That took too long. Try again."],
  // The pool or the library refusing a zero amount, or a first deposit below the pool's locked minimum.
  [/INSUFFICIENT_LIQUIDITY_(MINTED|BURNED)|INSUFFICIENT_(INPUT_|OUTPUT_)?AMOUNT|ds-math-sub-underflow/, "Amount too small."],
  [/INSUFFICIENT_LIQUIDITY/, "The pool cannot fill this amount."],
];

/** A short message for the page; the router's and the pool's refusals are put in plain words. */
export function swapErrorMessage(e: unknown): string {
  let text = "";
  for (let cur = e as { shortMessage?: unknown; message?: unknown; cause?: unknown } | undefined, i = 0; cur && typeof cur === "object" && i < 8; cur = cur.cause as typeof cur, i++) {
    text += ` ${String(cur.shortMessage ?? "")} ${String(cur.message ?? "")}`;
  }
  const short = errorMessage(e);
  // A rejection in the wallet reads the same on every page, whatever the text around it says.
  if (short === "Cancelled in your wallet.") return short;
  for (const [pattern, message] of REVERTS) if (pattern.test(text)) return message;
  return short;
}

export { MOVED as PRICE_MOVED };
