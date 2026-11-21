import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import { jwtVerify, SignJWT } from "jose";
import { dayOf, type RewardParams, type ScheduleParams } from "@longyu/reward-engine";
import type { Config } from "./config.ts";
import type { Db, Queryable } from "./db/index.ts";
import type { AttestationVerifier } from "./services/attestation.ts";
import type { ChainGateway } from "./services/chain.ts";
import type { Captcha, FileStore, Notifier, PushSender, XProvider } from "./services/external.ts";
import type { L1Watch } from "./services/l1.ts";
import type { ChainChecker } from "./services/chain-check.ts";
import type { PaymentChain } from "./services/payments.ts";
import { forbidden, sha256Hex, unauthorized, uuid, type Clock } from "./lib/util.ts";

export interface Deps {
  config: Config;
  db: Db;
  clock: Clock;
  chain: ChainGateway;
  schedule: ScheduleParams;
  /** The reward rules settlement runs, and the estimates shown to miners follow. */
  rewards: RewardParams;
  attestation: AttestationVerifier;
  captcha: Captcha;
  x: XProvider;
  notifier: Notifier;
  push: PushSender;
  files: FileStore;
  /** BSC reader for the payment watcher; absent when payments are not configured. */
  payments?: PaymentChain;
  /** Reader of the batcher's and proposer's gas on the L1; absent when L1_WATCH is not set. */
  l1?: L1Watch;
  /** Reads the state roots posted on the L1 for the phones' chain checks; absent without L1_OUTPUT_ORACLE. */
  chainCheck?: ChainChecker;
}

export interface AuthContext {
  userId: string;
  deviceId: string;
}

export interface UserRow {
  id: string;
  /** X's numeric user id: the account's identity. */
  x_id: string;
  /** The X username seen at the last sign-in; it can change. */
  x_username: string | null;
  /** The X profile picture seen at the last sign-in. */
  avatar_url: string | null;
  handle: string;
  tier: number;
  referral_code: string;
  banned: boolean;
  created_at: bigint;
}

const secret = (config: Config) => new TextEncoder().encode(config.JWT_SECRET);

export async function issueAccessToken(deps: Deps, auth: AuthContext): Promise<string> {
  return new SignJWT({ did: auth.deviceId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(auth.userId)
    .setIssuedAt(Number(deps.clock.now()))
    .setExpirationTime(Number(deps.clock.now()) + deps.config.ACCESS_TOKEN_TTL_SECONDS)
    .setAudience("longyu-api")
    .sign(secret(deps.config));
}

export async function authenticate(deps: Deps, req: FastifyRequest): Promise<AuthContext> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized();
  try {
    const { payload } = await jwtVerify(header.slice(7), secret(deps.config), {
      audience: "longyu-api",
      currentDate: new Date(Number(deps.clock.now()) * 1000),
    });
    if (typeof payload.sub !== "string" || typeof payload.did !== "string") throw unauthorized();
    return { userId: payload.sub, deviceId: payload.did };
  } catch {
    throw unauthorized("invalid_token");
  }
}

export async function loadUser(q: Queryable, userId: string): Promise<UserRow> {
  const { rows } = await q.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
  if (!rows[0]) throw unauthorized("user_not_found");
  return rows[0];
}

export const currentDay = (deps: Deps): bigint => dayOf(deps.schedule, deps.clock.now());

/**
 * The client's exact address. With ORIGIN_SECRET set, every request has already been checked to
 * come through Cloudflare (see app.ts), so Cloudflare's own header is the client; otherwise
 * Fastify's address, which honours TRUST_PROXY.
 */
export function clientAddress(deps: Deps, req: FastifyRequest): string {
  if (deps.config.ORIGIN_SECRET) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && isIP(cf.trim())) return cf.trim();
  }
  return req.ip;
}

/**
 * What a per-address limit counts against. One IPv6 customer holds a whole /64 and can use a new
 * address in it for every request, so IPv6 is cut to its /64 prefix ("2001:db8:1:2::"). IPv4 is
 * kept whole, also when written as IPv6 ("::ffff:203.0.113.7").
 */
export function ipBucket(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [head = "", tail] = ip.split("%")[0]!.toLowerCase().split("::");
  const groups = (part: string): number[] =>
    part === "" ? [] : part.split(":").flatMap((g) => {
      if (!g.includes(".")) return [parseInt(g, 16)];
      // The last 32 bits written as dotted IPv4.
      const [a = 0, b = 0, c = 0, d = 0] = g.split(".").map(Number);
      return [a * 256 + b, c * 256 + d];
    });
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const all = [...left, ...Array<number>(Math.max(0, 8 - left.length - right.length)).fill(0), ...right];
  if (all.length !== 8 || all.some((g) => !(g >= 0 && g <= 0xffff))) return ip;
  if (all.slice(0, 5).every((g) => g === 0) && all[5] === 0xffff) {
    return `${all[6]! >> 8}.${all[6]! & 255}.${all[7]! >> 8}.${all[7]! & 255}`;
  }
  return `${all.slice(0, 4).map((g) => g.toString(16)).join(":")}::`;
}

/** The client's address as limits and records use it: IPv4 whole, IPv6 as its /64 (see ipBucket). */
export function clientIp(deps: Deps, req: FastifyRequest): string {
  return ipBucket(clientAddress(deps, req));
}

/** Blocks mainland China and sanctioned regions, using the CDN's country header. */
export function assertCountryAllowed(deps: Deps, req: FastifyRequest): string | null {
  const country = (req.headers["cf-ipcountry"] as string | undefined)?.toUpperCase() ?? null;
  // Behind Cloudflare every request carries the header; without it the origin was reached directly.
  if (!country && deps.config.REQUIRE_COUNTRY) throw forbidden("region_unknown", "Requests must come through the CDN");
  const blocked = deps.config.BLOCKED_COUNTRIES.split(",").map((c) => c.trim().toUpperCase());
  if (country && blocked.includes(country)) throw forbidden("region_blocked", "LONGYU is not available in your region");
  return country;
}

export async function createChallenge(
  q: Queryable,
  deps: Deps,
  userId: string,
  purpose: "attest" | "siwe" | "session" | "babt",
  pulseRequired = false,
): Promise<{ challengeId: string; nonce: string; expiresAt: bigint }> {
  // One open challenge per user and purpose: asking for a new one cancels the old ones.
  await q.query("UPDATE challenges SET used = TRUE WHERE user_id = $1 AND purpose = $2 AND used = FALSE", [userId, purpose]);
  const id = uuid();
  // SIWE nonces must be alphanumeric.
  const nonce = sha256Hex(id, String(deps.clock.now()), Math.random().toString()).slice(0, 32);
  const expiresAt = deps.clock.now() + 300n;
  await q.query(
    "INSERT INTO challenges (id, user_id, purpose, nonce, pulse_required, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, userId, purpose, nonce, pulseRequired, expiresAt],
  );
  return { challengeId: id, nonce, expiresAt };
}

/** Spends a challenge in one atomic statement: of two concurrent requests, only one can win. */
export async function consumeChallenge(
  q: Queryable,
  deps: Deps,
  userId: string,
  purpose: string,
  match: { id?: string; nonce?: string },
): Promise<{ id: string; nonce: string; pulse_required: boolean; work_bits: number | null; work_output_index: bigint | string | null }> {
  const { rows } = await q.query<{ id: string; nonce: string; pulse_required: boolean; work_bits: number | null; work_output_index: bigint | string | null }>(
    `UPDATE challenges SET used = TRUE
     WHERE ${match.id ? "id" : "nonce"} = $1 AND user_id = $2 AND purpose = $3 AND used = FALSE AND expires_at >= $4
     RETURNING id, nonce, pulse_required, work_bits, work_output_index`,
    [match.id ?? match.nonce, userId, purpose, deps.clock.now()],
  );
  if (!rows[0]) throw forbidden("challenge_invalid");
  return rows[0];
}

export async function setTier(
  q: Queryable,
  deps: Deps,
  userId: string,
  toTier: number,
  reason: string,
): Promise<void> {
  const user = await loadUser(q, userId);
  if (user.tier === toTier) return;
  await q.query("UPDATE users SET tier = $1 WHERE id = $2", [toTier, userId]);
  await q.query(
    "INSERT INTO tier_events (id, user_id, from_tier, to_tier, reason, day, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [uuid(), userId, user.tier, toTier, reason, currentDay(deps), deps.clock.now()],
  );
}
