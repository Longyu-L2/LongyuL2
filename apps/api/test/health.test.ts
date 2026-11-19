import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getAddress } from "viem";
import { publishNext } from "../src/jobs/chain-jobs.ts";
import { JOBS, beat } from "../src/jobs/runner.ts";
import { settleNextDay } from "../src/jobs/settlement.ts";
import { clearHealthCache } from "../src/modules/health.ts";
import { loadConfig } from "../src/config.ts";
import { parseL1Watch } from "../src/services/l1.ts";
import { sha256PlainHex } from "../src/lib/util.ts";
import { ADMIN_KEYS, E18, call, makeEnv, mine, readyUser, type TestEnv } from "./helpers.ts";

const MONITOR_KEY = "monitor-key-0123456789abcdef";
const admin = { "x-admin-key": ADMIN_KEYS.alice };
type HealthBody = { status: string; checks: { name: string; status: string; detail: string }[] };

async function health(env: TestEnv, headers: Record<string, string> = admin) {
  clearHealthCache(env.deps);
  const r = await call<HealthBody>(env, "GET", "/v1/admin/health", undefined, headers);
  const by = Object.fromEntries((r.json.checks ?? []).map((c) => [c.name, c]));
  return { http: r.status, status: r.json.status, by };
}
async function allJobsSucceeded(env: TestEnv) {
  for (const j of JOBS) await beat(env.deps, j.name, "success");
}

test("health: monitor key opens health only; a fresh, quiet system is healthy once jobs run", async () => {
  const env = await makeEnv({ env: { MONITOR_KEY_SHA256: sha256PlainHex(MONITOR_KEY) } });
  try {
    assert.equal((await health(env, {})).http, 401);
    assert.equal((await health(env, { "x-monitor-key": "wrong-monitor-key-000000" })).http, 401);
    assert.equal((await call(env, "GET", "/v1/admin/flags", undefined, { "x-monitor-key": MONITOR_KEY })).status, 401);

    const before = await health(env, { "x-monitor-key": MONITOR_KEY });
    assert.equal(before.http, 200);
    assert.equal(before.by["job settlement"]!.status, "warn", "jobs have not run yet");
    assert.ok(!("job payments" in before.by), "payments not configured");

    await allJobsSucceeded(env);
    const h = await health(env);
    assert.deepEqual([h.http, h.status], [200, "ok"], JSON.stringify(h.by));
    for (const name of ["database", "chain", "distributor", "publisher gas", "relayer gas", "vault runway", "faucet", "settlement", "publishing", "claim queue"]) {
      assert.equal(h.by[name]?.status, "ok", name);
    }
  } finally {
    await env.close();
  }
});

test("health: a stalled chain, low gas, a paused distributor and failing jobs are reported", async () => {
  const env = await makeEnv();
  try {
    await allJobsSucceeded(env);
    env.chain.health.blockTime = env.clock.now() - 300n;
    env.chain.health.relayerBalance = E18 / 1000n; // 0.001 BNB, under the 0.002 warning line
    env.chain.health.paused = true;
    let h = await health(env);
    assert.deepEqual([h.http, h.status], [200, "warn"]);
    assert.equal(h.by.chain!.status, "warn");
    assert.equal(h.by["relayer gas"]!.status, "warn");
    assert.equal(h.by.distributor!.status, "warn");

    env.chain.health.blockTime = env.clock.now() - 900n; // sequencer down for 15 minutes
    env.chain.health.publisherBalance = E18 / 10_000n; // 0.0001 BNB, under a fifth of the line
    for (let i = 0; i < 5; i++) await beat(env.deps, "relayer", "error", new Error("nonce too low"));
    h = await health(env);
    assert.deepEqual([h.http, h.status], [503, "critical"]);
    assert.equal(h.by.chain!.status, "critical");
    assert.equal(h.by["publisher gas"]!.status, "critical");
    assert.equal(h.by["job relayer"]!.status, "critical");
    assert.match(h.by["job relayer"]!.detail, /5 failure\(s\) since: nonce too low/);

    // A check that cannot run is itself critical.
    env.chain.healthSnapshot = async () => { throw new Error("connect ECONNREFUSED"); };
    h = await health(env);
    assert.match(h.by.chain!.detail, /check failed: connect ECONNREFUSED/);
  } finally {
    await env.close();
  }
});

test("health: settlement and publishing deadlines", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "a");
    env.clock.at(0n, 3600n);
    await mine(env, a);
    await allJobsSucceeded(env);

    env.clock.at(1n, 10n * 60n); // day 0 not due until 00:15
    assert.equal((await health(env)).by.settlement!.status, "ok");
    env.clock.at(1n, 40n * 60n); // 25 minutes overdue
    await allJobsSucceeded(env);
    assert.equal((await health(env)).by.settlement!.status, "warn");
    env.clock.at(1n, 2n * 3600n); // more than an hour overdue
    await allJobsSucceeded(env);
    let h = await health(env);
    assert.deepEqual([h.http, h.by.settlement!.status], [503, "critical"]);

    assert.equal(await settleNextDay(env.deps), 0n);
    h = await health(env);
    assert.equal(h.by.settlement!.status, "ok");
    assert.equal(h.by.publishing!.status, "ok", "just computed");
    env.clock.advance(2n * 3600n); // the publisher has not posted it for two hours
    assert.equal((await health(env)).by.publishing!.status, "warn");
    env.clock.advance(2n * 3600n);
    h = await health(env);
    assert.deepEqual([h.http, h.by.publishing!.status], [503, "critical"]);
    assert.match(h.by.publishing!.detail, /day 0 computed 240 min ago/);
  } finally {
    await env.close();
  }
});

test("health: payments sent to an unexpected treasury are critical", async () => {
  const router = getAddress("0x00000000000000000000000000000000000a1b2c");
  const env = await makeEnv({
    env: { PAYMENT_ROUTER_ADDRESS: router, PAYMENT_START_BLOCK: "1", TREASURY_ADDRESS: getAddress("0x00000000000000000000000000000000007e5a11"), PAYMENT_RPC_URL: "https://bsc.example.io" },
    payments: { safeBlock: async () => 10n, routerLogs: async () => [] },
  });
  try {
    await allJobsSucceeded(env);
    let h = await health(env);
    assert.equal(h.by["payment watcher"]!.status, "ok");
    assert.equal(h.by["payments review"]!.status, "ok");
    await env.deps.db.query(
      `INSERT INTO payments (id, chain_id, router, tx_hash, log_index, block_number, block_time, order_id, payer, token, amount, treasury, outcome, created_at)
       VALUES (gen_random_uuid(), 56, $1, $2, 0, 5, 0, $3, $4, $4, 1, $4, 'wrong_treasury', 0)`,
      [router, `0x${"aa".repeat(32)}`, `0x${"bb".repeat(32)}`, getAddress("0x0000000000000000000000000000000000000bad")],
    );
    h = await health(env);
    assert.deepEqual([h.http, h.by["payment treasury"]!.status], [503, "critical"]);
    // The router's treasury itself, as last read from its events, is checked too.
    await env.deps.db.query("INSERT INTO payment_cursor (router, last_block, treasury) VALUES ($1, 10, $2)", [router, getAddress("0x0000000000000000000000000000000000000bad")]);
    h = await health(env);
    assert.equal(h.by["router treasury"]!.status, "critical");
  } finally {
    await env.close();
  }
});

test("health: a root on-chain that this API did not compute is critical", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "a");
    env.clock.at(0n, 3600n);
    await mine(env, a);
    await allJobsSucceeded(env);
    let h = await health(env);
    assert.deepEqual([h.by["posted roots"]!.status, h.by["posted roots"]!.detail], ["ok", "no root posted yet"]);

    env.clock.at(1n, 20n * 60n);
    assert.equal(await settleNextDay(env.deps), 0n);
    assert.equal(await publishNext(env.deps), 0n);
    await allJobsSucceeded(env);
    h = await health(env);
    assert.deepEqual([h.by["posted roots"]!.status, h.by["posted roots"]!.detail], ["ok", "the roots on-chain are the ones computed here"]);

    // The same day with another root, total or data file: each is somebody else's work.
    const ours = env.chain.pending!;
    const word = (n: string) => `0x${n.repeat(64)}` as `0x${string}`;
    for (const change of [{ root: word("9") }, { totalEntitled: ours.totalEntitled + 1n }, { dataHash: word("8") }]) {
      env.chain.pending = { ...ours, ...change };
      h = await health(env);
      assert.deepEqual([h.http, h.by["posted roots"]!.status], [503, "critical"], JSON.stringify(Object.keys(change)));
      assert.match(h.by["posted roots"]!.detail, /^the pending root for day 0 is not the one computed here: veto it, pause the distributor and stop the signer/);
    }
    // A day this API never settled.
    env.chain.pending = { ...ours, day: 5n };
    h = await health(env);
    assert.match(h.by["posted roots"]!.detail, /^the pending root for day 5 is not the one computed here: veto it/);

    // Once such a root is active the veto window is over; the advice no longer offers it.
    env.chain.pending = null;
    env.chain.active = { ...ours, root: word("9") };
    h = await health(env);
    assert.deepEqual([h.http, h.by["posted roots"]!.status], [503, "critical"]);
    assert.match(h.by["posted roots"]!.detail, /^the active root for day 0 is not the one computed here: pause the distributor and stop the signer/);

    // Our own root, active: healthy again.
    env.chain.active = ours;
    h = await health(env);
    assert.equal(h.by["posted roots"]!.status, "ok");
  } finally {
    await env.close();
  }
});

test("health: claims stuck in flight, failed faucet drips and the day's X sign-ins", async () => {
  const env = await makeEnv({ env: { X_DAILY_SIGNIN_LIMIT: "50" } });
  try {
    await allJobsSucceeded(env);
    let h = await health(env);
    for (const name of ["claims in flight", "faucet failures", "x sign-ins"]) assert.equal(h.by[name]?.status, "ok", name);
    assert.equal(h.status, "ok");

    // A claim marked sent and never closed.
    const now = env.clock.now();
    const claim = randomUUID();
    await env.deps.db.query("INSERT INTO claims (id, address, status, created_at, updated_at) VALUES ($1,$2,'sent',$3,$3)", [
      claim, getAddress(`0x${"1c".repeat(20)}`), now - 1800n,
    ]);
    assert.equal((await health(env)).by["claims in flight"]!.status, "ok", "half an hour is not yet late");
    await env.deps.db.query("UPDATE claims SET updated_at = $1 WHERE id = $2", [now - 1801n, claim]);
    h = await health(env);
    assert.deepEqual([h.http, h.by["claims in flight"]!.status], [200, "warn"]);
    assert.match(h.by["claims in flight"]!.detail, /^1 sent, not confirmed, oldest /);
    await env.deps.db.query("UPDATE claims SET updated_at = $1 WHERE id = $2", [now - 7201n, claim]);
    h = await health(env);
    assert.deepEqual([h.http, h.by["claims in flight"]!.status], [503, "critical"]);
    await env.deps.db.query("UPDATE claims SET status = 'confirmed' WHERE id = $1", [claim]);
    assert.equal((await health(env)).by["claims in flight"]!.status, "ok");

    // Failed faucet drips: only the last day's count.
    const failedDrip = (i: number, at: bigint) =>
      env.deps.db.query("INSERT INTO faucet_requests (id, address, ip, created_at, day, status) VALUES ($1,$2,'10.0.0.1',$3,$4,'failed')", [
        randomUUID(), getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`), at, at / 86_400n,
      ]);
    await failedDrip(0, now - 86_400n);
    assert.equal((await health(env)).by["faucet failures"]!.status, "ok", "a day old: no longer counted");
    await failedDrip(1, now - 60n);
    h = await health(env);
    assert.deepEqual([h.by["faucet failures"]!.status, h.by["faucet failures"]!.detail], ["warn", "1 failed in the last day"]);
    for (let i = 2; i <= 20; i++) await failedDrip(i, now - 60n);
    h = await health(env);
    assert.deepEqual([h.http, h.by["faucet failures"]!.status], [503, "critical"]);
    await env.deps.db.query("DELETE FROM faucet_requests");

    // The day's ceiling on billed X sign-ins: a warning at four fifths, critical once sign-in is refused.
    const day = now / 86_400n;
    await env.deps.db.query("INSERT INTO x_signin_days (day, exchanges) VALUES ($1, 39), ($2, 50)", [day, day - 1n]);
    assert.equal((await health(env)).by["x sign-ins"]!.status, "ok", "yesterday's count does not matter");
    await env.deps.db.query("UPDATE x_signin_days SET exchanges = 40 WHERE day = $1", [day]);
    h = await health(env);
    assert.deepEqual([h.by["x sign-ins"]!.status, h.by["x sign-ins"]!.detail], ["warn", "40 of 50 today"]);
    await env.deps.db.query("UPDATE x_signin_days SET exchanges = 50 WHERE day = $1", [day]);
    h = await health(env);
    assert.deepEqual([h.http, h.by["x sign-ins"]!.status], [503, "critical"]);
    assert.match(h.by["x sign-ins"]!.detail, /^50 of 50 today: sign-in is refused until 00:00 UTC/);
  } finally {
    await env.close();
  }
});

test("health: the batcher's and the proposer's gas on the L1", async () => {
  const BATCHER = getAddress(`0x${"b1".repeat(20)}`);
  const PROPOSER = getAddress(`0x${"c2".repeat(20)}`);
  const accounts = parseL1Watch(`batcher:${BATCHER.toLowerCase()}, proposer:${PROPOSER}`);
  assert.deepEqual(accounts, [{ name: "batcher", address: BATCHER }, { name: "proposer", address: PROPOSER }]);
  const balances = new Map<string, bigint>([[BATCHER, E18 / 10n], [PROPOSER, E18 / 100n]]);
  let down = false;
  const env = await makeEnv({
    l1: {
      balances: async () => {
        if (down) throw new Error("L1 RPC unreachable");
        return accounts.map((a) => ({ ...a, balance: balances.get(a.address)! }));
      },
    },
  });
  try {
    await allJobsSucceeded(env);
    let h = await health(env);
    assert.deepEqual([h.http, h.status], [200, "ok"], JSON.stringify(h.by));
    assert.deepEqual([h.by["batcher gas"]!.detail, h.by["proposer gas"]!.detail], ["0.100 on the L1 (warn below 0.010)", "0.010 on the L1 (warn below 0.010)"]);

    balances.set(PROPOSER, E18 / 100n - 1n);
    h = await health(env);
    assert.deepEqual([h.http, h.by["proposer gas"]!.status, h.by["batcher gas"]!.status], [200, "warn", "ok"]);
    balances.set(PROPOSER, E18 / 500n - 1n);
    h = await health(env);
    assert.deepEqual([h.http, h.by["proposer gas"]!.status], [503, "critical"]);

    // An L1 that does not answer is reported, not passed over.
    down = true;
    h = await health(env);
    assert.deepEqual([h.http, h.by["l1 gas"]!.status, h.by["l1 gas"]!.detail], [503, "critical", "check failed: L1 RPC unreachable"]);
    assert.ok(!("batcher gas" in h.by));
  } finally {
    await env.close();
  }

  // Without the setting there is no such check.
  const plain = await makeEnv();
  try {
    const h = await health(plain);
    assert.ok(!("batcher gas" in h.by) && !("l1 gas" in h.by));
  } finally {
    await plain.close();
  }

  for (const bad of ["batcher", "batcher:0x1234", `Batcher:${BATCHER}`, `batcher:${BATCHER},batcher:${PROPOSER}`]) assert.throws(() => parseL1Watch(bad), /L1_WATCH/, bad);
  assert.deepEqual(parseL1Watch(undefined), []);
  const base = { JWT_SECRET: "s".repeat(40), RPC_URL: "http://127.0.0.1:1", CHAIN_ID: "1", DISTRIBUTOR_ADDRESS: BATCHER };
  assert.throws(() => loadConfig({ ...base, L1_WATCH: `batcher:${BATCHER}` }), /L1_RPC_URL and L1_WATCH are set together/);
  assert.throws(() => loadConfig({ ...base, L1_RPC_URL: "https://l1.example" }), /L1_RPC_URL and L1_WATCH are set together/);
  assert.throws(() => loadConfig({ ...base, L1_RPC_URL: "https://l1.example", L1_WATCH: "batcher" }), /L1_WATCH/);
  assert.equal(loadConfig({ ...base, L1_RPC_URL: "https://l1.example", L1_WATCH: `batcher:${BATCHER}` }).L1_MIN_GAS_BALANCE, "0.01");
});
