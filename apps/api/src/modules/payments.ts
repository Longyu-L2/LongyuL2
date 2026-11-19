/**
 * Business orders paid on BSC through PaymentRouter (see jobs/payments.ts). Admins create orders and
 * resolve reviews; the payer's page reads an order's status and payment instructions by its ID.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { encodeAbiParameters, formatUnits, keccak256, parseUnits, type Address, type Hex } from "viem";
import type { Deps } from "../context.ts";
import { badRequest, forbidden, notFound, toBig, uuid } from "../lib/util.ts";
import { NATIVE, paymentConfig, type PaymentConfig } from "../services/payments.ts";
import { adminName } from "./public-admin.ts";
import { activateBoost, withdrawBoost } from "../boosts.ts";

const PRODUCTS = ["campaign", "verification_api", "advertising", "services"] as const;
const ORDER_STATUSES = ["open", "paid", "review", "refunded", "cancelled"] as const;
const OUTCOMES = ["activated", "underpaid", "wrong_token", "late", "unknown_order", "not_open", "wrong_treasury"] as const;
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase());

export function requirePayments(deps: Deps): PaymentConfig {
  const cfg = paymentConfig(deps.config);
  if (!cfg) throw forbidden("payments_unavailable");
  return cfg;
}

/**
 * A new order: the random reference the payer sends, and the ID the router derives from it together
 * with the token and the amount (PaymentRouter.orderIdOf). Only a payment of exactly this token and
 * amount produces the ID, so nobody can use the order up by paying less under its reference.
 */
export function newOrder(cfg: PaymentConfig, token: Address, amount: bigint): { ref: Hex; orderId: Hex } {
  const ref = `0x${randomBytes(32).toString("hex")}` as Hex;
  const orderId = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [cfg.chainId, cfg.router, ref, token, amount],
    ),
  );
  return { ref, orderId };
}

/** How to pay: the router call, and for tokens the approval that must come first. */
export function instructions(cfg: PaymentConfig, ref: string, token: string, amount: bigint) {
  return token === NATIVE
    ? { chainId: cfg.chainId, router: cfg.router, call: "payNative(bytes32)", args: [ref], value: amount }
    : {
        chainId: cfg.chainId,
        router: cfg.router,
        approve: { token, spender: cfg.router, amount },
        call: "payToken(bytes32,address,uint256)",
        args: [ref, token, amount],
        value: 0n,
      };
}

export function registerPayments(app: FastifyInstance, deps: Deps): void {
  app.post("/v1/admin/orders", async (req) => {
    const admin = adminName(deps, req);
    const cfg = requirePayments(deps);
    const body = z.object({
      customer: z.string().trim().min(2).max(200),
      product: z.enum(PRODUCTS),
      description: z.string().trim().min(5).max(2000),
      token: z.string(),
      amount: z.string().regex(/^\d{1,12}(\.\d{1,36})?$/, "a decimal amount such as 1500 or 1500.25"),
      expiresInDays: z.number().int().min(1).max(30).default(7),
    }).parse(req.body);
    const token = cfg.tokens.find((t) => t.symbol === body.token);
    if (!token) throw badRequest("token_not_accepted", `Accepted: ${cfg.tokens.map((t) => t.symbol).join(", ")}`);
    const fraction = body.amount.split(".")[1] ?? "";
    if (fraction.length > token.decimals) throw badRequest("too_many_decimals");
    const amount = parseUnits(body.amount, token.decimals);
    if (amount <= 0n) throw badRequest("amount_zero");

    const id = uuid();
    const { ref, orderId } = newOrder(cfg, token.address, amount);
    const now = deps.clock.now();
    const expiresAt = now + BigInt(body.expiresInDays) * 86_400n;
    await deps.db.query(
      `INSERT INTO orders (id, order_id, pay_ref, customer, product, description, token, amount, created_by, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9,$10,$11)`,
      [id, orderId, ref, body.customer, body.product, body.description, token.address, amount.toString(), admin, now, expiresAt],
    );
    return { id, orderId, token: token.symbol, amount, expiresAt, pay: instructions(cfg, ref, token.address, amount) };
  });

  app.get("/v1/admin/orders", async (req) => {
    adminName(deps, req);
    const { status } = z.object({ status: z.enum(ORDER_STATUSES).optional() }).parse(req.query);
    const { rows } = await deps.db.query(
      `SELECT o.*, p.tx_hash, p.payer, p.amount AS paid_amount, p.token AS paid_token, p.block_time
       FROM orders o LEFT JOIN payments p ON p.id = o.payment_id
       WHERE ($1::text IS NULL OR o.status = $1) ORDER BY o.created_at DESC LIMIT 500`,
      [status ?? null],
    );
    return { orders: rows };
  });

  app.post("/v1/admin/orders/:id/cancel", async (req) => {
    const admin = adminName(deps, req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const res = await deps.db.query(
      "UPDATE orders SET status = 'cancelled', resolved_by = $2, resolved_at = $3 WHERE id = $1 AND status = 'open' RETURNING id",
      [id, admin, deps.clock.now()],
    );
    if (!res.rows[0]) throw notFound("order_not_open");
    return { status: "cancelled" };
  });

  /**
   * Review outcomes: "accept" activates an order whose payment needed review (late, underpaid by a
   * negligible amount, and so on); "refunded" records a refund the treasury multisig has sent.
   */
  app.post("/v1/admin/orders/:id/resolve", async (req) => {
    const admin = adminName(deps, req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({
      action: z.enum(["accept", "refunded"]),
      note: z.string().trim().min(5).max(2000),
      refundTx: txHash.optional(),
    }).parse(req.body);
    return deps.db.tx(async (q) => {
      const o = (await q.query<{ status: string; payment_id: string | null; review_reason: string | null }>(
        "SELECT status, payment_id, review_reason FROM orders WHERE id = $1 FOR UPDATE",
        [id],
      )).rows[0];
      if (!o) throw notFound("order_not_found");
      const now = deps.clock.now();
      if (body.action === "accept") {
        if (o.status !== "review" || !o.payment_id) throw badRequest("order_not_in_review");
        // A payment to the wrong treasury never reached the project; it cannot be accepted.
        if (o.review_reason === "wrong_treasury") throw forbidden("wrong_treasury_payment");
        const p = (await q.query<{ block_time: bigint }>("SELECT block_time FROM payments WHERE id = $1", [o.payment_id])).rows[0]!;
        await q.query(
          "UPDATE orders SET status = 'paid', paid_at = $2, resolved_by = $3, resolved_at = $4, resolution_note = $5 WHERE id = $1",
          [id, p.block_time, admin, now, body.note],
        );
        // A boost bought by a payment accepted late starts now, so no paid day is lost to past settlements.
        await activateBoost(q, deps, id, now);
        return { status: "paid" };
      }
      if (!body.refundTx) throw badRequest("refund_tx_required");
      if (o.status !== "review" && o.status !== "paid") throw badRequest("order_not_refundable");
      if (!o.payment_id) throw badRequest("order_has_no_payment");
      await q.query("UPDATE orders SET status = 'refunded', resolved_by = $2, resolved_at = $3, resolution_note = $4 WHERE id = $1", [
        id, admin, now, body.note,
      ]);
      await q.query("UPDATE payments SET refund_tx = $2, refunded_by = $3, refunded_at = $4 WHERE id = $1", [
        o.payment_id, body.refundTx, admin, now,
      ]);
      await withdrawBoost(q, deps, id);
      return { status: "refunded" };
    });
  });

  /** What the console needs to create orders: accepted tokens and where payments go. */
  app.get("/v1/admin/payments/config", async (req) => {
    adminName(deps, req);
    const cfg = paymentConfig(deps.config);
    if (!cfg) return { enabled: false };
    return { enabled: true, chainId: cfg.chainId, router: cfg.router, treasury: cfg.treasury, tokens: cfg.tokens, products: PRODUCTS };
  });

  app.get("/v1/admin/payments", async (req) => {
    adminName(deps, req);
    const { outcome } = z.object({ outcome: z.enum(OUTCOMES).optional() }).parse(req.query);
    const { rows } = await deps.db.query(
      "SELECT * FROM payments WHERE ($1::text IS NULL OR outcome = $1) ORDER BY block_number DESC, log_index DESC LIMIT 500",
      [outcome ?? null],
    );
    return { payments: rows };
  });

  /** Records a refund of a payment that matched no open order (unknown ID, cancelled or already paid). */
  app.post("/v1/admin/payments/:id/refunded", async (req) => {
    const admin = adminName(deps, req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ refundTx: txHash }).parse(req.body);
    const res = await deps.db.query(
      `UPDATE payments SET refund_tx = $2, refunded_by = $3, refunded_at = $4
       WHERE id = $1 AND refund_tx IS NULL AND outcome IN ('unknown_order', 'not_open') RETURNING id`,
      [id, body.refundTx, admin, deps.clock.now()],
    );
    if (!res.rows[0]) throw notFound("payment_not_refundable");
    return { ok: true };
  });

  /** Public: the payer's view of one order. The 32-byte order ID is the only key. */
  app.get("/v1/orders/:orderId", async (req) => {
    const cfg = requirePayments(deps);
    const { orderId } = z.object({ orderId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(req.params);
    const o = (await deps.db.query<{ product: string; description: string; token: string; amount: string; status: string; expires_at: bigint; paid_at: bigint | null; pay_ref: string | null }>(
      "SELECT product, description, token, amount::text, status, expires_at, paid_at, pay_ref FROM orders WHERE order_id = $1",
      [orderId.toLowerCase()],
    )).rows[0];
    if (!o) throw notFound("order_not_found");
    const token = cfg.tokens.find((t) => t.address === o.token);
    const amount = toBig(o.amount);
    const payable = o.status === "open" && deps.clock.now() <= o.expires_at && o.pay_ref !== null;
    return {
      orderId: orderId.toLowerCase(),
      product: o.product,
      description: o.description,
      status: o.status,
      token: token?.symbol ?? o.token,
      amount,
      amountDisplay: token ? formatUnits(amount, token.decimals) : amount.toString(),
      expiresAt: o.expires_at,
      paidAt: o.paid_at,
      pay: payable ? instructions(cfg, o.pay_ref!, o.token, amount) : null,
    };
  });
}
