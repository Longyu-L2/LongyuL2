import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address, type Hex } from "viem";
import { loadConfig } from "../src/config.ts";
import { watchPayments } from "../src/jobs/payments.ts";
import { NATIVE, type PaymentChain, type RouterLog } from "../src/services/payments.ts";
import { ADMIN_KEYS, E18, call, makeEnv, type TestEnv } from "./helpers.ts";

const ROUTER = getAddress("0x00000000000000000000000000000000000a1b2c");
const TREASURY = getAddress("0x00000000000000000000000000000000007e5a11");
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const PAYER = getAddress("0x000000000000000000000000000000000000beef");

class FakePayments implements PaymentChain {
  safe = 0n;
  logs: RouterLog[] = [];
  queries: [bigint, bigint][] = [];
  async safeBlock() {
    return this.safe;
  }
  async routerLogs(router: Address, from: bigint, to: bigint) {
    assert.equal(router, ROUTER);
    this.queries.push([from, to]);
    return this.logs.filter((l) => l.block >= from && l.block <= to);
  }
  treasury(block: bigint, treasury: Address = TREASURY) {
    this.logs.push({ kind: "treasury", treasury, block, logIndex: 0, txHash: txh(block, 0) });
  }
  pay(block: bigint, orderId: string, token: Address, amount: bigint, blockTime: bigint, logIndex = 1) {
    this.logs.push({ kind: "paid", orderId: orderId as Hex, payer: PAYER, token, amount, block, blockTime, logIndex, txHash: txh(block, logIndex) });
  }
}
const txh = (block: bigint, i: number) => `0x${block.toString(16).padStart(32, "0")}${i.toString(16).padStart(32, "0")}` as Hex;

const PAY_ENV = {
  PAYMENT_ROUTER_ADDRESS: ROUTER,
  PAYMENT_START_BLOCK: "100",
  TREASURY_ADDRESS: TREASURY,
  PAYMENT_RPC_URL: "https://bsc.example-provider.io",
};
const adminA = { "x-admin-key": ADMIN_KEYS.alice };
const adminB = { "x-admin-key": ADMIN_KEYS.bob };

async function order(env: TestEnv, token: string, amount: string, extra: Record<string, unknown> = {}) {
  const r = await call<{ id: string; orderId: string; amount: string; pay: Record<string, unknown> }>(env, "POST", "/v1/admin/orders", {
    customer: "Partner Labs", product: "campaign", description: "Verified-human product trial, 2 weeks", token, amount, ...extra,
  }, adminA);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}
const orderRow = async (env: TestEnv, id: string) =>
  (await env.deps.db.query<{ status: string; review_reason: string | null }>("SELECT status, review_reason FROM orders WHERE id = $1", [id])).rows[0]!;

test("an order is activated exactly once, and only after its block is final", async () => {
  const pay = new FakePayments();
  const env = await makeEnv({ env: PAY_ENV, payments: pay });
  try {
    const o = await order(env, "USDT", "1500.25");
    assert.match(o.orderId, /^0x[0-9a-f]{64}$/);
    assert.equal(o.amount, (150_025n * E18 / 100n).toString());
    assert.deepEqual((o.pay as { approve: unknown }).approve, { token: USDT, spender: ROUTER, amount: o.amount });

    const view = await call<{ status: string; amountDisplay: string; token: string; pay: unknown }>(env, "GET", `/v1/orders/${o.orderId}`);
    assert.deepEqual([view.json.status, view.json.amountDisplay, view.json.token], ["open", "1500.25", "USDT"]);
    assert.ok(view.json.pay);

    pay.treasury(100n);
    pay.pay(150n, o.orderId, USDT, BigInt(o.amount), env.clock.now() + 60n);

    pay.safe = 140n; // the payment's block is not final yet
    assert.equal(await watchPayments(env.deps), 0);
    assert.equal((await orderRow(env, o.id)).status, "open");

    pay.safe = 200n;
    assert.equal(await watchPayments(env.deps), 1);
    assert.equal((await orderRow(env, o.id)).status, "paid");
    assert.match(env.notices.at(-1)?.subject ?? "", /^Order paid: /);
    assert.match(env.notices.at(-1)?.text ?? "", /Outcome: activated/);
    const after = await call<{ status: string; pay: unknown }>(env, "GET", `/v1/orders/${o.orderId}`);
    assert.deepEqual([after.json.status, after.json.pay], ["paid", null]);

    // Running again, or re-reading the same blocks after a cursor reset, records nothing twice.
    assert.equal(await watchPayments(env.deps), 0);
    await env.deps.db.query("UPDATE payment_cursor SET last_block = 99");
    assert.equal(await watchPayments(env.deps), 0);
    const n = (await env.deps.db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM payments")).rows[0]!.n;
    assert.equal(n, 1n);
    // Ranges were read once each, without gaps or overlaps.
    assert.deepEqual(pay.queries, [[100n, 140n], [141n, 200n], [100n, 200n]]);
  } finally {
    await env.close();
  }
});

test("payments that do not match an open order go to review and never activate", async () => {
  const pay = new FakePayments();
  const env = await makeEnv({ env: PAY_ENV, payments: pay });
  try {
    const t = env.clock.now();
    const under = await order(env, "USDT", "100");
    const wrongToken = await order(env, "BNB", "1");
    const late = await order(env, "USDT", "50", { expiresInDays: 1 });
    const cancelled = await order(env, "USDT", "20");
    const over = await order(env, "USDT", "10");
    const afterSwap = await order(env, "USDT", "30");
    assert.equal((await call(env, "POST", `/v1/admin/orders/${cancelled.id}/cancel`, {}, adminA)).status, 200);
    const unknown = `0x${"ab".repeat(32)}`;

    pay.treasury(100n);
    pay.pay(101n, under.orderId, USDT, 9_999n * E18 / 100n, t + 10n);
    pay.pay(102n, wrongToken.orderId, USDT, E18, t + 10n);
    pay.pay(103n, late.orderId, USDT, 50n * E18, t + 86_401n);
    pay.pay(104n, cancelled.orderId, USDT, 20n * E18, t + 10n);
    pay.pay(105n, unknown, NATIVE, E18, t + 10n);
    pay.pay(106n, over.orderId, USDT, 12n * E18, t + 10n);
    pay.treasury(107n, getAddress("0x0000000000000000000000000000000000000bad")); // admin key compromised
    pay.pay(108n, afterSwap.orderId, USDT, 30n * E18, t + 10n);
    pay.safe = 500n;
    assert.equal(await watchPayments(env.deps), 7);

    assert.deepEqual(await orderRow(env, under.id), { status: "review", review_reason: "underpaid" });
    assert.deepEqual(await orderRow(env, wrongToken.id), { status: "review", review_reason: "wrong_token" });
    assert.deepEqual(await orderRow(env, late.id), { status: "review", review_reason: "late" });
    assert.deepEqual(await orderRow(env, cancelled.id), { status: "cancelled", review_reason: null });
    assert.deepEqual(await orderRow(env, over.id), { status: "paid", review_reason: null });
    assert.deepEqual(await orderRow(env, afterSwap.id), { status: "review", review_reason: "wrong_treasury" });
    const outcomes = (await env.deps.db.query<{ outcome: string }>("SELECT outcome FROM payments ORDER BY block_number")).rows.map((r) => r.outcome);
    assert.deepEqual(outcomes, ["underpaid", "wrong_token", "late", "not_open", "unknown_order", "activated", "wrong_treasury"]);
    // The treasury change itself was reported at once, before any payment reached the new address.
    assert.ok(env.notices.some((n) => /URGENT: payment router treasury changed/.test(n.subject)));
    const paidAmount = (await env.deps.db.query<{ amount: string }>("SELECT amount::text FROM payments WHERE outcome = 'activated'")).rows[0]!;
    assert.equal(paidAmount.amount, (12n * E18).toString(), "overpayment recorded as paid");

    // Reviews: a late payment can be accepted; one sent to the wrong treasury cannot.
    const acc = await call(env, "POST", `/v1/admin/orders/${late.id}/resolve`, { action: "accept", note: "paid a day late, agreed" }, adminB);
    assert.equal(acc.status, 200);
    assert.equal((await orderRow(env, late.id)).status, "paid");
    const bad = await call(env, "POST", `/v1/admin/orders/${afterSwap.id}/resolve`, { action: "accept", note: "looks fine" }, adminB);
    assert.equal(bad.json.error, "wrong_treasury_payment");
    // Refunds are recorded with the multisig's transaction.
    const noTx = await call(env, "POST", `/v1/admin/orders/${under.id}/resolve`, { action: "refunded", note: "short by 0.01" }, adminA);
    assert.equal(noTx.json.error, "refund_tx_required");
    const refundTx = `0x${"12".repeat(32)}`;
    assert.equal((await call(env, "POST", `/v1/admin/orders/${under.id}/resolve`, { action: "refunded", note: "short by 0.01", refundTx }, adminA)).status, 200);
    const pr = (await env.deps.db.query<{ refund_tx: string; refunded_by: string }>("SELECT refund_tx, refunded_by FROM payments WHERE outcome = 'underpaid'")).rows[0]!;
    assert.deepEqual(pr, { refund_tx: refundTx, refunded_by: "alice" });
    // A payment for no open order is refunded on its own record, once.
    const unk = (await env.deps.db.query<{ id: string }>("SELECT id FROM payments WHERE outcome = 'unknown_order'")).rows[0]!;
    assert.equal((await call(env, "POST", `/v1/admin/payments/${unk.id}/refunded`, { refundTx }, adminA)).status, 200);
    assert.equal((await call(env, "POST", `/v1/admin/payments/${unk.id}/refunded`, { refundTx }, adminA)).status, 404);
    const act = (await env.deps.db.query<{ id: string }>("SELECT id FROM payments WHERE outcome = 'activated'")).rows[0]!;
    assert.equal((await call(env, "POST", `/v1/admin/payments/${act.id}/refunded`, { refundTx }, adminA)).status, 404);
    // Listing for the console.
    const listed = await call<{ orders: unknown[] }>(env, "GET", "/v1/admin/orders?status=review", undefined, adminA);
    assert.equal(listed.json.orders.length, 2);
  } finally {
    await env.close();
  }
});

test("without the router's TreasurySet event the watcher cannot trust a payment", async () => {
  const pay = new FakePayments();
  const env = await makeEnv({ env: PAY_ENV, payments: pay });
  try {
    const o = await order(env, "USDT", "5");
    pay.pay(120n, o.orderId, USDT, 5n * E18, env.clock.now()); // no TreasurySet read: start block set too late
    pay.safe = 130n;
    await watchPayments(env.deps);
    assert.deepEqual(await orderRow(env, o.id), { status: "review", review_reason: "wrong_treasury" });
  } finally {
    await env.close();
  }
});

test("the watcher catches up in bounded ranges", async () => {
  const pay = new FakePayments();
  const env = await makeEnv({ env: PAY_ENV, payments: pay });
  try {
    const orders = [await order(env, "USDT", "1"), await order(env, "USDT", "2"), await order(env, "BNB", "0.5")];
    pay.treasury(100n);
    pay.pay(1_050n, orders[0]!.orderId, USDT, E18, env.clock.now());
    pay.pay(2_100n, orders[1]!.orderId, USDT, 2n * E18, env.clock.now());
    pay.pay(2_600n, orders[2]!.orderId, NATIVE, E18 / 2n, env.clock.now());
    pay.safe = 2_700n;
    assert.equal(await watchPayments(env.deps), 3);
    for (const o of orders) assert.equal((await orderRow(env, o.id)).status, "paid");
    assert.deepEqual(pay.queries, [[100n, 1_099n], [1_100n, 2_099n], [2_100n, 2_700n]]);

    // A failing query leaves the cursor where it was.
    pay.safe = 3_000n;
    pay.routerLogs = async () => { throw new Error("rpc down"); };
    await assert.rejects(watchPayments(env.deps), /rpc down/);
    const c = (await env.deps.db.query<{ last_block: bigint }>("SELECT last_block FROM payment_cursor")).rows[0]!;
    assert.equal(c.last_block, 2_700n);
  } finally {
    await env.close();
  }
});

test("order creation is admin-only, uses accepted tokens and never sells mining boosts", async () => {
  const env = await makeEnv({ env: PAY_ENV, payments: new FakePayments() });
  try {
    const base = { customer: "Partner Labs", product: "campaign", description: "Two-week trial", token: "USDT", amount: "10" };
    assert.equal((await call(env, "POST", "/v1/admin/orders", base)).status, 401);
    assert.equal((await call(env, "POST", "/v1/admin/orders", { ...base, product: "mining_boost" }, adminA)).status, 400);
    assert.equal((await call(env, "POST", "/v1/admin/orders", { ...base, token: "BUSD" }, adminA)).json.error, "token_not_accepted");
    assert.equal((await call(env, "POST", "/v1/admin/orders", { ...base, amount: "1.0000000000000000001" }, adminA)).json.error, "too_many_decimals");
    assert.equal((await call(env, "POST", "/v1/admin/orders", { ...base, amount: "0" }, adminA)).json.error, "amount_zero");
    assert.equal((await call(env, "POST", "/v1/admin/orders", { ...base, amount: "-1" }, adminA)).status, 400);
    assert.equal((await call(env, "GET", `/v1/orders/0x${"00".repeat(32)}`)).status, 404);
    assert.equal((await call(env, "GET", "/v1/orders/0x1234")).status, 400);
  } finally {
    await env.close();
  }
  const off = await makeEnv();
  try {
    assert.equal((await call(off, "GET", `/v1/orders/0x${"00".repeat(32)}`)).json.error, "payments_unavailable");
    assert.equal(await watchPayments(off.deps), 0);
  } finally {
    await off.close();
  }
});

test("payment settings are checked at startup", () => {
  const base = {
    JWT_SECRET: "x".repeat(40), RPC_URL: "http://127.0.0.1:8545", CHAIN_ID: "668801",
    DISTRIBUTOR_ADDRESS: "0x0000000000000000000000000000000000000001",
  };
  assert.throws(() => loadConfig({ ...base, PAYMENT_ROUTER_ADDRESS: ROUTER }), /PAYMENT_START_BLOCK and TREASURY_ADDRESS/);
  const ok = { ...base, ...PAY_ENV };
  assert.throws(() => loadConfig({ ...ok, PAYMENT_TOKENS: "USDT:0x123:18" }), /bad address/);
  assert.throws(() => loadConfig({ ...ok, PAYMENT_TOKENS: `USDT:${USDT}:18,USDT:native:18` }), /twice/);
  assert.throws(() => loadConfig({ ...ok, PAYMENT_TOKENS: `usdt:${USDT}:18` }), /bad symbol/);
  assert.throws(() => loadConfig({ ...ok, PAYMENT_FINALITY: "soon" }), /PAYMENT_FINALITY/);
  assert.throws(() => loadConfig({ ...ok, PAYMENT_RPC_URL: "" }), /eth_getLogs/);
  assert.equal(loadConfig(ok).PAYMENT_CHAIN_ID, 56n);
});
