import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { getAddress, isAddress } from "viem";
import { SESSION_LENGTH, checkSessionStart, weightOf, type Address, type Tier } from "@longyu/reward-engine";
import { clientAddress, clientIp, assertCountryAllowed, authenticate, consumeChallenge, createChallenge, currentDay, loadUser, type Deps, type UserRow } from "../context.ts";
import type { Queryable } from "../db/index.ts";
import { badRequest, conflict, forbidden, notFound, toBig, uuid } from "../lib/util.ts";
import { ATTESTATION_MAX_AGE } from "./auth.ts";
import { assertDeviceNotLocked, assertWebMiningOn, loadDevice, recordAttestationFailure, tokenLooksValid } from "./device-wallet.ts";
import type { AttestOutcome } from "../services/attestation.ts";
import { boostOn } from "../boosts.ts";
import { SETTLE_GRACE_SECONDS } from "../jobs/settlement.ts";
import type { RootInfo } from "../services/chain.ts";

/** One session in seven needs a human check. */
const PULSE_ONE_IN = 7n;

/** Deterministic per user and day: HMAC(secret, user|day) decides, so re-rolling is pointless. */
export function pulseRequired(deps: Deps, userId: string, day: bigint): boolean {
  const secret = deps.config.PULSE_SECRET || `pulse:${deps.config.JWT_SECRET}`;
  const mac = createHmac("sha256", secret).update(`${userId}|${day}`).digest("hex");
  return BigInt(`0x${mac.slice(0, 12)}`) % PULSE_ONE_IN === 0n;
}

interface LastSession {
  started_at: bigint;
  credited_day: bigint;
}

async function lastSession(q: Queryable, userId: string): Promise<LastSession | undefined> {
  const { rows } = await q.query<LastSession>(
    "SELECT started_at, credited_day FROM mining_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1",
    [userId],
  );
  return rows[0];
}

async function sessionState(q: Queryable, deps: Deps, userId: string) {
  const last = await lastSession(q, userId);
  return checkSessionStart(
    { lastStart: last?.started_at ?? null, lastCreditedDay: last?.credited_day ?? null },
    deps.clock.now(),
    deps.schedule.startTime,
  );
}

/** The settled numbers of an address, from the ledger, the active root's proofs and the indexer. */
async function settled(deps: Deps, address: string, activeDay: bigint | null) {
  const [ledger, onchain, proof] = await Promise.all([
    deps.db.query<{ cumulative: string; pending: { amount: string }[] }>(
      "SELECT cumulative, pending FROM ledger_accounts WHERE address = $1",
      [address],
    ),
    deps.db.query<{ cumulative: string }>("SELECT cumulative FROM claimed_onchain WHERE address = $1", [address]),
    activeDay === null
      ? undefined
      : deps.db.query<{ cumulative: string }>("SELECT cumulative FROM proofs WHERE day = $1 AND address = $2", [activeDay, address]),
  ]);
  const entitled = ledger.rows[0] ? toBig(ledger.rows[0].cumulative) : 0n;
  const claimed = onchain.rows[0] ? toBig(onchain.rows[0].cumulative) : 0n;
  const inRoot = proof?.rows[0] ? toBig(proof.rows[0].cumulative) : 0n;
  return {
    entitled,
    claimed,
    claimable: inRoot > claimed ? inRoot - claimed : 0n,
    /** Held off-chain until the account reaches the entitled tier. */
    backlog: (ledger.rows[0]?.pending ?? []).reduce((s, p) => s + BigInt(p.amount), 0n),
  };
}

/** The settlement and the publisher each run once a minute: a closed day's root is posted within this long of being due. */
const POSTING_ALLOWANCE = 120n;

interface LatestStats {
  budget: string;
  totalWeight: string;
  scaled: boolean;
}

/** The newest settlement's totals; estimates are scaled the way that day was. */
async function latestStats(q: Queryable): Promise<LatestStats | undefined> {
  return (await q.query<{ stats: LatestStats }>("SELECT stats FROM settlements ORDER BY day DESC LIMIT 1")).rows[0]?.stats;
}

/** What one session credited to `day` is expected to earn, counted exactly as settlement will count it. */
async function estimateFor(deps: Deps, user: UserRow, streakDays: number, day: bigint, latest: LatestStats | undefined) {
  // That day's paid capacity counts as settlement will count it.
  const boostBps = await boostOn(deps.db, user.id, day);
  const weight = user.banned
    ? 0n
    : weightOf(deps.rewards, {
        account: "0x0000000000000000000000000000000000000000",
        tier: Math.min(Math.max(user.tier, 0), 3) as Tier,
        streakDays,
        activeVerifiedInvites: 0,
        contributionBps: 0,
        held: false,
        boostBps,
      });
  const perDay = latest?.scaled ? (weight * BigInt(latest.budget)) / BigInt(latest.totalWeight) : weight;
  return { perDay, boostBps };
}

/**
 * A miner's rewards as one set of numbers that always add up: earned = claimed + claimable + pending.
 *
 * - claimable: what the active root pays the wallet now.
 * - pending: everything earned that cannot be claimed yet. Settled rewards waiting for their root,
 *   rewards held until the account reaches the entitled tier, and an estimate for sessions whose
 *   day is not settled yet. The estimate grows with the session and is replaced by the real amount
 *   at settlement.
 * - accrual: the running session's part of pending is still growing at this rate until `until`.
 *   A client adds perHour for the time passed since `at` to pending and earned.
 * - unlock: when pending rewards can next be claimed, or null when no time is known (rewards held
 *   until the entitled tier, or settled rewards whose root is not posted). It is exact for rewards
 *   in a posted root, whose veto window ends then. For a day that is not settled yet it is the
 *   time the schedule gives, which a late settlement or a vetoed root moves.
 */
export async function rewardsOf(
  deps: Deps,
  user: UserRow,
  address: string,
  roots: Roots,
  outlook?: { streakDays: number; latest: LatestStats | undefined },
) {
  const now = deps.clock.now();
  const [s, inPosted, open, view] = await Promise.all([
    settled(deps, address, roots.active?.day ?? null),
    roots.pending
      ? deps.db.query<{ cumulative: string }>("SELECT cumulative FROM proofs WHERE day = $1 AND address = $2", [roots.pending.day, address])
          .then((r) => (r.rows[0] ? toBig(r.rows[0].cumulative) : 0n))
      : 0n,
    deps.db.query<{ started_at: bigint; credited_day: bigint }>(
      `SELECT started_at, credited_day FROM mining_sessions
       WHERE user_id = $1 AND credited_day > COALESCE((SELECT max(day) FROM settlements), -1) ORDER BY started_at`,
      [user.id],
    ),
    outlook ?? Promise.all([streakOf(deps.db, user.id), latestStats(deps.db)]).then(([streak, latest]) => ({ streakDays: streak.streak_days, latest })),
  ]);
  let mining = 0n;
  let accrual: { perHour: bigint; until: bigint } | null = null;
  for (const session of open.rows) {
    const { perDay } = await estimateFor(deps, user, view.streakDays, session.credited_day, view.latest);
    const elapsed = now - session.started_at;
    mining += elapsed >= SESSION_LENGTH ? perDay : (perDay * elapsed) / SESSION_LENGTH;
    accrual = elapsed < SESSION_LENGTH && perDay > 0n ? { perHour: perDay / 24n, until: session.started_at + SESSION_LENGTH } : null;
  }
  const paidOrPayable = s.claimed + s.claimable;
  const waiting = s.entitled > paidOrPayable ? s.entitled - paidOrPayable : 0n;
  const pending = waiting + s.backlog + mining;
  let unlock: { at: bigint; exact: boolean } | null = null;
  if (roots.challengeDelay !== null) {
    const cleared = roots.pending ? roots.pending.postedAt + roots.challengeDelay : 0n;
    if (inPosted > paidOrPayable) unlock = { at: cleared, exact: true };
    else if (waiting === 0n && open.rows.length > 0 && !user.banned && user.tier >= deps.rewards.entitledFromTier) {
      const day = open.rows.reduce((d, r) => (r.credited_day < d ? r.credited_day : d), open.rows[0]!.credited_day);
      const due = deps.schedule.startTime + (day + 1n) * 86_400n + SETTLE_GRACE_SECONDS + POSTING_ALLOWANCE;
      // A root is posted only once the one before it has cleared its window.
      unlock = { at: (due > cleared ? due : cleared) + roots.challengeDelay, exact: false };
    }
    if (unlock && unlock.at <= now) unlock = null;
  }
  return {
    earned: s.claimed + s.claimable + pending,
    claimed: s.claimed,
    claimable: s.claimable,
    pending,
    /** The settled entitlement on the ledger, which roots are built from. */
    entitled: s.entitled,
    accrual,
    unlock,
    at: now,
  };
}

async function streakOf(q: Queryable, userId: string): Promise<{ streak_days: number; grace_banked: number }> {
  return (await q.query<{ streak_days: number; grace_banked: number }>(
    "SELECT streak_days, grace_banked FROM streaks WHERE user_id = $1",
    [userId],
  )).rows[0] ?? { streak_days: 0, grace_banked: 0 };
}

export function registerMining(app: FastifyInstance, deps: Deps): void {
  app.post("/v1/mining/challenge", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const auth = await authenticate(deps, req);
    assertCountryAllowed(deps, req);
    const user = await loadUser(deps.db, auth.userId);
    if (user.banned) throw forbidden("account_restricted");
    if (user.tier < 1) throw forbidden("device_not_attested");
    const wallet = await deps.db.query("SELECT 1 FROM wallets WHERE user_id = $1", [auth.userId]);
    if (!wallet.rows[0]) throw forbidden("wallet_required");
    const device = await loadDevice(deps.db, auth.userId, auth.deviceId);
    assertWebMiningOn(deps, device);
    assertDeviceNotLocked(deps, device);
    if (!device.attested_at || deps.clock.now() - device.attested_at > ATTESTATION_MAX_AGE) throw forbidden("device_not_attested");
    const state = await sessionState(deps.db, deps, auth.userId);
    if (!state.ok) throw conflict("session_not_available", `Next session at ${state.nextAllowedAt}`);
    // Decided once per user and day, so asking for new challenges cannot skip the human check.
    // A browser cannot prove its device, so it passes the human check at every session.
    const pulse = device.platform === "web" || pulseRequired(deps, auth.userId, state.creditedDay);
    const c = await createChallenge(deps.db, deps, auth.userId, "session", pulse);
    return { challengeId: c.challengeId, nonce: c.nonce, pulseRequired: pulse, expiresAt: c.expiresAt };
  });

  app.post("/v1/mining/start", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const auth = await authenticate(deps, req);
    assertCountryAllowed(deps, req);
    const body = z
      .object({ challengeId: z.uuid(), attestationToken: z.string().min(4).max(20_000).optional(), captchaToken: z.string().max(4000).optional() })
      .parse(req.body);
    const now = deps.clock.now();
    const user = await loadUser(deps.db, auth.userId);
    if (user.banned) throw forbidden("account_restricted");
    const device = await loadDevice(deps.db, auth.userId, auth.deviceId);
    assertWebMiningOn(deps, device);
    assertDeviceNotLocked(deps, device);
    // Only a browser starts a session without a device proof.
    if (device.platform !== "web" && body.attestationToken === undefined) throw badRequest("attestation_required");
    // Spent in its own committed statement: a failed attempt cannot be retried with it.
    const challenge = await consumeChallenge(deps.db, deps, auth.userId, "session", { id: body.challengeId });
    if (!device.attested_at || now - device.attested_at > ATTESTATION_MAX_AGE) throw forbidden("device_not_attested");

    // Vendor checks run outside any transaction and every failure is committed before replying.
    let proof: AttestOutcome;
    if (device.platform === "web") {
      // A browser has no device proof to give; the human check below stands in for it.
      proof = { ok: true };
    } else {
      const token = body.attestationToken ?? "";
      proof = tokenLooksValid(token)
        ? await deps.attestation.assert({
            platform: device.platform,
            token,
            nonce: challenge.nonce,
            device: { keyId: device.attestation_key_id, publicKey: device.attestation_public_key, signCount: device.attestation_sign_count },
          })
        : { ok: false, reason: "malformed token" };
    }
    if (!proof.ok) {
      await recordAttestationFailure(deps, auth.deviceId);
      throw forbidden("attestation_failed", proof.reason);
    }
    if ((challenge.pulse_required || device.platform === "web") && !(body.captchaToken && (await deps.captcha.verify(body.captchaToken, clientAddress(deps, req))))) {
      throw forbidden("pulse_failed", "Human check failed");
    }

    return deps.db.tx(async (q) => {
      if (proof.signCount !== undefined) {
        // App Attest counters only move forward; a lower value means a replayed assertion.
        const upd = await q.query(
          "UPDATE devices SET attestation_sign_count = $1 WHERE id = $2 AND attestation_sign_count < $1 RETURNING id",
          [proof.signCount, auth.deviceId],
        );
        if (!upd.rows[0]) throw forbidden("attestation_failed", "assertion counter did not increase");
      }
      const wallet = (await q.query<{ address: string }>("SELECT address FROM wallets WHERE user_id = $1", [auth.userId])).rows[0];
      if (!wallet) throw forbidden("wallet_required");
      const state = await sessionState(q, deps, auth.userId);
      if (!state.ok) throw conflict("session_not_available", state.reason);
      await q.query(
        `INSERT INTO mining_sessions (id, user_id, device_id, started_at, credited_day, ip, pulse_passed, wallet_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uuid(), auth.userId, auth.deviceId, now, state.creditedDay, clientIp(deps, req), challenge.pulse_required, wallet.address],
      );
      await q.query("UPDATE devices SET last_seen_at = $1, attestation_failures = 0 WHERE id = $2", [now, auth.deviceId]);
      return { startedAt: now, endsAt: now + 86_400n, creditedDay: state.creditedDay };
    });
  });

  app.get("/v1/mining/status", async (req) => {
    const auth = await authenticate(deps, req);
    const [user, last, streak, wallet, latest, roots] = await Promise.all([
      loadUser(deps.db, auth.userId),
      lastSession(deps.db, auth.userId),
      streakOf(deps.db, auth.userId),
      deps.db.query<{ address: string }>("SELECT address FROM wallets WHERE user_id = $1", [auth.userId]).then((r) => r.rows[0]),
      latestStats(deps.db),
      rootsNow(deps),
    ]);
    const state = checkSessionStart(
      { lastStart: last?.started_at ?? null, lastCreditedDay: last?.credited_day ?? null },
      deps.clock.now(),
      deps.schedule.startTime,
    );
    const { perDay, boostBps } = await estimateFor(deps, user, streak.streak_days, currentDay(deps), latest);
    return {
      day: currentDay(deps),
      tier: user.tier,
      streakDays: streak.streak_days,
      graceDays: streak.grace_banked,
      session: last ? { startedAt: last.started_at, endsAt: last.started_at + 86_400n, creditedDay: last.credited_day } : null,
      canStart: state.ok,
      nextAllowedAt: state.ok ? null : state.nextAllowedAt,
      estimatedPerHour: perDay / 24n,
      boostBps,
      estimate: "Based on yesterday's participation; the final amount is fixed at settlement.",
      balances: wallet ? await rewardsOf(deps, user, wallet.address, roots, { streakDays: streak.streak_days, latest }) : null,
    };
  });

  // ---------------------------------------------------------------- rewards

  app.get("/v1/rewards", async (req) => {
    const auth = await authenticate(deps, req);
    const [user, wallet, roots] = await Promise.all([
      loadUser(deps.db, auth.userId),
      deps.db.query<{ address: string }>("SELECT address FROM wallets WHERE user_id = $1", [auth.userId]).then((r) => r.rows[0]),
      rootsNow(deps),
    ]);
    if (!wallet) throw forbidden("wallet_required");
    const [rewards, claims] = await Promise.all([
      rewardsOf(deps, user, wallet.address, roots),
      deps.db.query(
        "SELECT id, status, cumulative, tx_hash, created_at FROM claims WHERE address = $1 ORDER BY created_at DESC LIMIT 20",
        [wallet.address],
      ),
    ]);
    return { address: wallet.address, activeRootDay: roots.active?.day ?? null, ...rewards, claims: claims.rows };
  });

  /** Public: the proof anyone needs to claim directly from the contract, even without LONGYU. */
  app.get("/v1/rewards/proof/:address", async (req) => {
    const { address } = z.object({ address: z.string() }).parse(req.params);
    if (!isAddress(address)) throw badRequest("address_invalid");
    const day = await activeRootDay(deps);
    if (day === null) throw notFound("no_active_root");
    const row = (await deps.db.query<{ cumulative: string; proof: string[] }>(
      "SELECT cumulative, proof FROM proofs WHERE day = $1 AND address = $2",
      [day, getAddress(address)],
    )).rows[0];
    if (!row) throw notFound("no_entitlement");
    return {
      chainId: deps.config.CHAIN_ID,
      distributor: deps.chain.distributor,
      day,
      account: getAddress(address),
      cumulativeAmount: row.cumulative,
      proof: row.proof,
    };
  });

  app.post("/v1/rewards/claim", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const auth = await authenticate(deps, req);
    if ((await loadUser(deps.db, auth.userId)).banned) throw forbidden("account_restricted");
    const wallet = (await deps.db.query<{ address: Address }>("SELECT address FROM wallets WHERE user_id = $1", [auth.userId])).rows[0];
    if (!wallet) throw forbidden("wallet_required");
    const activeDay = await activeRootDay(deps);
    const b = await settled(deps, wallet.address, activeDay);
    if (b.claimable === 0n) throw conflict("nothing_to_claim");
    const now = deps.clock.now();
    const existing = (await deps.db.query<{ id: string }>(
      "SELECT id FROM claims WHERE address = $1 AND status IN ('queued','sent')",
      [wallet.address],
    )).rows[0];
    if (existing) return { claimId: existing.id, status: "already_queued" };
    const id = uuid();
    await deps.db.query(
      "INSERT INTO claims (id, user_id, address, status, created_at, updated_at) VALUES ($1,$2,$3,'queued',$4,$4)",
      [id, auth.userId, wallet.address, now],
    );
    return { claimId: id, status: "queued", amount: b.claimable };
  });
}

/** The distributor's roots, and how long a posted root waits before it pays (null if that could not be read). */
interface Roots {
  active: RootInfo | null;
  pending: RootInfo | null;
  challengeDelay: bigint | null;
}

let rootCache: { at: number; roots: Roots } | null = null;

/**
 * The roots on-chain, cached for 15 seconds. Once a posted root's window has ended it is read again
 * within a second, so a claim opens at the time the rewards answer gave for it.
 */
async function rootsNow(deps: Deps): Promise<Roots> {
  const held = rootCache?.roots;
  const due = held?.pending && held.challengeDelay !== null && deps.clock.now() >= held.pending.postedAt + held.challengeDelay;
  if (rootCache && Date.now() - rootCache.at < (due ? 1_000 : 15_000)) return rootCache.roots;
  const [roots, challengeDelay] = await Promise.all([
    deps.chain.readRoots(),
    // Only the unlock time needs it: the balances are answered without it.
    deps.chain.readDistributorConfig().then((c) => c.challengeDelay, () => null),
  ]);
  rootCache = { at: Date.now(), roots: { ...roots, challengeDelay } };
  return rootCache.roots;
}

/** Day of the claimable root on-chain. */
export async function activeRootDay(deps: Deps): Promise<bigint | null> {
  return (await rootsNow(deps)).active?.day ?? null;
}

export function clearRootCache(): void {
  rootCache = null;
}
