/**
 * Pure helpers for the launch page (tested under Node): settings, the rules LONGYU Launch checks
 * before it makes a token, and the new token read back from the receipt.
 *
 * LONGYU Launch is TokenLauncher (contracts/src/TokenLauncher.sol). It makes a plain ERC-20 with 18
 * decimals and mints the whole, fixed supply to the account that launched it. The token has no owner
 * and no settings, and the launcher takes no fee: a launch costs gas only.
 */
import { getAddress, parseEventLogs, type Address, type Log } from "viem";
import { errorMessage, parseAddress, parseUrl } from "./bridge-core.ts";
import { WBNB, launcherAbi, logoApi, passesForLongyu } from "./swap-core.ts";

/** TokenLauncher's limits: MAX_NAME_BYTES, MAX_SYMBOL_BYTES, MIN_SUPPLY and MAX_SUPPLY. */
export const MAX_NAME = 32;
export const MAX_SYMBOL = 11;
export const MIN_SUPPLY = 1n;
export const MAX_SUPPLY = 10n ** 15n;

// ------------------------------------------------------------------ configuration

/** Build-time values (build.mjs); empty strings when unset. */
export interface RawLaunchConfig {
  launcher?: string | null;
  rpcUrl?: string | null;
  explorerUrl?: string | null;
  /** The swap page is built, so the new token can link to it. */
  swapPage?: boolean | null;
  /** LONGYU's API, which keeps token logos (optional). */
  apiUrl?: string | null;
}

export interface LaunchConfig {
  launcher: Address;
  rpcUrl: string;
  /** LONGYU explorer base URL without a trailing slash; null when not configured. */
  explorerUrl: string | null;
  swapPage: boolean;
  /** LONGYU's API without a trailing slash; null when logos cannot be set or shown. */
  apiUrl: string | null;
}

export type LaunchConfigResult = { ok: true; config: LaunchConfig } | { ok: false; problems: string[] };

/** Checks every build-time value. The launcher's address is never guessed: a missing or bad one closes the page. */
export function parseLaunchConfig(raw: RawLaunchConfig | null | undefined): LaunchConfigResult {
  const r = raw ?? {};
  const problems: string[] = [];
  const launcher = parseAddress(r.launcher);
  if (!(r.launcher ?? "").trim()) problems.push("TOKEN_LAUNCHER is missing");
  else if (!launcher) problems.push("TOKEN_LAUNCHER is not a valid address");
  else if (launcher === WBNB) problems.push("TOKEN_LAUNCHER is the wrapped BNB contract");
  const rpcUrl = parseUrl(r.rpcUrl);
  if (!(r.rpcUrl ?? "").trim()) problems.push("L2_RPC_URL is missing");
  else if (!rpcUrl) problems.push("L2_RPC_URL is not an https URL");
  let explorerUrl: string | null = null;
  if ((r.explorerUrl ?? "").trim()) {
    explorerUrl = parseUrl(r.explorerUrl)?.replace(/\/+$/, "") ?? null;
    if (!explorerUrl) problems.push("EXPLORER_URL is not an https URL");
  }
  if (problems.length || !launcher || !rpcUrl) return { ok: false, problems };
  return { ok: true, config: { launcher, rpcUrl, explorerUrl, swapPage: r.swapPage === true, apiUrl: logoApi(r.apiUrl) } };
}

// ------------------------------------------------------------------ the form

export const RESERVED = "That passes for LONGYU's own token. Choose another.";

/** Why TokenLauncher would refuse the name, or null: 1 to 32 printable ASCII characters, no space at either end. */
export function nameProblem(name: string): string | null {
  if (name === "") return "Enter a name.";
  if (/[^\x20-\x7e]/.test(name)) return "Use plain letters, digits, spaces and punctuation.";
  if (name.length > MAX_NAME) return `Use at most ${MAX_NAME} characters.`;
  if (name.startsWith(" ") || name.endsWith(" ")) return "Remove the space at the start or end.";
  return null;
}

/** Why TokenLauncher would refuse the symbol, or null: 1 to 11 letters and digits. */
export function symbolProblem(symbol: string): string | null {
  if (symbol === "") return "Enter a symbol.";
  if (/[^A-Za-z0-9]/.test(symbol)) return "Use letters and digits only.";
  if (symbol.length > MAX_SYMBOL) return `Use at most ${MAX_SYMBOL} characters.`;
  return null;
}

/** The supply in whole tokens, from digits with optional commas between groups, or why it cannot be one. */
export function parseSupply(text: string): { ok: true; wholeTokens: bigint } | { ok: false; error: string } {
  const v = text.trim();
  if (!v) return { ok: false, error: "Enter the supply." };
  if (!/^\d+$/.test(v) && !/^\d{1,3}(,\d{3})+$/.test(v)) return { ok: false, error: "Use whole numbers only." };
  const wholeTokens = BigInt(v.replace(/,/g, ""));
  if (wholeTokens < MIN_SUPPLY) return { ok: false, error: "At least 1 token." };
  if (wholeTokens > MAX_SUPPLY) return { ok: false, error: `At most ${formatWhole(MAX_SUPPLY)} tokens.` };
  return { ok: true, wholeTokens };
}

export type Field = "name" | "symbol" | "supply";
export interface Launch {
  name: string;
  symbol: string;
  wholeTokens: bigint;
}

/**
 * The launch as TokenLauncher.launch takes it, or what is wrong with each field. The name and symbol
 * are sent as typed: the contract checks them as they are. One that passes for LONGYU's token is
 * refused here as the contract would refuse it, on the field that does.
 */
export function checkLaunch(form: { name: string; symbol: string; supply: string }): { ok: true; launch: Launch } | { ok: false; problems: Partial<Record<Field, string>> } {
  const problems: Partial<Record<Field, string>> = {};
  const name = nameProblem(form.name);
  const symbol = symbolProblem(form.symbol);
  const supply = parseSupply(form.supply);
  if (name) problems.name = name;
  if (symbol) problems.symbol = symbol;
  if (!supply.ok) problems.supply = supply.error;
  if (!name && passesForLongyu({ name: form.name, symbol: null })) problems.name = RESERVED;
  if (!symbol && passesForLongyu({ name: null, symbol: form.symbol })) problems.symbol = RESERVED;
  if (Object.keys(problems).length || !supply.ok) return { ok: false, problems };
  return { ok: true, launch: { name: form.name, symbol: form.symbol, wholeTokens: supply.wholeTokens } };
}

// ------------------------------------------------------------------ the result

/** The token a launch made, from the launcher's TokenLaunched event for `creator`; null when the receipt has none. */
export function launchedToken(logs: readonly Log[], launcher: Address, creator: Address): Address | null {
  const own = logs.filter((l) => l.address.toLowerCase() === launcher.toLowerCase());
  const events = parseEventLogs({ abi: launcherAbi, eventName: "TokenLaunched", logs: own as Log[] });
  const mine = events.find((e) => e.args.creator.toLowerCase() === creator.toLowerCase());
  return mine ? getAddress(mine.args.token) : null;
}

/** Where the new token is shown: its explorer page, and the swap page set to add its first liquidity. */
export function tokenLinks(cfg: Pick<LaunchConfig, "explorerUrl" | "swapPage">, token: Address): { explorer: string | null; addLiquidity: string | null } {
  return {
    explorer: cfg.explorerUrl ? `${cfg.explorerUrl}/token/${token}` : null,
    addLiquidity: cfg.swapPage ? `./swap.html?token=${token}&mode=add` : null,
  };
}

/**
 * The supply field as it is typed, grouped in threes (1000000 -> 1,000,000), and where the caret goes:
 * after the same digit it followed. Text that is not digits and commas is left as typed, so its problem shows.
 */
export function formatSupplyInput(text: string, caret: number): { value: string; caret: number } {
  if (!/^[\d,]*$/.test(text)) return { value: text, caret };
  const digits = text.replace(/,/g, "");
  const value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const before = text.slice(0, caret).replace(/,/g, "").length;
  let at = 0;
  for (let seen = 0; at < value.length && seen < before; at++) if (value[at] !== ",") seen++;
  return { value, caret: at };
}

/** Whole tokens grouped in threes: 1,000,000. */
export function formatWhole(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const REFUSALS: [RegExp, string][] = [
  [/\bBadName\b/, `Names are 1 to ${MAX_NAME} plain characters, with no space at the start or end.`],
  [/\bBadSymbol\b/, `Symbols are 1 to ${MAX_SYMBOL} letters and digits.`],
  [/\bBadSupply\b/, `The supply is 1 to ${formatWhole(MAX_SUPPLY)} tokens.`],
  [/\bReservedName\b/, RESERVED],
];

/** A short message for the page; the launcher's refusals are put in plain words. */
export function launchErrorMessage(e: unknown): string {
  let text = "";
  for (let cur = e as { shortMessage?: unknown; message?: unknown; data?: { errorName?: unknown }; cause?: unknown } | undefined, i = 0; cur && typeof cur === "object" && i < 8; cur = cur.cause as typeof cur, i++) {
    text += ` ${String(cur.shortMessage ?? "")} ${String(cur.message ?? "")} ${String(cur.data?.errorName ?? "")}`;
  }
  const short = errorMessage(e);
  if (short === "Cancelled in your wallet.") return short;
  for (const [pattern, message] of REFUSALS) if (pattern.test(text)) return message;
  return short;
}

// ------------------------------------------------------------------ logos

/** What LONGYU's API takes as a token's logo. */
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_MIN_SIDE = 64;
export const LOGO_MAX_SIDE = 1024;

/** The image kind from the file's first bytes, whatever its name or stated type says. */
export function logoKind(bytes: Uint8Array): (typeof LOGO_TYPES)[number] | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** Why a chosen file cannot be a logo, before it is decoded: its kind and its size. */
export function logoFileProblem(bytes: Uint8Array): string | null {
  if (!logoKind(bytes)) return "Use a PNG, JPEG or WebP image.";
  if (bytes.length > LOGO_MAX_BYTES) return "Use an image of at most 256 KB.";
  return null;
}

/** Why an image's size in pixels cannot be a logo's. */
export function logoSizeProblem(width: number, height: number): string | null {
  if (width < LOGO_MIN_SIDE || height < LOGO_MIN_SIDE) return `Use an image at least ${LOGO_MIN_SIDE} × ${LOGO_MIN_SIDE} px.`;
  if (width > LOGO_MAX_SIDE || height > LOGO_MAX_SIDE) return `Use an image at most ${LOGO_MAX_SIDE} × ${LOGO_MAX_SIDE} px.`;
  return null;
}

/** Bytes as base64, the way the API takes the image. */
export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Bytes as lower-case hex, without 0x. */
export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * What the token's creator signs (personal_sign) to set its logo: the token's checksummed address,
 * LONGYU's chain id and the SHA-256 of the image's bytes in lower-case hex.
 */
export function logoMessage(token: Address, chainId: number, sha256Hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error("the image digest must be 64 lower-case hex digits");
  return `LONGYU token logo
Token: ${getAddress(token)}
Chain: ${chainId}
Image: sha256:${sha256Hex}`;
}

const LOGO_REFUSALS: Record<string, string> = {
  logo_invalid: `Use a PNG, JPEG or WebP image, at most 256 KB and ${LOGO_MIN_SIDE} to ${LOGO_MAX_SIDE} px on each side.`,
  signature_invalid: "The signature does not match. Try again.",
  not_creator: "Only the account that launched the token can set its logo.",
  not_launched: "That token was not made with LONGYU Launch.",
  rate_limited: "Too many tries. Wait a minute and try again.",
};

/** A short message for a refused upload, from the API's answer ({ error, message }). */
export function logoErrorMessage(status: number, body: unknown): string {
  const code = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (typeof code === "string" && Object.hasOwn(LOGO_REFUSALS, code)) return LOGO_REFUSALS[code]!;
  if (status === 429) return LOGO_REFUSALS.rate_limited!;
  if (status >= 500) return "The logo service is busy. Try again.";
  return "The logo was not saved. Try again.";
}
