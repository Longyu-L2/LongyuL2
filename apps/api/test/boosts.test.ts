import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address, type Hex } from "viem";
import { VERIFICATION_GATED_PARAMS } from "@longyu/reward-engine";
import { parseBoostPlans } from "../src/boosts.ts";
import { ConfigSchema, loadConfig } from "../src/config.ts";
import { watchPayments } from "../src/jobs/payments.ts";
import { settleNextDay } from "../src/jobs/settlement.ts";
import type { PaymentChain, RouterLog } from "../src/services/payments.ts";
import { ADMIN_KEYS, E18, auth, call, makeEnv, mine, readyUser, signUp, type TestEnv, type TestUser } from "./helpers.ts";

const ROUTER = getAddress("0x00000000000000000000000000000000000a1b2c");
const TREASURY = getAddress("0x00000000000000000000000000000000007e5a11");
const USDT = getAddress("0x55d398326f99059fF775485246999027B3197955");
const PAY_ENV = {
  PAYMENT_ROUTER_ADDRESS: ROUTER,
  PAYMENT_START_BLOCK: "100",
  TREASURY_ADDRESS: TREASURY,
  PAYMENT_RPC_URL: "https://bsc.example-provider.io",
  BOOST_PLANS: "core:2500:30:USDT:5,pro:5000:30:USDT:9,max:10000:30:USDT:16",
};

class FakePayments implements PaymentChain {
  safe = 100n;
  block = 100n;
  logs: RouterLog[] = [{ kind: "treasury", treasury: TREASURY, block: 100n, logIndex: 0, txHash: `0x${"aa".repeat(32)}` as Hex }];
  async safeBlock() {
    return this.safe;
  }
  async routerLogs(_r: Address, from: bigint, to: bigint) {
    return this.logs.filter((l) => l.block >= from && l.block <= to);
  }
  /** A final payment of `amount` for `orderId`, made at `blockTime`. */
  pay(orderId: string, amount: bigint, blockTime: bigint) {
    this.block += 1n;
    this.logs.push({
      kind: "paid", orderId: orderId as Hex, payer: getAddress("0x000000000000000000000000000000000000beef"), token: USDT, amount,
      block: this.block, blockTime, logIndex: 1, txHash: `0x${this.block.toString(16).padStart(64, "0")}` as Hex,
    });
    this.safe = this.block;
  }
}

type Order = { orderId: string; amount: string; amountDisplay: string; token: string; payUrl: string; pay: { router: string; call: string; approve?: unknown } };
const buy = (env: TestEnv, u: TestUser, plan: string) => call<Order & { error?: string }>(env, "POST", "/v1/boosts/orders", { plan }, auth(u));
const boostsOf = async (env: TestEnv, name: string) =>
  (await env.deps.db.query<{ boost_bps: number; start_day: bigint; end_day: bigint; cancelled_at: bigint | null }>(
    `SELECT b.boost_bps, b.start_day, b.end_day, b.cancelled_at FROM mining_boosts b JOIN users u ON u.id = b.user_id
     WHERE u.x_username = $1 ORDER BY b.start_day`,
    [name],
  )).rows;
async function cycle(env: TestEnv, day: bigint) {
  env.clock.at(day + 1n, 16n * 60n);
  assert.equal(await settleNextDay(env.deps), day);
}
const cumulative = async (env: TestEnv, u: TestUser) =>
  (await env.deps.db.query<{ c: string }>("SELECT cumulative::text AS c FROM ledger_accounts WHERE address = $1", [u.wallet.address])).rows[0]?.c;

test("boost plans: parsed strictly, and priced in an accepted payment token", () => {
  assert.deepEqual(parseBoostPlans("pro:5000:30:USDT:9"), [{ id: "pro", boostBps: 5000, days: 30, token: "USDT", price: "9" }]);
  assert.deepEqual(parseBoostPlans(""), []);
  for (const bad of ["pro:5000:30:USDT", "pro:20000:30:USDT:9", "pro:0:30:USDT:9", "pro:5000:0:USDT:9", "pro:5000:30:usdt:9",
    "pro:5000:30:USDT:0", "pro:5000:30:USDT:-1", "Pro:5000:30:USDT:9", "a:5000:30:USDT:9,a:2500:30:USDT:5"]) {
    assert.throws(() => parseBoostPlans(bad), /BOOST_PLANS/, bad);
  }
  const base = { JWT_SECRET: "x".repeat(40), RPC_URL: "http://127.0.0.1:8545", CHAIN_ID: "668801", DISTRIBUTOR_ADDRESS: "0x0000000000000000000000000000000000000001", ...PAY_ENV };
  assert.throws(() => loadConfig({ ...base, BOOST_PLANS: "x1:5000:30:DOGE:9" }), /not in PAYMENT_TOKENS/);
});

test("default capacity plans: five classes by epochs of 1, 3 and 7 days, in BNB, at the founders' prices", () => {
  const plans = parseBoostPlans(ConfigSchema.shape.BOOST_PLANS.parse(undefined));
  assert.equal(plans.length, 15);
  assert.ok(plans.every((p) => p.token === "BNB" && /^c[1-5]-(1|3|7)$/.test(p.id) && p.id.endsWith(`-${p.days}`)));
  assert.deepEqual([...new Set(plans.map((p) => p.boostBps))], [1000, 2500, 5000, 7500, 10000]);
  for (const cls of ["c1", "c2", "c3", "c4", "c5"]) {
    const price = (d: number) => Number(plans.find((p) => p.id === `${cls}-${d}`)!.price);
    assert.ok(price(1) < price(3) && price(3) < price(7), cls);
  }
  assert.deepEqual(["c1-1", "c3-3", "c5-7"].map((id) => plans.find((p) => p.id === id)!.price), ["0.0014", "0.0189", "0.0936"]);
});

test("capacity is for accounts earning into their entitlement: every checked miner on testnet", async () => {
  const env = await makeEnv({ env: PAY_ENV, payments: new FakePayments() });
  try {
    const unverified = await readyUser(env, "new", false);
    const view = await call<{ eligible: boolean; reason: string | null }>(env, "GET", "/v1/boosts", undefined, auth(unverified));
    assert.deepEqual([view.json.eligible, view.json.reason], [true, null]);
    assert.equal((await buy(env, unverified, "pro")).status, 200);
    // An account that has not passed the device check cannot.
    const bare = await signUp(env, "bare");
    assert.equal((await buy(env, bare, "pro")).json.error, "device_not_attested");
  } finally {
    await env.close();
  }
});

test("only verified, unrestricted users can buy, with a limit on open orders", async () => {
  const env = await makeEnv({ env: PAY_ENV, payments: new FakePayments(), rewards: VERIFICATION_GATED_PARAMS });
  try {
    const unverified = await readyUser(env, "new", false);
    assert.equal((await buy(env, unverified, "pro")).json.error, "verify_first");
    const u = await readyUser(env, "a");
    assert.equal((await buy(env, u, "plus200")).json.error, "unknown_plan");
    const o = await buy(env, u, "pro");
    assert.equal(o.status, 200, JSON.stringify(o.json));
    assert.match(o.json.orderId, /^0x[0-9a-f]{64}$/);
    assert.deepEqual([o.json.token, o.json.amount, o.json.amountDisplay], ["USDT", (9n * E18).toString(), "9"]);
    assert.equal(o.json.payUrl, `https://testnet.longyu.network/pay.html?order=${o.json.orderId}`);
    assert.equal(o.json.pay.router, ROUTER);
    assert.ok(o.json.pay.approve, "token payments approve first");
    await buy(env, u, "core");
    await buy(env, u, "max");
    assert.equal((await buy(env, u, "core")).json.error, "too_many_open_orders");
    // Orders that expire unpaid free the slots again.
    env.clock.advance(86_401n);
    assert.equal((await buy(env, u, "core")).status, 200);
    // The order is a normal order to admins, linked to the buyer.
    const listed = await call<{ orders: { product: string; user_id: string }[] }>(env, "GET", "/v1/admin/orders?status=open", undefined, { "x-admin-key": ADMIN_KEYS.alice });
    assert.ok(listed.json.orders.some((x) => x.product === "mining_boost" && x.user_id));

    const id = (await env.deps.db.query<{ id: string }>("SELECT id FROM users WHERE x_username = 'a'")).rows[0]!.id;
    await env.deps.db.query("UPDATE users SET banned = TRUE WHERE id = $1", [id]);
    assert.equal((await buy(env, u, "core")).json.error, "account_restricted");
  } finally {
    await env.close();
  }
  const off = await makeEnv();
  try {
    const u = await readyUser(off, "a");
    assert.equal((await buy(off, u, "pro")).json.error, "payments_unavailable");
    const view = await call<{ available: boolean }>(off, "GET", "/v1/boosts", undefined, auth(u));
    assert.equal(view.json.available, false);
  } finally {
    await off.close();
  }
});

test("a final payment starts the boost; a second one queues after it", async () => {
  const pay = new FakePayments();
  const env = await makeEnv({ env: PAY_ENV, payments: pay });
  try {
    const u = await readyUser(env, "a");
    env.clock.at(3n, 3600n);
    const first = await buy(env, u, "pro");
    // Underpaid: no boost, the order goes to review.
    pay.pay(first.json.orderId, 8n * E18, env.clock.now());
    await watchPayments(env.deps);
    assert.deepEqual(await boostsOf(env, "a"), []);

    const second = await buy(env, u, "pro");
    pay.pay(second.json.orderId, 9n * E18, env.clock.now());
    const third = await buy(env, u, "max");
    pay.pay(third.json.orderId, 16n * E18, env.clock.now() + 60n);
    await watchPayments(env.deps);
    assert.deepEqual((await boostsOf(env, "a")).map((b) => [b.boost_bps, b.start_day, b.end_day]), [[5000, 3n, 33n], [10000, 33n, 63n]]);
    // Re-reading the same blocks changes nothing.
    await env.deps.db.query("UPDATE payment_cursor SET last_block = 99");
    await watchPayments(env.deps);
    assert.equal((await boostsOf(env, "a")).length, 2);

    const view = await call<{ current: { boost_bps: number } | null; upcoming: unknown[]; orders: { status: string }[] }>(env, "GET", "/v1/boosts", undefined, auth(u));
    assert.equal(view.json.current?.boost_bps, 5000);
    assert.equal(view.json.upcoming.length, 1);
    assert.deepEqual(view.json.orders.map((o) => o.status).sort(), ["paid", "paid", "review"]);

    // The app's rate estimate counts today's capacity the way settlement will: +50% here.
    const status = await call<{ estimatedPerHour: string; boostBps: number }>(env, "GET", "/v1/mining/status", undefined, auth(u));
    assert.equal(status.json.boostBps, 5000);
    const other = await readyUser(env, "b");
    const plain = await call<{ estimatedPerHour: string; boostBps: number }>(env, "GET", "/v1/mining/status", undefined, auth(other));
    assert.equal(plain.json.boostBps, 0);
    // Within one wei: both figures are floored when the day's amount is split into hours.
    const diff = BigInt(status.json.estimatedPerHour) - (BigInt(plain.json.estimatedPerHour) * 3n) / 2n;
    assert.ok(diff >= -1n && diff <= 1n, `estimate off by ${diff}`);
  } finally {
    await env.close();
  }
});

test("settlement: a boost raises the buyer's weight only on the days it covers", async () => {
  const pay = new FakePayments();
  // A one-day +100% plan, so both a boosted and an unboosted day fit in the test.
  const env2 = await makeEnv({ env: { ...PAY_ENV, BOOST_PLANS: "oneday:10000:1:USDT:2" }, payments: pay });
  try {
    const a = await readyUser(env2, "a");
    const b = await readyUser(env2, "b");
    env2.clock.at(0n, 1800n);
    const o = await buy(env2, a, "oneday");
    pay.pay(o.json.orderId, 2n * E18, env2.clock.now());
    await watchPayments(env2.deps);
    await mine(env2, a);
    await mine(env2, b);
    await cycle(env2, 0n);
    assert.equal(await cumulative(env2, a), (48n * E18).toString(), "boosted: 24 x 2");
    assert.equal(await cumulative(env2, b), (24n * E18).toString());
    // Day 1 is outside the boost.
    env2.clock.at(1n, 3600n);
    await mine(env2, a);
    await mine(env2, b);
    await cycle(env2, 1n);
    assert.equal(await cumulative(env2, a), (48n * E18 + 2448n * E18 / 100n).toString(), "day 2: 24 x 1.02 streak, no boost");
  } finally {
    await env2.close();
  }
});

test("refunds withdraw boosts; a late payment accepted by an admin starts today", async () => {
  const pay = new FakePayments();
  const env = await makeEnv({ env: PAY_ENV, payments: pay });
  const admin = { "x-admin-key": ADMIN_KEYS.alice };
  const orderRow = async (orderId: string) => (await env.deps.db.query<{ id: string }>("SELECT id FROM orders WHERE order_id = $1", [orderId])).rows[0]!.id;
  try {
    const u = await readyUser(env, "a");
    env.clock.at(2n, 3600n);
    const running = await buy(env, u, "core");
    pay.pay(running.json.orderId, 5n * E18, env.clock.now());
    const queued = await buy(env, u, "pro");
    pay.pay(queued.json.orderId, 9n * E18, env.clock.now());
    await watchPayments(env.deps);
    assert.deepEqual((await boostsOf(env, "a")).map((b) => [b.start_day, b.end_day]), [[2n, 32n], [32n, 62n]]);

    env.clock.at(10n, 3600n);
    const refundTx = `0x${"12".repeat(32)}`;
    for (const o of [running, queued]) {
      const r = await call(env, "POST", `/v1/admin/orders/${await orderRow(o.json.orderId)}/resolve`, { action: "refunded", note: "customer asked", refundTx }, admin);
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    const after = await boostsOf(env, "a");
    assert.deepEqual([after[0]!.end_day, after[0]!.cancelled_at], [10n, null], "the running boost ends today");
    assert.ok(after[1]!.cancelled_at !== null, "the queued boost never starts");

    // Paid after the order expired: review, then accepted on day 20, so the boost starts on day 20.
    const late = await buy(env, u, "core");
    pay.pay(late.json.orderId, 5n * E18, env.clock.now() + 2n * 86_400n);
    await watchPayments(env.deps);
    env.clock.at(20n, 3600n);
    const acc = await call(env, "POST", `/v1/admin/orders/${await orderRow(late.json.orderId)}/resolve`, { action: "accept", note: "paid two days late" }, admin);
    assert.equal(acc.status, 200, JSON.stringify(acc.json));
    const last = (await boostsOf(env, "a")).filter((b) => b.cancelled_at === null).at(-1)!;
    assert.deepEqual([last.boost_bps, last.start_day, last.end_day], [2500, 20n, 50n]);
  } finally {
    await env.close();
  }
});

test("boosts can be bought at most a year ahead", async () => {
  const pay = new FakePayments();
  const env = await makeEnv({ env: { ...PAY_ENV, BOOST_PLANS: "long:2500:200:USDT:1" }, payments: pay });
  try {
    const u = await readyUser(env, "a");
    env.clock.at(1n, 3600n);
    const o = await buy(env, u, "long");
    pay.pay(o.json.orderId, E18, env.clock.now());
    await watchPayments(env.deps);
    assert.equal((await buy(env, u, "long")).json.error, "boost_queue_full");
  } finally {
    await env.close();
  }
});

test("a payment read after its day was settled starts on the first day still open, and loses no day", async () => {
  const pay = new FakePayments();
  const env = await makeEnv({ env: { ...PAY_ENV, BOOST_PLANS: "oneday:10000:1:USDT:2,pro:5000:30:USDT:9" }, payments: pay });
  try {
    const a = await readyUser(env, "a");
    const b = await readyUser(env, "b");
    const c = await readyUser(env, "c");
    const d = await readyUser(env, "d");
    env.clock.at(0n, 1800n);
    const o = await buy(env, a, "oneday");
    pay.pay(o.json.orderId, 2n * E18, env.clock.now());
    await mine(env, a);
    await mine(env, b);
    // The payment watcher is behind: day 0 is settled before the payment is read.
    await cycle(env, 0n);
    await watchPayments(env.deps);
    assert.deepEqual((await boostsOf(env, "a")).map((x) => [x.boost_bps, x.start_day, x.end_day]), [[10000, 1n, 2n]]);
    assert.equal(await cumulative(env, a), (24n * E18).toString(), "day 0 was settled without the boost");
    // The one paid day is day 1, and it counts there.
    env.clock.at(1n, 3600n);
    await mine(env, a);
    await mine(env, b);
    await cycle(env, 1n);
    assert.equal(await cumulative(env, a), (24n * E18 + 4896n * E18 / 100n).toString(), "day 1: 24 x 1.02 streak x 2");
    assert.equal(await cumulative(env, b), (24n * E18 + 2448n * E18 / 100n).toString());

    // Paid ten minutes before midnight. Read before day 5 can be settled: it still starts on day 5.
    env.clock.at(5n, 86_400n - 600n);
    const paidAt = env.clock.now();
    const early = await buy(env, c, "pro");
    const late = await buy(env, d, "pro");
    pay.pay(early.json.orderId, 9n * E18, paidAt);
    env.clock.at(6n, 15n * 60n - 1n);
    await watchPayments(env.deps);
    assert.deepEqual((await boostsOf(env, "c")).map((x) => [x.start_day, x.end_day]), [[5n, 35n]]);
    // Read once day 5's settlement may be running: it starts on day 6, for the full thirty days.
    pay.pay(late.json.orderId, 9n * E18, paidAt);
    env.clock.at(6n, 15n * 60n);
    await watchPayments(env.deps);
    assert.deepEqual((await boostsOf(env, "d")).map((x) => [x.start_day, x.end_day]), [[6n, 36n]]);
  } finally {
    await env.close();
  }
});
