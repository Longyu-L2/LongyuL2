/**
 * Token metadata read from the token contracts themselves. Names and symbols are chosen by whoever
 * deploys a token, so they are untrusted: control and bidirectional-override characters are
 * stripped here (they can disguise one token as another), lengths are capped, and every page
 * escapes them again when rendering.
 */
import { decodeAbiParameters, hexToString, type Hex } from "viem";
import type { Db } from "./db.ts";
import { hex, type Rpc } from "./rpc.ts";

const SELECTORS = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd" } as const;
/**
 * Gas each of these reads may use. A real token answers in a few thousand; without a limit of its
 * own a call may spend all the gas the node allows one, and a contract that loops in `name()` would
 * hold the node for seconds every time it is asked.
 */
const READ_GAS = 100_000;
const read = (to: string, data: string) => ({ method: "eth_call", params: [{ to, data, gas: hex(READ_GAS) }, "latest"] });

/** Control, zero-width, bidirectional-override and BOM characters, built from code points. */
const range = (a: number, b: number) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
const INVISIBLE = new RegExp(
  `[${range(0x00, 0x1f)}${range(0x7f, 0x9f)}${range(0x200b, 0x200f)}${range(0x2028, 0x202e)}${range(0x2060, 0x2069)}${range(0xfeff, 0xfeff)}]`,
  "g",
);

export function cleanText(s: string, max = 48): string {
  return s
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** An ABI string, or a bytes32 string as some older tokens return. */
export function decodeTextResult(data: Hex | null | undefined): string | null {
  if (!data || data === "0x") return null;
  try {
    return cleanText(decodeAbiParameters([{ type: "string" }], data)[0]) || null;
  } catch {
    if (data.length === 66) return cleanText(hexToString(data as Hex, { size: 32 }).replace(/\u0000+$/, "")) || null;
    return null;
  }
}

export function decodeUintResult(data: Hex | null | undefined): bigint | null {
  if (!data || data.length !== 66) return null;
  return BigInt(data);
}

/**
 * Reads and stores each token's name, symbol and decimals. A call the contract refuses, or runs
 * out of gas in, is an answer (many tokens have no name), and the token is marked as read. A request
 * the node does not answer throws: that token and those after it stay unread, for
 * Indexer.retryMetadata to read later.
 */
export async function refreshTokenMetadata(db: Db, rpc: Rpc, addresses: string[]): Promise<void> {
  for (const address of addresses) {
    const [name, symbol, decimals] = await rpc.batchSettled<Hex>([read(address, SELECTORS.name), read(address, SELECTORS.symbol), read(address, SELECTORS.decimals)]);
    const d = decimals?.ok ? decodeUintResult(decimals.value) : null;
    await db.query("UPDATE tokens SET name = $2, symbol = $3, decimals = $4, metadata_at = now() WHERE address = $1", [
      address,
      name?.ok ? decodeTextResult(name.value) : null,
      symbol?.ok ? decodeTextResult(symbol.value) : null,
      d !== null && d <= 77n ? Number(d) : null,
    ]);
  }
}

/** Live total supply, or null if the contract does not answer. */
export async function totalSupply(rpc: Rpc, token: string): Promise<bigint | null> {
  const [r] = await rpc.batchSettled<Hex>([read(token, SELECTORS.totalSupply)]);
  return r?.ok ? decodeUintResult(r.value) : null;
}
