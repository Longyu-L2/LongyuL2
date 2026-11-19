/**
 * Daily settlement: after a UTC day closes, compute everyone's rewards with the reward engine,
 * persist the new ledger and proofs, and publish the day's data file. Posting the root on-chain
 * is the publisher's job.
 */
import { getAddress } from "viem";
import {
  applyDay,
  proofMap,
  settleDay,
  type AccountState,
  type Address,
  type LedgerState,
  type MinerInput,
  type Tier,
} from "@longyu/reward-engine";
import { currentDay, setTier, type Deps } from "../context.ts";
import type { Queryable } from "../db/index.ts";
import { toBig } from "../lib/util.ts";
import { runRiskRules } from "./risk.ts";

/** Wait this long after midnight so late requests and risk checks finish first. */
export const SETTLE_GRACE_SECONDS = 15n * 60n;
const T3_MIN_SESSIONS = 60n;

async function loadLedger(q: Queryable): Promise<LedgerState> {
  const meta = (await q.query<{ last_settled_day: bigint | null }>("SELECT last_settled_day FROM ledger_meta WHERE id = 1")).rows[0];
  const rows = (await q.query<{
    address: string; cumulative: string; claimed: string; pending: { day: string; amount: string }[];
    verified: boolean; frozen: boolean; reserve: { to: string | null; amount: string } | null;
  }>("SELECT address, cumulative::text, claimed::text, pending, verified, frozen, reserve FROM ledger_accounts")).rows;
  const accounts = new Map<Address, AccountState>();
  for (const r of rows) {
    accounts.set(r.address as Address, {
      cumulative: toBig(r.cumulative),
      claimed: toBig(r.claimed),
      pending: r.pending.map((p) => ({ day: BigInt(p.day), amount: BigInt(p.amount) })),
      verified: r.verified,
      frozen: r.frozen,
      reserve: r.reserve ? { to: (r.reserve.to as Address | null), amount: BigInt(r.reserve.amount) } : undefined,
    });
  }
  return { lastSettledDay: meta?.last_settled_day ?? null, accounts };
}

async function saveLedger(q: Queryable, ledger: LedgerState): Promise<void> {
  const entries = [...ledger.accounts.entries()];
  for (let i = 0; i < entries.length; i += 500) {
    const chunk = entries.slice(i, i + 500);
    const params: unknown[] = [];
    const values = chunk.map(([addr, a], j) => {
      params.push(addr, a.cumulative.toString(), a.claimed.toString(),
        JSON.stringify(a.pending.map((p) => ({ day: p.day.toString(), amount: p.amount.toString() }))), a.verified, a.frozen,
        a.reserve ? JSON.stringify({ to: a.reserve.to, amount: a.reserve.amount.toString() }) : null);
      const b = j * 7;
      return `($${b + 1},$${b + 2}::numeric,$${b + 3}::numeric,$${b + 4}::jsonb,$${b + 5},$${b + 6},$${b + 7}::jsonb)`;
    });
    await q.query(
      `INSERT INTO ledger_accounts (address, cumulative, claimed, pending, verified, frozen, reserve) VALUES ${values.join(",")}
       ON CONFLICT (address) DO UPDATE SET cumulative = EXCLUDED.cumulative, claimed = EXCLUDED.claimed,
       pending = EXCLUDED.pending, verified = EXCLUDED.verified, frozen = EXCLUDED.frozen, reserve = EXCLUDED.reserve`,
      params,
    );
  }
  await q.query("UPDATE ledger_meta SET last_settled_day = $1 WHERE id = 1", [ledger.lastSettledDay]);
}

/** Content-addressed name of a day's data file: it never changes once written. */
export function rootFilePath(day: bigint, dataHash: string): string {
  if (!/^0x[0-9a-f]{64}$/.test(dataHash)) throw new Error("invalid data hash");
  return `roots/day-${day}-${dataHash.slice(2, 18)}.json`;
}

/** Settles the next closed day if it is due. Returns the day settled, or null. */
export async function settleNextDay(deps: Deps): Promise<bigint | null> {
  const meta = (await deps.db.query<{ last_settled_day: bigint | null }>("SELECT last_settled_day FROM ledger_meta WHERE id = 1")).rows[0];
  const day = meta?.last_settled_day == null ? 0n : meta.last_settled_day + 1n;
  const now = deps.clock.now();
  if (now < deps.schedule.startTime) return null;
  const dayEnd = deps.schedule.startTime + (day + 1n) * 86_400n;
  if (now < dayEnd + SETTLE_GRACE_SECONDS || day >= currentDay(deps)) return null;

  await runRiskRules(deps, day);

  const [config, roots] = await Promise.all([deps.chain.readDistributorConfig(), deps.chain.readRoots()]);
  const reference = roots.pending ?? roots.active;

  const ledger = await loadLedger(deps.db);

  const rebind = (await deps.db.query<{ from_address: string; to_address: string }>(
    "SELECT from_address, to_address FROM wallet_changes WHERE effective_day = $1 ORDER BY created_at",
    [day],
  )).rows.map((r) => ({ from: getAddress(r.from_address) as Address, to: getAddress(r.to_address) as Address }));
  const movedTo = new Map(rebind.map((r) => [r.from, r.to]));
  const payee = (address: string): Address => {
    let a = getAddress(address) as Address;
    for (let hops = 0; movedTo.has(a) && hops < 10; hops++) a = movedTo.get(a)!;
    return a;
  };

  // Each session pays the wallet linked when it started; a wallet changed later that day pays forward.
  const sessions = (await deps.db.query<{ user_id: string; tier: number; address: string; streak_days: number | null; held: boolean; boost_bps: number }>(
    `SELECT m.user_id, u.tier, COALESCE(m.wallet_address, w.address) AS address, s.streak_days,
            EXISTS (SELECT 1 FROM flags f WHERE f.user_id = m.user_id AND f.status = 'open' AND f.severity = 'hold') AS held,
            -- A paid boost covering this mining day (see boosts.ts); boosts never overlap.
            COALESCE((SELECT max(b.boost_bps) FROM mining_boosts b WHERE b.user_id = m.user_id AND b.cancelled_at IS NULL
                      AND b.start_day <= $1 AND b.end_day > $1), 0)::int AS boost_bps
     FROM mining_sessions m
     JOIN users u ON u.id = m.user_id
     JOIN wallets w ON w.user_id = m.user_id
     LEFT JOIN streaks s ON s.user_id = m.user_id
     WHERE m.credited_day = $1 AND NOT u.banned`,
    [day],
  )).rows;
  const miners: MinerInput[] = sessions.map((s) => ({
    account: payee(s.address),
    tier: Math.min(Math.max(s.tier, 0), 3) as Tier,
    streakDays: s.streak_days ?? 0,
    activeVerifiedInvites: 0,
    contributionBps: 0,
    held: s.held,
    boostBps: s.boost_bps,
  }));

  const verifiedToday = (await deps.db.query<{ address: string }>(
    `SELECT DISTINCT w.address FROM tier_events t JOIN wallets w ON w.user_id = t.user_id
     WHERE t.day = $1 AND t.to_tier >= 2 AND t.from_tier < 2`,
    [day],
  )).rows.map((r) => getAddress(r.address) as Address);

  // A ban covers every address the user has ever had.
  const forfeit = (await deps.db.query<{ address: string }>(
    `SELECT w.address FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.banned_day = $1
     UNION SELECT c.from_address FROM users u JOIN wallet_changes c ON c.user_id = u.id WHERE u.banned_day = $1
     UNION SELECT c.to_address FROM users u JOIN wallet_changes c ON c.user_id = u.id WHERE u.banned_day = $1`,
    [day],
  )).rows.map((r) => getAddress(r.address) as Address);

  // What each address can still claim from roots that are, or may become, claimable on-chain.
  const liveDays = [roots.active?.day, roots.pending?.day].filter((d): d is bigint => d !== undefined);
  const liveLeaves = new Map<Address, bigint>();
  if (liveDays.length) {
    const live = (await deps.db.query<{ address: string; cumulative: string }>(
      "SELECT address, max(cumulative)::text AS cumulative FROM proofs WHERE day = ANY($1::bigint[]) GROUP BY address",
      [liveDays],
    )).rows;
    for (const r of live) liveLeaves.set(getAddress(r.address) as Address, toBig(r.cumulative));
  }

  const claimed = new Map<Address, bigint>(
    (await deps.db.query<{ address: string; cumulative: string }>("SELECT address, cumulative::text FROM claimed_onchain")).rows.map(
      (r) => [getAddress(r.address) as Address, toBig(r.cumulative)],
    ),
  );

  const out = settleDay(ledger, {
    day,
    schedule: deps.schedule,
    params: deps.rewards,
    chain: {
      chainId: deps.chain.chainId,
      distributor: deps.chain.distributor,
      maxRewardPerDay: config.maxRewardPerDay,
      maxDailyIncrease: config.maxDailyIncrease,
      referenceRoot: reference ? { day: reference.day, totalEntitled: reference.totalEntitled } : null,
      claimed,
      liveLeaves,
    },
    miners,
    verifiedToday,
    forfeit,
    rebind,
  });

  const filePath = rootFilePath(day, out.dataHash);
  const uri = out.root ? deps.files.url(filePath) : null;
  const minedUsers = new Set(sessions.map((s) => s.user_id));
  const proofs = out.tree ? proofMap(out.tree) : new Map<Address, { amount: bigint; proof: string[] }>();

  // Stored before the commit, so a committed settlement always has its file. The name carries the
  // content hash: a retried run writes identical bytes, a run that later fails leaves an unused file.
  if (out.root) await deps.files.put(filePath, out.dataJson);

  await deps.db.tx(async (q) => {
    await saveLedger(q, out.ledger);
    await q.query(
      `INSERT INTO settlements (day, root, total_entitled, data_hash, data_uri, stats, status, created_at)
       VALUES ($1,$2,$3::numeric,$4,$5,$6,$7,$8)`,
      [day, out.root, out.totalEntitled.toString(), out.dataHash, uri,
        JSON.stringify(out.stats, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
        out.root ? "computed" : "empty", deps.clock.now()],
    );
    const proofRows = [...proofs.entries()];
    for (let i = 0; i < proofRows.length; i += 500) {
      const params: unknown[] = [];
      const values = proofRows.slice(i, i + 500).map(([addr, p], j) => {
        params.push(day, getAddress(addr), p.amount.toString(), JSON.stringify(p.proof));
        return `($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3}::numeric,$${j * 4 + 4}::jsonb)`;
      });
      await q.query(`INSERT INTO proofs (day, address, cumulative, proof) VALUES ${values.join(",")}`, params);
    }
    // Keep proofs for every root that is or may become claimable; drop older ones.
    const keepFrom = liveDays.length ? liveDays.reduce((a, b) => (a < b ? a : b)) : day;
    await q.query("DELETE FROM proofs WHERE day < $1", [keepFrom]);

    // Streaks: every user who mined, or who still has a streak or grace days to lose.
    const streakRows = (await q.query<{ user_id: string; streak_days: number; grace_banked: number; consecutive: number; last_applied_day: bigint | null }>(
      `SELECT user_id, streak_days, grace_banked, consecutive, last_applied_day FROM streaks
       WHERE (streak_days > 0 OR grace_banked > 0 OR user_id = ANY($1::uuid[])) AND (last_applied_day IS NULL OR last_applied_day < $2)`,
      [[...minedUsers], day],
    )).rows;
    for (const r of streakRows) {
      const next = applyDay({ streakDays: r.streak_days, graceBanked: r.grace_banked, consecutive: r.consecutive }, minedUsers.has(r.user_id));
      await q.query(
        "UPDATE streaks SET streak_days = $1, grace_banked = $2, consecutive = $3, last_applied_day = $4 WHERE user_id = $5",
        [next.streakDays, next.graceBanked, next.consecutive, day, r.user_id],
      );
    }

    // T3: verified, 60+ mining days, and no hold flags ever confirmed or open.
    const promote = (await q.query<{ id: string }>(
      `SELECT u.id FROM users u WHERE u.tier = 2 AND NOT u.banned
       AND (SELECT count(*) FROM mining_sessions m WHERE m.user_id = u.id) >= $1
       AND NOT EXISTS (SELECT 1 FROM flags f WHERE f.user_id = u.id AND f.severity = 'hold' AND f.status IN ('open','confirmed'))`,
      [T3_MIN_SESSIONS],
    )).rows;
    for (const p of promote) await setTier(q, deps, p.id, 3, "trusted");
  });
  if (out.stats.alerts.length) console.warn(`settlement day ${day} alerts:`, out.stats.alerts);
  return day;
}
