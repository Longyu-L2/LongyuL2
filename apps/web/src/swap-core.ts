/**
 * Pure helpers for the swap page (tested under Node): settings, the tokens it trades and what it
 * says about each, the pool maths of LONGYU Swap and the limits sent with every trade.
 *
 * LONGYU Swap is the Uniswap V2 contracts (contracts/dex): one pool per pair, a 0.3% fee taken from
 * the amount paid in, and a router whose "ETH" functions take the chain's native asset, BNB. The page
 * trades any token against BNB.
 */
import { parseAbi, type Address } from "viem";
import { DECIMALS, NATIVE, TOKEN, errorMessage, parseAddress, parseUrl } from "./bridge-core.ts";
import { PROFILE } from "./profile.ts";

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

// A pasted token can be anything, a fee on every transfer included. The router's plain swaps and
// removeLiquidityETH assume the amount sent is the amount that arrives, so with such a token they
// revert (the pool's K check, or the router short of what it forwards). Their
// SupportingFeeOnTransferTokens forms check what the recipient's balance gained instead, against the
// same minimum, and cost the same for a plain token. addLiquidityETH has no such form and needs none:
// the pool mints for what it received.
export const routerAbi = parseAbi([
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)",
  "function removeLiquidityETHSupportingFeeOnTransferTokens(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256 amountETH)",
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
/** LONGYU Launch (contracts/src/TokenLauncher.sol): what the pages read and send. */
export const launcherAbi = parseAbi([
  "function launch(string name_, string symbol_, uint256 wholeTokens) returns (address token)",
  "function tokenCount() view returns (uint256)",
  "function tokensFrom(uint256 start, uint256 count) view returns (address[] page)",
  "function launched(address token) view returns (bool)",
  "function passesForLongyu(string name_, string symbol_) pure returns (bool)",
  "event TokenLaunched(address indexed token, address indexed creator, string name, string symbol, uint256 supply)",
  "error BadName()",
  "error BadSymbol()",
  "error BadSupply()",
  "error ReservedName()",
]);

// ------------------------------------------------------------------ configuration

/** Build-time values (build.mjs); empty strings when unset. */
export interface RawSwapConfig {
  router?: string | null;
  factory?: string | null;
  token?: string | null;
  launcher?: string | null;
  rpcUrl?: string | null;
  explorerUrl?: string | null;
  /** LONGYU's API, which serves token logos (optional). */
  apiUrl?: string | null;
}

export interface SwapConfig {
  router: Address;
  factory: Address;
  /** The mined token on LONGYU, the official one: tLONG, or LONG. */
  token: Address;
  /** LONGYU Launch, whose tokens the page lists; null when not configured. */
  launcher: Address | null;
  rpcUrl: string;
  /** LONGYU explorer base URL without a trailing slash; null when not configured. */
  explorerUrl: string | null;
  /** LONGYU's API without a trailing slash, for token logos; null shows monograms only. */
  apiUrl: string | null;
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
  let launcher: Address | null = null;
  if ((r.launcher ?? "").trim()) {
    launcher = parseAddress(r.launcher);
    if (!launcher) problems.push("TOKEN_LAUNCHER is not a valid address");
    else if (launcher === WBNB) problems.push("TOKEN_LAUNCHER is the wrapped BNB contract");
  }
  const all = [...Object.values(addresses), ...(launcher ? [launcher] : [])];
  if (new Set(all.map((a) => a.toLowerCase())).size !== all.length) problems.push("two of the addresses are the same");

  const rpcUrl = parseUrl(r.rpcUrl);
  if (!(r.rpcUrl ?? "").trim()) problems.push("L2_RPC_URL is missing");
  else if (!rpcUrl) problems.push("L2_RPC_URL is not an https URL");
  let explorerUrl: string | null = null;
  if ((r.explorerUrl ?? "").trim()) {
    explorerUrl = parseUrl(r.explorerUrl)?.replace(/\/+$/, "") ?? null;
    if (!explorerUrl) problems.push("EXPLORER_URL is not an https URL");
  }
  if (problems.length || !rpcUrl) return { ok: false, problems };
  return { ok: true, config: { ...addresses, launcher, rpcUrl, explorerUrl, apiUrl: logoApi(r.apiUrl) } };
}

/** The API that serves token logos: an https address (http only on localhost), else none. Logos are never required. */
export function logoApi(value: string | null | undefined): string | null {
  return parseUrl(value)?.replace(/\/+$/, "") ?? null;
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
  if (o.tokenDecimals !== DECIMALS) p.push(`${TOKEN} must have 18 decimals`);
  return p;
}

// ------------------------------------------------------------------ tokens

/** A token as its own contract describes it, cleaned for the page. */
export interface TokenInfo {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
}

/** How many of the newest tokens made with LONGYU Launch the page lists. */
export const LAUNCHED_SHOWN = 50;
/** The most decimals a token here can have: amounts are typed and shown in at most 18. */
export const MAX_DECIMALS = 18;

/** The first index and the count of the newest `shown` tokens, for TokenLauncher.tokensFrom. */
export function newestRange(total: bigint, shown = LAUNCHED_SHOWN): { start: bigint; count: bigint } {
  const count = total <= 0n ? 0n : total < BigInt(shown) ? total : BigInt(shown);
  return { start: total > count ? total - count : 0n, count };
}

/**
 * A name or symbol fit to show: controls and direction marks removed (they could make one token's
 * text read as another's), spaces collapsed, cut at `max` characters.
 */
export function cleanText(text: string, max: number): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}

/** One read in a multicall that allows failures, as viem returns it. */
export type Read = { status: "success"; result: unknown } | { status: "failure"; error?: unknown };

export const NOT_A_TOKEN = "That address is not a token on LONGYU.";

/**
 * A token from the reads of its name, symbol and decimals (and its total supply, when read), or the
 * reason the page cannot trade it. Anything that does not answer as an ERC-20 is not a token here.
 */
export function tokenFrom(
  address: Address,
  reads: { name: Read; symbol: Read; decimals: Read; totalSupply?: Read },
): { ok: true; token: TokenInfo } | { ok: false; error: string } {
  if (address.toLowerCase() === WBNB.toLowerCase()) return { ok: false, error: `That is wrapped ${NATIVE}. Choose the token to trade against ${NATIVE}.` };
  const { name, symbol, decimals, totalSupply } = reads;
  if (name.status !== "success" || symbol.status !== "success" || decimals.status !== "success") return { ok: false, error: NOT_A_TOKEN };
  if (totalSupply && (totalSupply.status !== "success" || typeof totalSupply.result !== "bigint")) return { ok: false, error: NOT_A_TOKEN };
  if (typeof name.result !== "string" || typeof symbol.result !== "string" || typeof decimals.result !== "number") return { ok: false, error: NOT_A_TOKEN };
  if (!Number.isInteger(decimals.result) || decimals.result < 0) return { ok: false, error: NOT_A_TOKEN };
  if (decimals.result > MAX_DECIMALS) return { ok: false, error: `This page trades tokens with up to ${MAX_DECIMALS} decimals.` };
  const shownSymbol = cleanText(symbol.result, 16);
  if (!shownSymbol) return { ok: false, error: "That token has no symbol." };
  return { ok: true, token: { address, name: cleanText(name.result, 40) || shownSymbol, symbol: shownSymbol, decimals: decimals.result } };
}

/** Tokens from several lists in one, each once: the first list a token is in wins. */
export function mergeTokens<T extends { address: string }>(...lists: readonly (readonly T[])[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const t of list) {
      const key = t.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/** Whether a token matches what is typed in the search: part of its symbol or name, or the start of its address. */
export function matchesSearch(t: TokenInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (q.startsWith("0x")) return t.address.toLowerCase().startsWith(q);
  return t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q);
}

/**
 * What the search field holds: nothing to look up (null: empty, words to search the list for, or an
 * address still being typed), a token address to read, or why the text is not one.
 */
export function pastedAddress(text: string): { address: Address } | { error: string } | null {
  const v = text.trim();
  if (!/^0x/i.test(v) || v.length < 42) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return { error: "That is not an address." };
  const address = parseAddress(v);
  if (!address) return { error: /^0x0{40}$/i.test(v) ? "That is not an address." : "Check the address: its capital letters do not match it." };
  return { address };
}

export type Mode = "swap" | "add" | "remove";

/** The token and the mode a link opens the page with: swap.html?token=0x…&mode=add. */
export function linkParams(search: string): { token: Address | null; badToken: boolean; mode: Mode | null } {
  const params = new URLSearchParams(search);
  const raw = (params.get("token") ?? "").trim();
  const token = raw ? parseAddress(raw) : null;
  const mode = params.get("mode");
  return { token, badToken: raw !== "" && token === null, mode: mode === "swap" || mode === "add" || mode === "remove" ? mode : null };
}

// ------------------------------------------------------------------ official tokens

/**
 * Letters that look like those of LONG and LONGYU: digits, Cyrillic and Greek capitals, small capitals.
 * The explorer's own list (apps/explorer/src/web/pages.ts), so both pages name the same tokens.
 */
const LOOKALIKE: Record<string, string> = {
  "0": "O", "О": "O", "Ο": "O", "Օ": "O", "1": "L", "|": "L", "Ӏ": "L", "Ꮮ": "L", "ʟ": "L",
  "Ν": "N", "ɴ": "N", "Ԍ": "G", "ɢ": "G", "У": "Y", "Ү": "Y", "Υ": "Y", "ʏ": "Y", "Ʋ": "U", "Џ": "U", "ᴜ": "U",
};

/** A name as it reads: compatibility forms folded, capitals, look-alikes replaced, only A to Z kept. */
export function readsAs(s: string | null): string {
  return [...(s ?? "").normalize("NFKC").toUpperCase()].map((c) => LOOKALIKE[c] ?? c).join("").replace(/[^A-Z]/g, "");
}

/**
 * Whether a token's name or symbol passes for LONGYU's: LONG with or without a T or a W before it,
 * or anything with LONGYU in it. On plain ASCII it is TokenLauncher.passesForLongyu.
 */
export function passesForLongyu(t: { name: string | null; symbol: string | null }): boolean {
  return [readsAs(t.name), readsAs(t.symbol)].some((x) => /^[TW]?LONG$/.test(x) || x.includes("LONGYU"));
}

export const MINING_PHASE = `Official ${TOKEN} is in its mining phase and not tradable yet.`;
export const LAUNCHED_NOTE = "Made with LONGYU Launch: fixed supply, no owner.";
export const UNKNOWN_NOTE = "Anyone can create a token. Check the address before you trade.";

/** What the page says about a token, and whether it trades it. */
export type Standing =
  | { kind: "official" | "launched" | "other"; trade: true; note: string | null }
  | { kind: "mining" | "imitation"; trade: false; note: string };

/**
 * LONGYU's own token trades where the network lets it (`officialTrades`: tLONG on testnet; LONG
 * only after the TGE). Another token that passes for it never trades here. `launched` is
 * TokenLauncher.launched for the token.
 */
export function standing(t: { address: string; name: string; symbol: string }, official: Address, launched: boolean, officialTrades = PROFILE.tradeToken): Standing {
  if (t.address.toLowerCase() === official.toLowerCase()) return officialTrades ? { kind: "official", trade: true, note: null } : { kind: "mining", trade: false, note: MINING_PHASE };
  if (passesForLongyu(t)) return { kind: "imitation", trade: false, note: `Not LONGYU's token. The only official ${TOKEN} is ${official}.` };
  if (launched) return { kind: "launched", trade: true, note: LAUNCHED_NOTE };
  return { kind: "other", trade: true, note: UNKNOWN_NOTE };
}

// ------------------------------------------------------------------ pool maths

/** A pool's reserves, named by asset: BNB and the token traded against it. */
export interface Reserves {
  bnb: bigint;
  token: bigint;
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

/** Reserves by asset, from the pair's own order. Null when the pair is not the token's pair with WBNB. */
export function orderReserves(token0: string, token1: string, token: string, reserve0: bigint, reserve1: bigint): Reserves | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (same(token0, WBNB) && same(token1, token)) return { bnb: reserve0, token: reserve1 };
  if (same(token0, token) && same(token1, WBNB)) return { bnb: reserve1, token: reserve0 };
  return null;
}

/** What `liquidity` pool tokens return when burned, rounded down as the pair does. */
export function shareOf(liquidity: bigint, totalSupply: bigint, reserves: Reserves): Reserves {
  if (liquidity <= 0n || totalSupply <= 0n) return { bnb: 0n, token: 0n };
  return { bnb: (liquidity * reserves.bnb) / totalSupply, token: (liquidity * reserves.token) / totalSupply };
}

/** `percent` (1 to 100) of a balance, rounded down; 100 is the whole balance. */
export function portion(balance: bigint, percent: number): bigint {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new RangeError("percent must be 1 to 100");
  return (balance * BigInt(percent)) / 100n;
}

// ------------------------------------------------------------------ display

/**
 * The pool's price in words, whichever way reads better: "1 BNB = 2500 MOON" when one BNB buys at
 * least one whole token, otherwise "1 MOON = 0.02 BNB". Null for an empty pool.
 */
export function rateText(r: Reserves, decimals: number, symbol: string): string | null {
  if (r.bnb <= 0n || r.token <= 0n) return null;
  const perBnb = quote(10n ** BigInt(DECIMALS), r.bnb, r.token);
  if (perBnb >= 10n ** BigInt(decimals)) return `1 ${NATIVE} = ${formatShort(perBnb, 6, decimals)} ${symbol}`;
  return `1 ${symbol} = ${formatShort(quote(10n ** BigInt(decimals), r.token, r.bnb))} ${NATIVE}`;
}

/**
 * Base units as a decimal with at most `places` fraction digits (fewer for a token with fewer
 * decimals), rounded down so the page never shows more than there is. An amount too small to show
 * reads "<0.000001".
 */
export function formatShort(units: bigint, places = 6, decimals = DECIMALS): string {
  if (units <= 0n) return "0";
  places = Math.min(places, decimals);
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
  // A token that refuses to move: locked, paused, or not a plain token.
  [/TransferHelper: TRANSFER_FROM_FAILED|TransferHelper: TRANSFER_FAILED/, "The token refused the transfer."],
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

// ------------------------------------------------------------------ the form

/** BNB, or the chosen token. */
export type Asset = "bnb" | "token";

/** The assets of the two amount fields, first field first: a swap pays the first; adding takes BNB first. */
export function fieldAssets(mode: Mode, pay: Asset): [Asset, Asset] {
  return mode === "swap" && pay === "token" ? ["token", "bnb"] : ["bnb", "token"];
}

/** The other way round: BNB -> token becomes token -> BNB. */
export function flipped(pay: Asset): Asset {
  return pay === "bnb" ? "token" : "bnb";
}

/** What the main button of the swap card says, and whether it can be pressed. */
export function actionFor(s: {
  mode: Mode;
  hasToken: boolean;
  trades: boolean;
  loaded: boolean;
  poolLive: boolean;
  /** "empty" when nothing is typed, "bad" when it is not an amount. */
  amount: "empty" | "bad" | "ok";
  /** The asset there is not enough of, or null. */
  short: string | null;
  /** Pool tokens held, when known. */
  liquidity: bigint | null;
}): { label: string; ready: boolean } {
  if (!s.hasToken) return { label: "Choose a token", ready: false };
  if (!s.trades && s.mode !== "remove") return { label: "Not tradable", ready: false };
  if (s.mode === "remove") {
    if (s.liquidity === 0n) return { label: "No liquidity", ready: false };
    return { label: "Remove liquidity", ready: true };
  }
  if (s.mode === "swap" && s.loaded && !s.poolLive) return { label: "No pool yet", ready: false };
  if (s.amount === "empty") return { label: s.mode === "swap" ? "Enter an amount" : "Enter amounts", ready: false };
  if (s.amount === "bad") return { label: "Check the amount", ready: false };
  if (s.short) return { label: `Not enough ${s.short}`, ready: false };
  if (s.mode === "swap") return { label: "Swap", ready: true };
  return { label: s.poolLive || !s.loaded ? "Add liquidity" : "Open the pool", ready: true };
}

/** A pool share in percent from pool tokens held and in all: "0.25%", "<0.01%", "100%". */
export function sharePercent(liquidity: bigint, totalSupply: bigint): string {
  if (liquidity <= 0n || totalSupply <= 0n) return "0%";
  const bps = (liquidity * 1_000_000n) / totalSupply; // hundredths of a basis point
  if (bps === 0n) return "<0.01%";
  const hundredths = bps / 100n;
  if (hundredths === 0n) return "<0.01%";
  const whole = hundredths / 100n;
  const frac = (hundredths % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}%`;
}

/** A decimal as text with its whole part grouped in threes: 1234567.25 -> 1,234,567.25. */
export function grouped(text: string): string {
  const m = /^(<?)(\d+)(\.\d+)?$/.exec(text);
  if (!m) return text;
  return `${m[1]}${m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${m[3] ?? ""}`;
}

/** formatShort, grouped for reading: at most 2 decimals from 1,000 on, 4 from 1 on, else 6. */
export function formatDisplay(units: bigint, decimals = DECIMALS): string {
  const one = 10n ** BigInt(decimals);
  return grouped(formatShort(units, units >= 1000n * one ? 2 : units >= one ? 4 : 6, decimals));
}

/** The price of one whole token in BNB, or null for an empty pool. */
export function tokenPrice(r: Reserves, decimals: number): bigint | null {
  if (r.bnb <= 0n || r.token <= 0n) return null;
  return quote(10n ** BigInt(decimals), r.token, r.bnb);
}

/** A price in BNB as text: four significant digits below 1 BNB, so a small price never reads 0, cut, never rounded up. */
export function formatPrice(units: bigint): string {
  if (units <= 0n) return "0";
  if (units >= 10n ** BigInt(DECIMALS)) return formatDisplay(units);
  const fraction = units.toString().padStart(DECIMALS, "0");
  const lead = fraction.search(/[1-9]/);
  if (lead >= 12) return "<0.000000000001";
  return `0.${fraction.slice(0, lead + 4).replace(/0+$/, "")}`;
}

/** Every whole number of four digits or more in a text grouped in threes: "1 BNB = 22513.5 MOON" -> "1 BNB = 22,513.5 MOON". */
export function groupedText(text: string): string {
  return text.replace(/(?<![\d.,])\d{4,}(?:\.\d+)?/g, (m) => grouped(m));
}

/** An amount for a field the page fills in itself: at most `places` decimals, cut, unless that would read 0. */
export function fieldAmount(units: bigint, decimals = DECIMALS, places = 6): bigint {
  if (decimals <= places || units <= 0n) return units;
  const step = 10n ** BigInt(decimals - places);
  const cut = units - (units % step);
  return cut > 0n ? cut : units;
}

// ------------------------------------------------------------------ token art

/** The colours a token's monogram is drawn in when it has no logo: brand tints, background then text. */
export const MONOGRAM_TINTS: readonly (readonly [string, string])[] = [
  ["#E6F4FE", "#0B6FDB"],
  ["#DCE9FA", "#0857AD"],
  ["#E8EDF5", "#0A1F3D"],
  ["#E9E8FB", "#3F3AB5"],
  ["#DFF1F6", "#0B6683"],
  ["#EEF1F5", "#4B5F7D"],
];

/** A token's monogram: up to two letters or digits of its symbol, and a tint fixed by the symbol. */
export function monogram(symbol: string): { letters: string; tint: number } {
  const chars = [...symbol.normalize("NFKC").toUpperCase()].filter((c) => /[\p{L}\p{N}]/u.test(c));
  const letters = chars.slice(0, 2).join("") || "?";
  // FNV-1a over the letters as typed, so the same symbol always gets the same tint.
  let hash = 0x811c9dc5;
  for (const c of symbol.trim().toUpperCase()) {
    hash ^= c.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return { letters, tint: hash % MONOGRAM_TINTS.length };
}

/** Where LONGYU's API serves a token's logo; `version` makes a browser ask again after an upload. */
export function logoUrl(apiUrl: string, token: string, version?: string | number): string {
  return `${apiUrl.replace(/\/+$/, "")}/v1/tokens/${token}/logo${version === undefined ? "" : `?v=${encodeURIComponent(String(version))}`}`;
}
