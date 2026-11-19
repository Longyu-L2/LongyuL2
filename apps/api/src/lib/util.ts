import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, message?: string) => new HttpError(400, code, message);
export const unauthorized = (code = "unauthorized") => new HttpError(401, code);
export const forbidden = (code: string, message?: string) => new HttpError(403, code, message);
export const notFound = (code = "not_found") => new HttpError(404, code);
export const conflict = (code: string, message?: string) => new HttpError(409, code, message);
export const tooMany = (code: string, message?: string) => new HttpError(429, code, message);

/** True for the database's "duplicate key" error (Postgres code 23505). */
export const isUniqueViolation = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "23505";

export interface Clock {
  /** Unix seconds. */
  now(): bigint;
}

export const systemClock: Clock = { now: () => BigInt(Math.floor(Date.now() / 1000)) };

export const uuid = (): string => randomUUID();

export function sha256Hex(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p).update("\u0000");
  return h.digest("hex");
}

/** Plain SHA-256 of a string, hex. Used for admin keys: `echo -n KEY | sha256sum`. */
export const sha256PlainHex = (value: string): string => createHash("sha256").update(value).digest("hex");

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  // Buffer.from stops at the first character that is not hex, so a malformed value decodes short.
  if (x.length !== y.length || x.length * 2 !== a.length) return false;
  return timingSafeEqual(x, y);
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/** Letters and digits without look-alikes, for codes people type. */
export function humanCode(length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < length; i++) s += alphabet[randomInt(0, alphabet.length)];
  return s;
}

/** JSON replacer: bigint as decimal string. */
export const jsonSafe = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));

export const toBig = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  throw new Error(`not a number: ${String(v)}`);
};
