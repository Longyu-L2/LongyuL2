/**
 * Payment watcher. Reads OrderPaid events from the configured PaymentRouter on BSC, only up to the
 * newest final block, and activates each order at most once. Anything unexpected (wrong token,
 * underpaid, paid after expiry, unknown or closed order, treasury changed) is recorded and the
 * order goes to admin review instead. A paid mining-boost order starts its boost (see boosts.ts).
 */
import { getAddress } from "viem";
import type { Deps } from "../context.ts";
import { toBig, uuid } from "../lib/util.ts";
import { paymentConfig, type RouterLog } from "../services/payments.ts";
import { activateBoost } from "../boosts.ts";

/** Blocks per log query; small enough for common RPC providers' eth_getLogs limits. */
export const LOG_RANGE = 1_000n;
/** Ranges read per run while catching up. */
const MAX_RANGES_PER_RUN = 20;

export type PaymentOutcome = "activated" | "underpaid" | "wrong_token" | "late" | "unknown_order" | "not_open" | "wrong_treasury";

interface Notice {
  subject: string;
  body: string;
}

/** Runs the watcher until it reaches the final block or the per-run limit. Returns payments recorded. */
export async function watchPayments(deps: Deps): Promise<number> {
  const cfg = paymentConfig(deps.config);
  if (!cfg || !deps.payments) return 0;
  const safe = await deps.payments.safeBlock();
  let recorded = 0;
  for (let i = 0; i < MAX_RANGES_PER_RUN; i++) {
    const step = await watchRange(deps, safe);
    if (step === null) break;
    recorded += step;
  }
  return recorded;
}

/** Reads one range and commits it with the cursor. Null when already at the final block. */
async function watchRange(deps: Deps, safe: bigint): Promise<number | null> {
  const cfg = paymentConfig(deps.config)!;
  const cur = (await deps.db.query<{ last_block: bigint; treasury: string | null }>(
    "SELECT last_block, treasury FROM payment_cursor WHERE router = $1",
    [cfg.router],
  )).rows[0];
  const last = cur ? cur.last_block : cfg.startBlock - 1n;
  if (last >= safe) return null;
  const to = safe < last + LOG_RANGE ? safe : last + LOG_RANGE;
  const logs = await deps.payments!.routerLogs(cfg.router, last + 1n, to);
  for (const l of logs) if (l.block <= last || l.block > to) throw new Error("payment log outside the requested range");

  const notices: Notice[] = [];
  const now = deps.clock.now();
  const recorded = await deps.db.tx(async (q) => {
    let treasury = cur?.treasury ? getAddress(cur.treasury) : null;
    let count = 0;
    for (const log of logs as RouterLog[]) {
      if (log.kind === "treasury") {
        treasury = getAddress(log.treasury);
        if (treasury !== cfg.treasury) {
          notices.push({
            subject: "URGENT: payment router treasury changed",
            body: [
              `The PaymentRouter at ${cfg.router} now forwards payments to ${treasury}, not ${cfg.treasury}.`,
              `Transaction: ${log.txHash} (block ${log.block}).`,
              "Pause the router with the guardian unless this change was planned, then update TREASURY_ADDRESS.",
            ].join("\n"),
          });
        }
        continue;
      }
      const order = (await q.query<{ id: string; status: string; token: string; amount: string; expires_at: bigint; customer: string }>(
        "SELECT id, status, token, amount::text, expires_at, customer FROM orders WHERE order_id = $1 FOR UPDATE",
        [log.orderId.toLowerCase()],
      )).rows[0];
      const outcome: PaymentOutcome =
        treasury === null || treasury !== cfg.treasury
          ? "wrong_treasury"
          : !order
            ? "unknown_order"
            : order.status !== "open"
              ? "not_open"
              : getAddress(order.token) !== getAddress(log.token)
                ? "wrong_token"
                : log.amount < toBig(order.amount)
                  ? "underpaid"
                  : log.blockTime > order.expires_at
                    ? "late"
                    : "activated";
      const paymentId = uuid();
      const ins = await q.query<{ id: string }>(
        `INSERT INTO payments (id, chain_id, router, tx_hash, log_index, block_number, block_time, order_id, order_ref, payer, token,
                               amount, treasury, outcome, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::numeric,$13,$14,$15)
         ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING RETURNING id`,
        [paymentId, cfg.chainId, cfg.router, log.txHash.toLowerCase(), log.logIndex, log.block, log.blockTime, log.orderId.toLowerCase(),
          order?.id ?? null, getAddress(log.payer), getAddress(log.token), log.amount.toString(), treasury, outcome, now],
      );
      if (!ins.rows[0]) continue; // already recorded by an earlier run
      count++;
      if (order && order.status === "open") {
        // Exactly once: only an open order changes, and only this payment can close it.
        if (outcome === "activated") {
          await q.query("UPDATE orders SET status = 'paid', paid_at = $2, payment_id = $3 WHERE id = $1 AND status = 'open'", [
            order.id, log.blockTime, paymentId,
          ]);
          // A mining boost starts on the day it was paid (or after the buyer's current boost).
          await activateBoost(q, deps, order.id, log.blockTime);
        } else {
          await q.query("UPDATE orders SET status = 'review', review_reason = $2, payment_id = $3 WHERE id = $1 AND status = 'open'", [
            order.id, outcome, paymentId,
          ]);
        }
      }
      notices.push({
        subject: outcome === "activated" ? `Order paid: ${order?.customer}` : `Payment needs review (${outcome})`,
        body: [`Outcome: ${outcome}`, `Order: ${log.orderId}`, `Customer: ${order?.customer ?? "unknown"}`, `Token: ${log.token}`,
          `Amount (wei): ${log.amount}`, `Transaction: ${log.txHash}`].join("\n"),
      });
    }
    const moved = await q.query(
      `INSERT INTO payment_cursor (router, last_block, treasury) VALUES ($1,$2,$3)
       ON CONFLICT (router) DO UPDATE SET last_block = $2, treasury = $3 WHERE payment_cursor.last_block = $4
       RETURNING router`,
      [cfg.router, to, treasury, last],
    );
    // Another run moved the cursor first: roll back so nothing is recorded twice.
    if (!moved.rows[0]) throw new Error("payment cursor moved concurrently");
    return count;
  });

  for (const n of notices) {
    try {
      await deps.notifier.notify(n.subject, n.body);
    } catch (e) {
      console.warn("payment notice failed", (e as Error).message);
    }
  }
  return recorded;
}
