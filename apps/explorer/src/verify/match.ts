/**
 * Does compiled bytecode equal the code on the chain? Bytes are compared one for one, with only
 * these positions set aside, all of them taken from the compiler's own output:
 *  - immutables, which the compiler leaves as zeros and the constructor fills in;
 *  - a library's own address, which it writes over the zeros in its first instruction when deployed;
 *  - for a partial match, the hash of the contract's metadata file at the end of its code, which
 *    changes with a comment or a file name and never with what the code does.
 * Nothing is set aside because it looks like a metadata hash: a constant in the source can be made
 * to look like one. Only the hash the compiler itself appended to this contract is, and a contract
 * cannot name that hash in its own source.
 * Lower-case hex without the 0x throughout.
 */
export type MatchKind = "full" | "partial";

export interface Range {
  start: number;
  length: number;
}

const HEX = /^(?:[0-9a-f]{2})*$/;

/** The key and the length of the hash that opens the compiler's metadata: IPFS (0.6 and later), Swarm v1 (0.5.9 on), Swarm v0 (before). */
const HASHES = [
  { key: Buffer.from("64697066735822", "hex"), length: 34 },
  { key: Buffer.from("65627a7a72315820", "hex"), length: 32 },
  { key: Buffer.from("65627a7a72305820", "hex"), length: 32 },
];

/**
 * The compiler ends a contract's code with a small CBOR map and that map's length in two bytes.
 * Returns where the map starts and where the metadata hash is inside the code, or null when the
 * code does not end that way.
 */
function metadata(code: Buffer): { start: number; hash: Range } | null {
  if (code.length < 4) return null;
  const end = code.length - 2;
  const start = end - code.readUInt16BE(end);
  // A map of one to four entries.
  if (start < 0 || code[start]! < 0xa1 || code[start]! > 0xa4) return null;
  for (const h of HASHES) {
    const at = start + 1 + h.key.length;
    if (at + h.length <= end && code.subarray(start + 1, at).equals(h.key)) return { start, hash: { start: at, length: h.length } };
  }
  return null;
}

function blank(code: Buffer, ranges: Range[]): boolean {
  for (const r of ranges) {
    if (!Number.isInteger(r.start) || !Number.isInteger(r.length) || r.start < 0 || r.length < 0 || r.start + r.length > code.length) return false;
    code.fill(0, r.start, r.start + r.length);
  }
  return true;
}

/** A deployed library starts with PUSH20 <its own address> ADDRESS EQ; the compiler writes 20 zeros there. */
function libraryAddress(compiled: Buffer, onchain: Buffer, address: string): Range[] {
  const zeros = compiled.subarray(1, 21).every((b) => b === 0);
  const library = compiled.length > 23 && compiled[0] === 0x73 && zeros && compiled[21] === 0x30 && compiled[22] === 0x14;
  return library && onchain.subarray(1, 21).toString("hex") === address ? [{ start: 1, length: 20 }] : [];
}

export interface MatchOptions {
  /** The address the code is at, 40 hex digits. */
  address: string;
  /**
   * Whether a difference in the metadata hash alone still counts. False when the compiler was told
   * not to append its metadata: the end of the code is then the contract's own.
   */
  partial: boolean;
}

/** The code at an address against the compiler's runtime code. Null when they differ, or when the compiled code still has unlinked libraries in it. */
export function matchRuntime(onchain: string, compiled: string, immutables: Range[], options: MatchOptions): MatchKind | null {
  if (!HEX.test(onchain) || !HEX.test(compiled) || compiled.length === 0 || onchain.length !== compiled.length) return null;
  const a = Buffer.from(onchain, "hex");
  const b = Buffer.from(compiled, "hex");
  const filled = [...immutables, ...libraryAddress(b, a, options.address)];
  if (!blank(a, filled) || !blank(b, filled)) return null;
  if (a.equals(b)) return "full";
  const appended = options.partial ? metadata(b) : null;
  if (!appended || !blank(a, [appended.hash]) || !blank(b, [appended.hash])) return null;
  return a.equals(b) ? "partial" : null;
}

/**
 * The input of the transaction that created a contract against the compiler's creation code. The
 * input is that code followed by the constructor's arguments, which are returned. `runtime` is the
 * compiler's runtime code for the same contract: the creation code carries a copy of it, metadata
 * included, and for a partial match the hash is set aside in that copy and nowhere else.
 */
export function matchCreation(input: string, compiled: string, runtime: string, options: Pick<MatchOptions, "partial">): { kind: MatchKind; args: string } | null {
  if (!HEX.test(input) || !HEX.test(compiled) || !HEX.test(runtime) || compiled.length === 0 || input.length < compiled.length) return null;
  const args = input.slice(compiled.length);
  const head = input.slice(0, compiled.length);
  if (head === compiled) return { kind: "full", args };
  if (!options.partial) return null;
  const a = Buffer.from(head, "hex");
  const b = Buffer.from(compiled, "hex");
  const code = Buffer.from(runtime, "hex");
  const appended = metadata(code);
  if (!appended) return null;
  const map = code.subarray(appended.start);
  const hashes: Range[] = [];
  for (let at = b.indexOf(map); at !== -1; at = b.indexOf(map, at + 1)) hashes.push({ start: at + (appended.hash.start - appended.start), length: appended.hash.length });
  if (hashes.length === 0 || !blank(a, hashes) || !blank(b, hashes)) return null;
  return a.equals(b) ? { kind: "partial", args } : null;
}
