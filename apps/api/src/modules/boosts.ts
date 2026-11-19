/**
 * Mining boosts for app users: the plans on sale, the user's boosts and open orders, and buying one.
 * A purchase is an order paid on BSC through PaymentRouter; the payment watcher starts the boost.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { formatUnits, parseUnits } from "viem";
import { SECONDS_PER_DAY } from "@longyu/reward-engine";
import { parseBoostPlans, type BoostPlan } from "../boosts.ts";
import { assertCountryAllowed, authenticate, loadUser, type Deps } from "../context.ts";
import { badRequest, forbidden, toBig, tooMany, uuid } from "../lib/util.ts";
import { paymentConfig, type PaymentConfig } from "../services/payments.ts";
import { instructions, newOrder } from "./payments.ts";

/** Open boost orders a user may hold at once. */
const MAX_OPEN_ORDERS = 3;
/** How long an unpaid boost order stays payable. */
const ORDER_TTL_SECONDS = 86_400n;
/** Boosts can be bought up to a year ahead. */
const MAX_QUEUED_DAYS = 365n;

/** Why a tier cannot buy capacity yet: it has to be earning into its entitlement first. */
const notEntitled = (tier: number, deps: Deps): "device_not_attested" | "verify_first" | null =>
  tier >= deps.rewards.entitledFromTier ? null : tier < 1 ? "device_not_attested" : "verify_first";

const today = (deps: Deps) => {
  const t = deps.clock.now() - deps.schedule.startTime;
  return t <= 0n ? 0n : t / SECONDS_PER_DAY;
};

export function registerBoosts(app: FastifyInstance, deps: Deps): void {
  const plans = parseBoostPlans(deps.config.BOOST_PLANS);
  const tokenOf = (cfg: PaymentConfig, symbol: string) => cfg.tokens.find((t) => t.symbol === symbol);
  const payUrl = (orderId: string) => `${deps.config.PAY_PAGE_URL}?order=${orderId}`;

  app.get("/v1/boosts", async (req) => {
    const auth = await authenticate(deps, req);
    const cfg = paymentConfig(deps.config);
    const user = await loadUser(deps.db, auth.userId);
    const day = today(deps);
    const boosts = (await deps.db.query<{ boost_bps: number; start_day: bigint; end_day: bigint }>(
      `SELECT boost_bps, start_day, end_day FROM mining_boosts
       WHERE user_id = $1 AND cancelled_at IS NULL AND end_day > $2 ORDER BY start_day`,
      [auth.userId, day],
    )).rows;
    const orders = cfg
      ? (await deps.db.query<{ order_id: string; boost_plan: string; boost_bps: number; boost_days: number; token: string; amount: string; status: string; expires_at: bigint; pay_ref: string | null }>(
          `SELECT order_id, boost_plan, boost_bps, boost_days, token, amount::text, status, expires_at, pay_ref FROM orders
           WHERE user_id = $1 AND product = 'mining_boost' AND (status IN ('open', 'review') OR created_at > $2)
           ORDER BY created_at DESC LIMIT 10`,
          [auth.userId, deps.clock.now() - 7n * 86_400n],
        )).rows
      : [];
    return {
      available: Boolean(cfg) && plans.length > 0,
      eligible: !user.banned && user.tier >= deps.rewards.entitledFromTier,
      reason: user.banned ? "account_restricted" : notEntitled(user.tier, deps),
      today: day,
      plans: cfg ? plans.filter((p) => tokenOf(cfg, p.token)) : [],
      current: boosts.find((b) => b.start_day <= day) ?? null,
      upcoming: boosts.filter((b) => b.start_day > day),
      orders: orders.map((o) => {
        const t = cfg!.tokens.find((x) => x.address === o.token);
        const payable = o.status === "open" && deps.clock.now() <= o.expires_at && o.pay_ref !== null;
        return {
          orderId: o.order_id,
          plan: o.boost_plan,
          boostBps: o.boost_bps,
          days: o.boost_days,
          token: t?.symbol ?? o.token,
          amount: toBig(o.amount),
          amountDisplay: t ? formatUnits(toBig(o.amount), t.decimals) : o.amount,
          status: o.status,
          expiresAt: o.expires_at,
          payUrl: payable ? payUrl(o.order_id) : null,
          pay: payable ? instructions(cfg!, o.pay_ref!, o.token, toBig(o.amount)) : null,
        };
      }),
    };
  });

  app.post("/v1/boosts/orders", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const auth = await authenticate(deps, req);
    assertCountryAllowed(deps, req);
    const { plan: planId } = z.object({ plan: z.string().max(40) }).parse(req.body);
    const cfg = paymentConfig(deps.config);
    if (!cfg) throw forbidden("payments_unavailable");
    const plan: BoostPlan | undefined = plans.find((p) => p.id === planId);
    const token = plan && tokenOf(cfg, plan.token);
    if (!plan || !token) throw badRequest("unknown_plan");

    return deps.db.tx(async (q) => {
      // One purchase at a time per user, so the limits below cannot be raced.
      await q.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [auth.userId]);
      const user = await loadUser(q, auth.userId);
      if (user.banned) throw forbidden("account_restricted");
      const gate = notEntitled(user.tier, deps);
      if (gate) throw forbidden(gate, gate === "verify_first" ? "Verify your account to buy a mining boost" : undefined);
      const now = deps.clock.now();
      const open = (await q.query<{ n: bigint }>(
        "SELECT count(*)::bigint AS n FROM orders WHERE user_id = $1 AND status = 'open' AND expires_at >= $2",
        [auth.userId, now],
      )).rows[0]!.n;
      if (open >= BigInt(MAX_OPEN_ORDERS)) throw tooMany("too_many_open_orders", "Pay or let your open boost orders expire first");
      const lastEnd = (await q.query<{ end_day: bigint | null }>(
        "SELECT max(end_day) AS end_day FROM mining_boosts WHERE user_id = $1 AND cancelled_at IS NULL",
        [auth.userId],
      )).rows[0]?.end_day ?? null;
      const from = lastEnd !== null && lastEnd > today(deps) ? lastEnd : today(deps);
      if (from + BigInt(plan.days) - today(deps) > MAX_QUEUED_DAYS) throw badRequest("boost_queue_full", "Boosts can be bought up to a year ahead");

      const amount = parseUnits(plan.price, token.decimals);
      const { ref, orderId } = newOrder(cfg, token.address, amount);
      const expiresAt = now + ORDER_TTL_SECONDS;
      await q.query(
        `INSERT INTO orders (id, order_id, pay_ref, customer, product, description, token, amount, created_by, created_at, expires_at,
                             user_id, boost_plan, boost_bps, boost_days)
         VALUES ($1,$2,$13,$3,'mining_boost',$4,$5,$6::numeric,'app',$7,$8,$9,$10,$11,$12)`,
        [uuid(), orderId, user.handle, `LONGYU Mining Capacity ${plan.id.split("-")[0]!.toUpperCase()}: ${(1 + plan.boostBps / 10_000).toFixed(2)}× for ${plan.days} days`, token.address, amount.toString(),
          now, expiresAt, auth.userId, plan.id, plan.boostBps, plan.days, ref],
      );
      return {
        orderId,
        plan: plan.id,
        boostBps: plan.boostBps,
        days: plan.days,
        token: token.symbol,
        amount,
        amountDisplay: formatUnits(amount, token.decimals),
        expiresAt,
        payUrl: payUrl(orderId),
        pay: instructions(cfg, ref, token.address, amount),
      };
    });
  });
}
