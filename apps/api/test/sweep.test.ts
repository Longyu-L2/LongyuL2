import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { runRiskRules } from "../src/jobs/risk.ts";
import { indexTransfers } from "../src/jobs/transfers.ts";
import { settleNextDay } from "../src/jobs/settlement.ts";
import { ADMIN_KEYS, E18, call, changeWallet, makeEnv, mine, readyUser, type TestEnv, type TestUser } from "./helpers.ts";

const FARM = getAddress("0x000000000000000000000000000000000000fa12");
let n = 0;
const tx = () => `0x${(++n).toString(16).padStart(64, "0")}` as Hex;

/** Puts native transfers on the fake chain after the indexer's cursor and indexes them. */
async function send(env: TestEnv, items: { from: Address; to: Address; amount?: bigint; failed?: boolean; at?: bigint }[]) {
  if ((await env.deps.db.query("SELECT 1 FROM chain_cursor WHERE name = 'transfers'")).rows.length === 0) await indexTransfers(env.deps);
  for (const it of items) {
    const hash = tx();
    env.chain.block += 1n;
    env.chain.transfers.push({ txHash: hash, logIndex: -1, block: env.chain.block, blockTime: it.at ?? env.clock.now(), from: it.from, to: it.to, amount: it.amount ?? E18, native: true });
    if (it.failed) env.chain.failedTxs.add(hash);
  }
  return indexTransfers(env.deps);
}

const flagsOf = async (env: TestEnv, kind = "wallet_sweep") =>
  (await env.deps.db.query<{ name: string; severity: string; status: string; role: string; day: bigint }>(
    `SELECT u.x_username AS name, f.severity, f.status, f.detail->>'role' AS role, f.day FROM flags f JOIN users u ON u.id = f.user_id
     WHERE f.kind = $1 ORDER BY u.x_username, f.day`,
    [kind],
  )).rows;

async function users(env: TestEnv, count: number, prefix = "u"): Promise<TestUser[]> {
  const out: TestUser[] = [];
  for (let i = 0; i < count; i++) out.push(await readyUser(env, `${prefix}${i}`));
  return out;
}

test("five accounts sweeping to one wallet are held, and their rewards stay out of the root", async () => {
  const env = await makeEnv();
  try {
    const sweepers = await users(env, 5);
    const clean = await readyUser(env, "clean");
    const reverted = await readyUser(env, "reverted");
    env.clock.at(0n, 3600n);
    for (const u of [...sweepers, clean, reverted]) await mine(env, u);

    const recorded = await send(env, [
      ...sweepers.map((u) => ({ from: u.wallet.address, to: FARM })),
      { from: reverted.wallet.address, to: FARM, failed: true }, // reverted: moved nothing
      { from: clean.wallet.address, to: clean.wallet.address }, // to itself
      { from: getAddress("0x0000000000000000000000000000000000000abc"), to: FARM }, // not a user wallet
    ]);
    assert.equal(recorded, 5);

    env.clock.at(1n, 16n * 60n);
    assert.equal(await settleNextDay(env.deps), 0n);
    const flags = await flagsOf(env);
    assert.deepEqual(flags.map((f) => [f.name, f.severity, f.role]), sweepers.map((u) => [u.name, "hold", "sender"]));
    const ledger = new Map((await env.deps.db.query<{ address: string; cumulative: string; pending: string }>(
      "SELECT address, cumulative::text, pending::text FROM ledger_accounts",
    )).rows.map((r) => [getAddress(r.address), r]));
    assert.equal(ledger.get(clean.wallet.address)?.cumulative, (24n * E18).toString());
    for (const u of sweepers) assert.equal(ledger.get(u.wallet.address)?.cumulative ?? "0", "0", `${u.name} held`);
  } finally {
    await env.close();
  }
});

test("four accounts are below the threshold; old transfers fall out of the window", async () => {
  const env = await makeEnv();
  try {
    const us = await users(env, 5);
    env.clock.at(0n, 3600n);
    await send(env, us.slice(0, 4).map((u) => ({ from: u.wallet.address, to: FARM })));
    // The fifth account sent 15 days before the day being checked.
    await send(env, [{ from: us[4]!.wallet.address, to: FARM, at: env.clock.now() - 15n * 86_400n }]);
    assert.equal(await runRiskRules(env.deps, 0n), 0);
    assert.deepEqual(await flagsOf(env), []);
  } finally {
    await env.close();
  }
});

test("contracts only raise watch flags; allowlisted and LONGYU addresses raise nothing", async () => {
  const bridge = getAddress("0x00000000000000000000000000000000000b81d6");
  const exchange = getAddress("0x00000000000000000000000000000000000e8c4a");
  const env = await makeEnv({ env: { SWEEP_ALLOWLIST: `${exchange}, not-an-address` } });
  try {
    env.chain.contracts.add(bridge.toLowerCase());
    const us = await users(env, 5);
    env.clock.at(0n, 3600n);
    await send(env, us.flatMap((u) => [
      { from: u.wallet.address, to: bridge },
      { from: u.wallet.address, to: exchange },
      { from: u.wallet.address, to: env.deps.config.FAUCET_ADDRESS as Address },
    ]));
    await runRiskRules(env.deps, 0n);
    const flags = await flagsOf(env);
    assert.equal(flags.length, 5);
    assert.ok(flags.every((f) => f.severity === "watch"));
  } finally {
    await env.close();
  }
});

test("the account owning the destination is held too, and old wallets count for their owner", async () => {
  const env = await makeEnv();
  try {
    const boss = await readyUser(env, "boss");
    const us = await users(env, 4);
    // One account changed wallets: its old address still counts as that account.
    const fresh = privateKeyToAccount(generatePrivateKey());
    const old = us[3]!.wallet.address;
    env.clock.at(8n, 3600n); // after the 7-day wallet-change cooldown
    assert.equal((await changeWallet(env, us[3]!, fresh)).status, 200);
    const extra = await readyUser(env, "extra");
    await send(env, [...us.slice(0, 3).map((u) => ({ from: u.wallet.address, to: boss.wallet.address })),
      { from: old, to: boss.wallet.address }, { from: extra.wallet.address, to: boss.wallet.address }]);
    await runRiskRules(env.deps, 8n);
    const flags = await flagsOf(env);
    assert.deepEqual(flags.find((f) => f.name === "boss")?.role, "receiver");
    assert.equal(flags.length, 6);
    assert.ok(flags.every((f) => f.severity === "hold"));
  } finally {
    await env.close();
  }
});

test("a flag an admin cleared is not raised again for the same destination", async () => {
  const env = await makeEnv();
  try {
    const us = await users(env, 5);
    env.clock.at(0n, 3600n);
    await send(env, us.map((u) => ({ from: u.wallet.address, to: FARM })));
    await runRiskRules(env.deps, 0n);
    const id = (await env.deps.db.query<{ id: string }>(
      "SELECT f.id FROM flags f JOIN users u ON u.id = f.user_id WHERE u.x_username = 'u0' AND f.kind = 'wallet_sweep'",
    )).rows[0]!.id;
    assert.equal((await call(env, "POST", `/v1/admin/flags/${id}/resolve`, { action: "clear" }, { "x-admin-key": ADMIN_KEYS.alice })).status, 200);
    env.clock.at(1n, 3600n);
    await runRiskRules(env.deps, 1n); // the same transfers are still inside the window
    const day1 = (await flagsOf(env)).filter((f) => f.day === 1n).map((f) => f.name);
    assert.deepEqual(day1, ["u1", "u2", "u3", "u4"]);
  } finally {
    await env.close();
  }
});
