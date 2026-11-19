import { test } from "node:test";
import assert from "node:assert/strict";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { LEAF_ENCODING, type Address } from "@longyu/reward-engine";
import { indexEvents, publishNext } from "../src/jobs/chain-jobs.ts";
import { computeMigration, type MigrationRules } from "../src/jobs/migration.ts";
import { settleNextDay } from "../src/jobs/settlement.ts";
import { clearRootCache } from "../src/modules/mining.ts";
import { ADMIN_KEYS, E18, auth, call, makeEnv, mine, readyUser, siwe, type TestEnv, type TestUser } from "./helpers.ts";

const TARGET = { chainId: 668800n, distributor: getAddress("0x00000000000000000000000000000000000b1600") as Address };

async function cycle(env: TestEnv, day: bigint): Promise<void> {
  env.clock.at(day + 1n, 16n * 60n);
  assert.equal(await settleNextDay(env.deps), day);
  await publishNext(env.deps);
  env.clock.advance(12n * 3600n);
  await indexEvents(env.deps);
  clearRootCache();
}

const rules = (over: Partial<MigrationRules> = {}): MigrationRules => ({
  snapshotDay: 2n,
  pool: 1_000n * E18,
  minMiningDays: 2,
  excludedCountries: ["KP"],
  kycThreshold: null,
  ...over,
});

test("migration: eligibility rules, pro-rata shares and verifiable proofs", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "a");
    const b = await readyUser(env, "b");
    const unverified = await readyUser(env, "c", false);
    const banned = await readyUser(env, "d");
    const oneDay = await readyUser(env, "e");
    const region = await readyUser(env, "f");
    const held = await readyUser(env, "g");
    await env.deps.db.query("UPDATE users SET country = 'KP' WHERE x_username = 'f'");

    for (let d = 0n; d <= 2n; d++) {
      env.clock.at(d, 3600n);
      for (const u of [a, unverified, banned, region, held]) await mine(env, u);
      if (d > 0n) await mine(env, b); // b mines two days, a three
      if (d === 0n) await mine(env, oneDay);
      if (d === 1n) {
        const id = (await env.deps.db.query<{ id: string }>("SELECT id FROM users WHERE x_username = 'd'")).rows[0]!.id;
        const req = await call<{ id: string }>(env, "POST", "/v1/admin/bans", { userId: id, reason: "bot farm" }, { "x-admin-key": ADMIN_KEYS.alice });
        await call(env, "POST", `/v1/admin/bans/${req.json.id}/approve`, {}, { "x-admin-key": ADMIN_KEYS.bob });
        const gid = (await env.deps.db.query<{ id: string }>("SELECT id FROM users WHERE x_username = 'g'")).rows[0]!.id;
        await env.deps.db.query(
          "INSERT INTO flags (id, user_id, kind, severity, day, created_at) VALUES (gen_random_uuid(), $1, 'manual', 'hold', 1, 0)",
          [gid],
        );
      }
      await cycle(env, d);
    }

    // The snapshot must match the settled ledger exactly.
    await assert.rejects(computeMigration(env.deps.db, rules({ snapshotDay: 1n }), TARGET, env.chain), /settled to day 2/);

    const m = await computeMigration(env.deps.db, rules(), TARGET, env.chain);
    assert.deepEqual(m.excluded, {
      banned: 1, not_verified: 1, babt_not_held: 0, on_hold: 1, too_few_days: 1, excluded_region: 1, no_wallet: 0, nothing_mined: 0,
    });
    assert.deepEqual(m.entries.map((e) => e.account).sort(), [a.wallet.address, b.wallet.address].sort());
    const ea = m.entries.find((e) => e.account === a.wallet.address)!;
    const eb = m.entries.find((e) => e.account === b.wallet.address)!;
    // a mined 24 + 24.48 + 24.96, b mined 24 + 24.48: shares follow the record, not a fixed rate.
    assert.equal(ea.mined, 7344n * E18 / 100n);
    assert.equal(eb.mined, 4848n * E18 / 100n);
    assert.equal(ea.allocation, (1_000n * E18 * ea.mined) / (ea.mined + eb.mined));
    assert.ok(m.totalAllocated <= 1_000n * E18 && 1_000n * E18 - m.totalAllocated < 2n);

    for (const e of m.entries) {
      const idx = [...m.tree!.entries()].find(([, v]) => v[2] === e.account)![0];
      assert.ok(StandardMerkleTree.verify(m.root!, [...LEAF_ENCODING], ["668800", TARGET.distributor, e.account, e.allocation.toString()], m.tree!.getProof(idx)));
    }
  } finally {
    await env.close();
  }
});

test("migration: allocations above the KYC threshold are held out of the root", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "a");
    const b = await readyUser(env, "b");
    for (let d = 0n; d <= 2n; d++) {
      env.clock.at(d, 3600n);
      await mine(env, a);
      if (d === 2n) await mine(env, b);
      await cycle(env, d);
    }
    const m = await computeMigration(env.deps.db, rules({ minMiningDays: 1, kycThreshold: 500n * E18 }), TARGET, env.chain);
    assert.equal(m.heldForKyc.length, 1);
    assert.equal(m.heldForKyc[0]!.account, a.wallet.address);
    assert.equal(m.entries.length, 1);
    assert.equal(m.entries[0]!.account, b.wallet.address);
  } finally {
    await env.close();
  }
});

test("migration: an account verified with a BABT counts only while its address still holds one", async () => {
  const env = await makeEnv();
  try {
    const verify = async (u: TestUser, holder: ReturnType<typeof privateKeyToAccount>) => {
      env.chain.babt.set(holder.address.toLowerCase(), 1n);
      const r = await call(env, "POST", "/v1/verification/babt", await siwe(env, u, holder, 56, "/v1/verification/babt/challenge"), auth(u));
      assert.equal(r.json.result, "approved");
    };
    const [first, second, other, extra] = [1, 2, 3, 4].map(() => privateKeyToAccount(generatePrivateKey()));
    // One person's token verifies an account, is revoked and minted again to another address,
    // and that address verifies a second account.
    const a = await readyUser(env, "a", false);
    await verify(a, first!);
    env.chain.babt.delete(first!.address.toLowerCase());
    const b = await readyUser(env, "b", false);
    await verify(b, second!);
    // Another holder, who keeps the token; an account verified some other way; and one whose
    // token is gone but who also passed another check.
    const c = await readyUser(env, "c", false);
    await verify(c, other!);
    const d = await readyUser(env, "d");
    const e = await readyUser(env, "e", false);
    await verify(e, extra!);
    env.chain.babt.delete(extra!.address.toLowerCase());
    await env.deps.db.query(
      `INSERT INTO verifications (id, user_id, provider, reference, status, unique_key, created_at)
       SELECT gen_random_uuid(), id, 'vendor', 'lv_e', 'approved', 'vendor:e', 0 FROM users WHERE x_username = 'e'`,
    );

    for (let day = 0n; day <= 2n; day++) {
      env.clock.at(day, 3600n);
      for (const u of [a, b, c, d, e]) assert.equal((await mine(env, u)).status, 200);
      await cycle(env, day);
    }

    const read: string[] = [];
    const reader = { babtBalance: async (address: Address) => (read.push(address), env.chain.babtBalance(address)) };
    const m = await computeMigration(env.deps.db, rules(), TARGET, reader);
    assert.deepEqual(m.excluded, {
      banned: 0, not_verified: 0, babt_not_held: 1, on_hold: 0, too_few_days: 0, excluded_region: 0, no_wallet: 0, nothing_mined: 0,
    });
    assert.deepEqual(m.entries.map((x) => x.account).sort(), [b, c, d, e].map((u) => u.wallet.address).sort());
    // Only the addresses of accounts that rest on a BABT alone are read.
    assert.deepEqual(read.sort(), [first, second, other].map((w) => w!.address).sort());
    assert.equal(JSON.parse(m.dataJson).excluded.babt_not_held, 1);

    // A read that fails stops the snapshot.
    const down = { babtBalance: async (): Promise<bigint> => { throw new Error("rpc down"); } };
    await assert.rejects(computeMigration(env.deps.db, rules(), TARGET, down), /rpc down/);
  } finally {
    await env.close();
  }
});
