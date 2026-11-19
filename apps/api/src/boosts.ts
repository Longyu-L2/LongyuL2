/**
 * Paid mining boosts. A verified miner buys a plan (for example +50% for 30 days), pays it in real
 * USDT or BNB through PaymentRouter on BSC, and from the day the payment is final their sessions
 * weigh more in the daily settlement. The day's emission is fixed, so a boost raises the buyer's
 * share of it and never creates tokens. A user's boosts run back to back, never overlapping.
 */
import { SECONDS_PER_DAY } from "@longyu/reward-engine";
import type { Deps } from "./context.ts";
import type { Queryable } from "./db/index.ts";
import { SETTLE_GRACE_SECONDS } from "./jobs/settlement.ts";
import { toBig, uuid } from "./lib/util.ts";

export interface BoostPlan {
  id: string;
  /** Weight increase in bps: 2500 = +25%. At most 10000 (+100%), the reward engine's cap. */
  boostBps: number;
  days: number;
  /** Payment token symbol, one of PAYMENT_TOKENS. */
  token: string;
  /** Price as a decimal string in the token's units, e.g. "9" or "4.99". */
  price: string;
}

/** Parses "id:bps:days:SYMBOL:price", comma-separated. Throws on anything malformed. */
export function parseBoostPlans(spec: string): BoostPlan[] {
  const plans = spec.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [id, bps, days, token, price, ...rest] = entry.split(":");
    if (rest.length || !id || !bps || !days || !token || !price) throw new Error(`BOOST_PLANS: "${entry}" is not id:bps:days:TOKEN:price`);
    if (!/^[a-z0-9-]{2,24}$/.test(id)) throw new Error(`BOOST_PLANS: bad id "${id}"`);
    const boostBps = Number(bps);
    if (!Number.isInteger(boostBps) || boostBps < 1 || boostBps > 10_000) throw new Error(`BOOST_PLANS: ${id} boost must be 1 to 10000 bps`);
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error(`BOOST_PLANS: ${id} must last 1 to 365 days`);
    if (!/^[A-Z0-9]{2,10}$/.test(token)) throw new Error(`BOOST_PLANS: ${id} has a bad token symbol`);
    if (!/^\d{1,12}(\.\d{1,18})?$/.test(price) || !/[1-9]/.test(price)) throw new Error(`BOOST_PLANS: ${id} has a bad price`);
    return { id, boostBps, days: n, token, price };
  });
  if (new Set(plans.map((p) => p.id)).size !== plans.length) throw new Error("BOOST_PLANS lists a plan twice");
  return plans;
}

/** Mining day of a timestamp, clamped to day 0 before mining starts. */
function dayAt(deps: Deps, timestamp: bigint): bigint {
  const t = timestamp - deps.schedule.startTime;
  return t <= 0n ? 0n : t / SECONDS_PER_DAY;
}

/**
 * Starts the boost a paid order bought, once: from the day it was paid, or the first day not yet
 * settled if that is later, or after the user's last boost if one is still running. Does nothing
 * for other products or an already-activated order.
 */
export async function activateBoost(q: Queryable, deps: Deps, orderRef: string, paidAt: bigint): Promise<void> {
  const o = (await q.query<{ product: string; user_id: string | null; boost_bps: number | null; boost_days: number | null }>(
    "SELECT product, user_id, boost_bps, boost_days FROM orders WHERE id = $1",
    [orderRef],
  )).rows[0];
  if (!o || o.product !== "mining_boost" || !o.user_id || !o.boost_bps || !o.boost_days) return;
  if ((await q.query("SELECT 1 FROM mining_boosts WHERE order_id = $1", [orderRef])).rows[0]) return;
  // Serialise a user's activations so queued boosts never overlap.
  await q.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [o.user_id]);
  const last = (await q.query<{ end_day: bigint | null }>(
    "SELECT max(end_day) AS end_day FROM mining_boosts WHERE user_id = $1 AND cancelled_at IS NULL",
    [o.user_id],
  )).rows[0]?.end_day ?? null;
  // A payment can be read after its day was settled (finality, an outage, an order held in review).
  // Rewards for a settled day are fixed, so a boost starting there would lose those days: it starts
  // on the first day still open, after the last settled day and any day whose settlement may be running.
  const settled = (await q.query<{ last_settled_day: bigint | null }>("SELECT last_settled_day FROM ledger_meta WHERE id = 1")).rows[0]?.last_settled_day ?? null;
  const days = [dayAt(deps, paidAt), settled === null ? 0n : toBig(settled) + 1n, dayAt(deps, deps.clock.now() - SETTLE_GRACE_SECONDS), last === null ? 0n : toBig(last)];
  const start = days.reduce((a, b) => (b > a ? b : a));
  await q.query(
    "INSERT INTO mining_boosts (id, user_id, order_id, boost_bps, start_day, end_day, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [uuid(), o.user_id, orderRef, o.boost_bps, start, start + BigInt(o.boost_days), deps.clock.now()],
  );
}

/**
 * Withdraws a refunded boost: a boost not yet begun is cancelled; a running one ends today, so
 * today's and later sessions are no longer boosted. Days already settled stay as they were.
 */
export async function withdrawBoost(q: Queryable, deps: Deps, orderRef: string): Promise<void> {
  const b = (await q.query<{ id: string; start_day: bigint; end_day: bigint }>(
    "SELECT id, start_day, end_day FROM mining_boosts WHERE order_id = $1 AND cancelled_at IS NULL FOR UPDATE",
    [orderRef],
  )).rows[0];
  if (!b) return;
  const today = dayAt(deps, deps.clock.now());
  if (today <= b.start_day) {
    await q.query("UPDATE mining_boosts SET cancelled_at = $2 WHERE id = $1", [b.id, deps.clock.now()]);
  } else if (today < b.end_day) {
    await q.query("UPDATE mining_boosts SET end_day = $2 WHERE id = $1", [b.id, today]);
  }
}

/** The boost (bps) active for a user on a mining day, or 0. */
export async function boostOn(q: Queryable, userId: string, day: bigint): Promise<number> {
  const r = (await q.query<{ bps: number | null }>(
    "SELECT max(boost_bps) AS bps FROM mining_boosts WHERE user_id = $1 AND cancelled_at IS NULL AND start_day <= $2 AND end_day > $2",
    [userId, day],
  )).rows[0];
  return r?.bps ?? 0;
}
