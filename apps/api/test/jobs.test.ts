import { test } from "node:test";
import assert from "node:assert/strict";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { LEAF_ENCODING, VERIFICATION_GATED_PARAMS, hashJson } from "@longyu/reward-engine";
import {
  FAUCET_MAX_ATTEMPTS, FAUCET_UNCONFIRMED_WAIT, SENT_DROPPED_SECONDS, SENT_STALE_SECONDS,
  indexEvents, processFaucet, publishNext, relayClaims, sendReminders,
} from "../src/jobs/chain-jobs.ts";
import { settleNextDay } from "../src/jobs/settlement.ts";
import { clearRootCache } from "../src/modules/mining.ts";
import { TxError } from "../src/services/chain.ts";
import { ADMIN_KEYS, E18, attest, auth, call, changeWallet, makeEnv, mine, readyUser, verifyDev, xTicket, type TestEnv, type TestUser } from "./helpers.ts";

/** Settles, publishes, waits out the veto window and indexes: one full daily cycle. */
async function cycle(env: TestEnv, day: bigint): Promise<void> {
  env.clock.at(day + 1n, 16n * 60n);
  assert.equal(await settleNextDay(env.deps), day);
  await publishNext(env.deps);
  env.clock.advance(12n * 3600n);
  await indexEvents(env.deps);
  clearRootCache();
}

test("full daily cycle: sessions -> settlement -> root -> veto window -> relayed claim", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "a");
    const b = await readyUser(env, "b");
    env.clock.at(0n, 2n * 3600n);
    assert.equal((await mine(env, a)).status, 200);
    assert.equal((await mine(env, b)).status, 200);

    // Too early: day 0 has not closed plus the grace period.
    env.clock.at(1n, 60n);
    assert.equal(await settleNextDay(env.deps), null);

    await cycle(env, 0n);
    const s = (await env.deps.db.query<{ status: string; total_entitled: string }>("SELECT status, total_entitled::text FROM settlements")).rows[0]!;
    assert.equal(s.status, "active");
    assert.equal(s.total_entitled, (48n * E18).toString()); // two T2 miners at 24 tLONG each

    const rewards = await call<{ claimable: string; earned: string }>(env, "GET", "/v1/rewards", undefined, auth(a));
    assert.equal(rewards.json.claimable, (24n * E18).toString());

    // The public proof verifies against the on-chain root with standard tooling.
    const proof = await call<{ cumulativeAmount: string; proof: string[] }>(env, "GET", `/v1/rewards/proof/${a.wallet.address}`);
    assert.ok(
      StandardMerkleTree.verify(env.chain.active!.root, [...LEAF_ENCODING], ["31337", env.chain.distributor, a.wallet.address, proof.json.cumulativeAmount], proof.json.proof),
    );

    const claim = await call<{ status: string }>(env, "POST", "/v1/rewards/claim", {}, auth(a));
    assert.equal(claim.json.status, "queued");
    assert.equal((await call(env, "POST", "/v1/rewards/claim", {}, auth(a))).json.status, "already_queued");
    assert.equal(await relayClaims(env.deps), 1);
    assert.equal(env.chain.balances.get(a.wallet.address.toLowerCase()), 24n * E18);
    const after = await call<{ claimable: string; claimed: string }>(env, "GET", "/v1/rewards", undefined, auth(a));
    assert.equal(after.json.claimable, "0");
    assert.equal(after.json.claimed, (24n * E18).toString());
    assert.equal((await call(env, "POST", "/v1/rewards/claim", {}, auth(a))).json.error, "nothing_to_claim");

    // The published data file hashes to the on-chain data hash.
    const uri = (await env.deps.db.query<{ data_uri: string }>("SELECT data_uri FROM settlements WHERE day = 0")).rows[0]!.data_uri;
    const file = await env.app.inject({ method: "GET", url: new URL(uri).pathname });
    assert.equal(file.statusCode, 200);
    assert.equal(hashJson(file.body), env.chain.active!.dataHash);
  } finally {
    await env.close();
  }
});

test("an unverified miner earns the full rate on testnet, and the numbers add up at every step", async () => {
  const env = await makeEnv();
  try {
    const n = await readyUser(env, "newbie", false);
    type Rewards = { earned: string; claimed: string; claimable: string; pending: string; entitled: string; at: string; accrual: { perHour: string; until: string } | null };
    const read = async () => {
      const { earned, claimed, claimable, pending, entitled, at, accrual } = (await call<Rewards>(env, "GET", "/v1/rewards", undefined, auth(n))).json;
      const r: Rewards = { earned, claimed, claimable, pending, entitled, at, accrual };
      assert.equal(BigInt(r.earned), BigInt(r.claimed) + BigInt(r.claimable) + BigInt(r.pending));
      // The mining screen reads the same numbers.
      const s = (await call<{ balances: Rewards }>(env, "GET", "/v1/mining/status", undefined, auth(n))).json;
      assert.deepEqual(s.balances, r);
      return r;
    };
    assert.deepEqual(await read(), { earned: "0", claimed: "0", claimable: "0", pending: "0", entitled: "0", accrual: null, at: env.clock.now().toString() });

    // Six hours into the session: a quarter of the day's 24 is pending and still growing.
    env.clock.at(0n, 3600n);
    const started = env.clock.now();
    assert.equal((await mine(env, n)).status, 200);
    env.clock.advance(6n * 3600n);
    const running = await read();
    assert.deepEqual([running.pending, running.claimable, running.entitled], [(6n * E18).toString(), "0", "0"]);
    assert.deepEqual(running.accrual, { perHour: E18.toString(), until: (started + 86_400n).toString() });

    // Settled: the whole day is on the ledger, waiting for its root. Nothing is estimated any more.
    env.clock.at(1n, 16n * 60n);
    assert.equal(await settleNextDay(env.deps), 0n);
    const waiting = await read();
    assert.deepEqual([waiting.pending, waiting.claimable, waiting.entitled, waiting.accrual], [(24n * E18).toString(), "0", (24n * E18).toString(), null]);

    // The root is claimable: pending becomes claimable, then claimed.
    await publishNext(env.deps);
    env.clock.advance(12n * 3600n);
    await indexEvents(env.deps);
    clearRootCache();
    const ready = await read();
    assert.deepEqual([ready.pending, ready.claimable, ready.earned], ["0", (24n * E18).toString(), (24n * E18).toString()]);
    await call(env, "POST", "/v1/rewards/claim", {}, auth(n));
    assert.equal(await relayClaims(env.deps), 1);
    await indexEvents(env.deps);
    const paid = await read();
    assert.deepEqual([paid.pending, paid.claimable, paid.claimed, paid.earned], ["0", "0", (24n * E18).toString(), (24n * E18).toString()]);

    // The public numbers count the miner without verification.
    const stats = await call<{ miners: string; verifiedMiners: string }>(env, "GET", "/v1/stats");
    assert.deepEqual([stats.json.miners, stats.json.verifiedMiners], ["1", "0"]);
    const board = await call<{ entries: { handle: string }[] }>(env, "GET", "/v1/leaderboard");
    assert.equal(board.json.entries.length, 1);
  } finally {
    await env.close();
  }
});

test("T1 rewards stay pending until verification, then join the next root", async () => {
  const env = await makeEnv({ rewards: VERIFICATION_GATED_PARAMS });
  try {
    const n = await readyUser(env, "newbie", false);
    env.clock.at(0n, 3600n);
    await mine(env, n);
    await cycle(env, 0n);
    const r0 = await call<{ earned: string; pending: string; entitled: string }>(env, "GET", "/v1/rewards", undefined, auth(n));
    assert.equal(r0.json.entitled, "0");
    assert.equal(r0.json.earned, r0.json.pending);
    assert.equal(r0.json.pending, (12n * E18).toString()); // T1 earns at half weight, off-chain

    env.clock.at(1n, 3600n);
    await verifyDev(env, n);
    await mine(env, n);
    await cycle(env, 1n);
    const r1 = await call<{ earned: string; pending: string; claimable: string }>(env, "GET", "/v1/rewards", undefined, auth(n));
    // Day 1 at T2 (24 + 2% streak) plus the released day-0 backlog (12).
    assert.equal(r1.json.pending, "0");
    assert.equal(r1.json.earned, ((24n * E18 * 102n) / 100n + 12n * E18).toString());
    assert.equal(r1.json.claimable, r1.json.earned);
  } finally {
    await env.close();
  }
});

test("wallet change moves unclaimed rewards; a ban freezes at what was claimed", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "a");
    const b = await readyUser(env, "b");
    env.clock.at(0n, 3600n);
    await mine(env, a);
    await mine(env, b);
    await cycle(env, 0n);

    // a claims; b does not.
    await call(env, "POST", "/v1/rewards/claim", {}, auth(a));
    await relayClaims(env.deps);

    // On day 8, b changes wallet (after the 7-day cooldown) and a is banned.
    for (let d = 1n; d <= 7n; d++) await cycle(env, d);
    env.clock.at(8n, 3600n);
    const newWallet = privateKeyToAccount(generatePrivateKey());
    assert.equal((await changeWallet(env, b, newWallet)).json.changed, true);
    const aId = (await env.deps.db.query<{ id: string }>("SELECT id FROM users WHERE x_username = 'a'")).rows[0]!.id;
    const req = await call<{ id: string }>(env, "POST", "/v1/admin/bans", { userId: aId, reason: "confirmed bot" }, { "x-admin-key": ADMIN_KEYS.alice });
    await call(env, "POST", `/v1/admin/bans/${req.json.id}/approve`, {}, { "x-admin-key": ADMIN_KEYS.bob });
    await cycle(env, 8n);
    await cycle(env, 9n); // b's old leaf was live during day 8; its rewards move once it is not

    const ledger = new Map(
      (await env.deps.db.query<{ address: string; cumulative: string; frozen: boolean }>("SELECT address, cumulative::text, frozen FROM ledger_accounts")).rows.map(
        (r) => [r.address.toLowerCase(), r],
      ),
    );
    assert.equal(ledger.get(a.wallet.address.toLowerCase())?.cumulative, (24n * E18).toString()); // frozen at claimed
    assert.equal(ledger.get(a.wallet.address.toLowerCase())?.frozen, true);
    assert.equal(ledger.get(b.wallet.address.toLowerCase())?.cumulative, "0"); // nothing claimed, all moved
    assert.equal(ledger.get(newWallet.address.toLowerCase())?.cumulative, (24n * E18).toString());
  } finally {
    await env.close();
  }
});

test("a shared device puts every account on it on hold; holds earn nothing that day", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "a", true, "same-install-id");
    const b = await readyUser(env, "b", true, "same-install-id");
    const c = await readyUser(env, "c");
    env.clock.at(0n, 3600n);
    await mine(env, a);
    await mine(env, b);
    await mine(env, c);
    await cycle(env, 0n);
    const flags = (await env.deps.db.query<{ kind: string }>("SELECT kind FROM flags WHERE status = 'open'")).rows;
    assert.equal(flags.filter((f) => f.kind === "shared_device").length, 2);
    const s = (await env.deps.db.query<{ total_entitled: string }>("SELECT total_entitled::text FROM settlements")).rows[0]!;
    assert.equal(s.total_entitled, (24n * E18).toString()); // only c
  } finally {
    await env.close();
  }
});

/** The same account signed in on another install: a second device, not yet attested. */
async function signInOn(env: TestEnv, u: TestUser, installId: string): Promise<TestUser> {
  const r = await call<{ accessToken: string; refreshToken: string }>(env, "POST", "/v1/auth/x/finish", {
    ...(await xTicket(env, { id: u.xId, username: u.name })), installId, platform: "android",
  });
  assert.equal(r.status, 200);
  return { ...u, token: r.json.accessToken, refresh: r.json.refreshToken, installId };
}

/** Open and resolved flags as "name kind day status", in order. */
const flagList = async (env: TestEnv): Promise<string[]> =>
  (await env.deps.db.query<{ line: string }>(
    "SELECT u.x_username || ' ' || f.kind || ' ' || f.day || ' ' || f.status AS line FROM flags f JOIN users u ON u.id = f.user_id ORDER BY 1",
  )).rows.map((r) => r.line);

test("an install two accounts signed in on holds neither when only one mined from it that day", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "a", true, "same-install-id");
    const b = await readyUser(env, "b", true, "same-install-id");
    // b also has a phone of its own, and c signed in on the shared install without mining at all.
    const own = await signInOn(env, b, "install-b-own");
    await attest(env, own);
    await readyUser(env, "c", true, "same-install-id");
    env.clock.at(0n, 3600n);
    assert.equal((await mine(env, a)).status, 200);
    assert.equal((await mine(env, own)).status, 200);
    await cycle(env, 0n);
    assert.deepEqual(await flagList(env), []);
    const s = (await env.deps.db.query<{ total_entitled: string }>("SELECT total_entitled::text FROM settlements")).rows[0]!;
    assert.equal(s.total_entitled, (48n * E18).toString());

    // The day both mine from it, both are held, and nobody else.
    env.clock.at(1n, 3600n);
    assert.equal((await mine(env, a)).status, 200);
    assert.equal((await mine(env, b)).status, 200);
    await cycle(env, 1n);
    assert.deepEqual(await flagList(env), ["a shared_device 1 open", "b shared_device 1 open"]);
    const detail = (await env.deps.db.query<{ detail: { installId: string; users: number } }>("SELECT detail FROM flags")).rows.map((r) => r.detail);
    assert.deepEqual(detail, [{ installId: "same-install-id", users: 2 }, { installId: "same-install-id", users: 2 }]);
  } finally {
    await env.close();
  }
});

test("a shared-device flag an admin cleared is not raised again for the same install", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "a", true, "same-install-id");
    const b = await readyUser(env, "b", true, "same-install-id");
    const both = async (day: bigint) => {
      env.clock.at(day, 3600n);
      assert.equal((await mine(env, a)).status, 200);
      assert.equal((await mine(env, b)).status, 200);
      await cycle(env, day);
    };
    await both(0n);
    assert.deepEqual(await flagList(env), ["a shared_device 0 open", "b shared_device 0 open"]);
    const flag = (await env.deps.db.query<{ id: string }>("SELECT f.id FROM flags f JOIN users u ON u.id = f.user_id WHERE u.x_username = 'a'")).rows[0]!;
    assert.equal((await call(env, "POST", `/v1/admin/flags/${flag.id}/resolve`, { action: "clear" }, { "x-admin-key": ADMIN_KEYS.alice })).status, 200);
    await both(1n);
    assert.deepEqual(await flagList(env), ["a shared_device 0 cleared", "b shared_device 0 open", "b shared_device 1 open"]);

    // Cleared for that install only: on another install the two share, a is held again.
    const a2 = await signInOn(env, a, "second-install-id");
    const b2 = await signInOn(env, b, "second-install-id");
    await attest(env, a2);
    await attest(env, b2);
    env.clock.at(2n, 3600n);
    assert.equal((await mine(env, a2)).status, 200);
    assert.equal((await mine(env, b2)).status, 200);
    await cycle(env, 2n);
    assert.deepEqual(await flagList(env), [
      "a shared_device 0 cleared", "a shared_device 2 open", "b shared_device 0 open", "b shared_device 1 open", "b shared_device 2 open",
    ]);
  } finally {
    await env.close();
  }
});

test("attestation failures hold an account only on the device it mined from that day", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "a");
    const b = await readyUser(env, "b");
    const failChecks = async (u: TestUser, times: number) => {
      for (let i = 0; i < times; i++) {
        const c = await call<{ challengeId: string }>(env, "POST", "/v1/device/challenge", {}, auth(u));
        assert.equal((await call(env, "POST", "/v1/device/attest", { challengeId: c.json.challengeId, token: "dev:wrong" }, auth(u))).json.attested, false);
      }
    };
    // a has an old phone that keeps failing its check, and mines from the one that passes.
    await failChecks(await signInOn(env, a, "install-a-old"), 6);
    env.clock.at(0n, 3600n);
    assert.equal((await mine(env, a)).status, 200);
    assert.equal((await mine(env, b)).status, 200);
    // b's failures are on the device it mined from.
    await failChecks(b, 5);
    await cycle(env, 0n);
    assert.deepEqual(await flagList(env), ["b attestation_failures 0 open"]);
    const s = (await env.deps.db.query<{ total_entitled: string }>("SELECT total_entitled::text FROM settlements")).rows[0]!;
    assert.equal(s.total_entitled, (24n * E18).toString()); // only a
  } finally {
    await env.close();
  }
});

test("streaks grow with daily mining and feed the next day's reward", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "s");
    for (let d = 0n; d < 3n; d++) {
      env.clock.at(d, 3600n);
      await mine(env, u);
      await cycle(env, d);
    }
    const st = await call<{ streakDays: number }>(env, "GET", "/v1/mining/status", undefined, auth(u));
    assert.equal(st.json.streakDays, 3);
    const r = await call<{ earned: string }>(env, "GET", "/v1/rewards", undefined, auth(u));
    // 24 + 24 x 1.02 + 24 x 1.04
    assert.equal(r.json.earned, ((24n * E18 * 306n) / 100n).toString());
  } finally {
    await env.close();
  }
});

test("the publisher waits while a root is in its veto window, and empty days post nothing", async () => {
  const env = await makeEnv();
  try {
    env.clock.at(1n, 16n * 60n);
    assert.equal(await settleNextDay(env.deps), 0n); // nobody mined
    assert.equal(await publishNext(env.deps), null);
    const u = await readyUser(env, "p");
    env.clock.at(1n, 3600n);
    await mine(env, u);
    env.clock.at(2n, 16n * 60n);
    await settleNextDay(env.deps);
    assert.equal(await publishNext(env.deps), 1n);
    env.clock.at(2n, 3600n);
    await mine(env, u);
    env.clock.at(3n, 16n * 60n);
    await settleNextDay(env.deps);
    // Day 1's root was posted at 00:16 of day 2 and is still in its veto window at 00:16 of day 3? No: 24h passed.
    assert.equal(await publishNext(env.deps), 2n);
    assert.equal(await publishNext(env.deps), null); // day 2 is now waiting
  } finally {
    await env.close();
  }
});

test("reminders go out once when a session ends", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "r");
    await call(env, "POST", "/v1/push/register", { token: "ExponentPushToken[abc123]" }, auth(u));
    env.clock.at(0n, 3600n);
    await mine(env, u);
    env.clock.advance(24n * 3600n + 60n);
    assert.equal(await sendReminders(env.deps), 1);
    assert.equal(await sendReminders(env.deps), 0);
    assert.equal(env.pushes[0]?.to, "ExponentPushToken[abc123]");
  } finally {
    await env.close();
  }
});

async function ban(env: TestEnv, name: string): Promise<void> {
  const id = (await env.deps.db.query<{ id: string }>("SELECT id FROM users WHERE x_username = $1", [name])).rows[0]!.id;
  const req = await call<{ id: string }>(env, "POST", "/v1/admin/bans", { userId: id, reason: "confirmed abuse" }, { "x-admin-key": ADMIN_KEYS.alice });
  await call(env, "POST", `/v1/admin/bans/${req.json.id}/approve`, {}, { "x-admin-key": ADMIN_KEYS.bob });
}

/** Claims straight from the contract with the public proof, as anyone can, bypassing the API. */
async function directClaim(env: TestEnv, address: `0x${string}`): Promise<bigint> {
  const p = await call<{ cumulativeAmount: string; proof: `0x${string}`[] }>(env, "GET", `/v1/rewards/proof/${address}`);
  if (p.status !== 200) return 0n;
  const r = await env.chain.claimMany([{ account: address, cumulative: BigInt(p.json.cumulativeAmount), proof: p.json.proof }]);
  return r.events.filter((e) => e.kind === "claimed").reduce((s, e) => s + (e as { amount: bigint }).amount, 0n);
}

test("regression: a wallet change can never be paid twice (old address claims from the live root)", async () => {
  const env = await makeEnv();
  try {
    const b = await readyUser(env, "b");
    for (let d = 0n; d <= 7n; d++) {
      env.clock.at(d, 3600n);
      await mine(env, b);
      await cycle(env, d);
    }
    const old = b.wallet.address;
    const earned = BigInt((await call<{ earned: string }>(env, "GET", "/v1/rewards", undefined, auth(b))).json.earned);
    env.clock.at(8n, 3600n);
    const next = privateKeyToAccount(generatePrivateKey());
    assert.equal((await changeWallet(env, b, next)).json.changed, true);
    // Day 8 settles and its root is posted, but root 7 is still the claimable one.
    env.clock.at(9n, 16n * 60n);
    await settleNextDay(env.deps);
    await publishNext(env.deps);
    // The attack: the old address claims everything root 7 still allows...
    const paidOld = await directClaim(env, old);
    assert.equal(paidOld, earned);
    env.clock.advance(12n * 3600n);
    await indexEvents(env.deps);
    clearRootCache();
    // ...then the user keeps mining with the new wallet and claims through the app.
    for (let d = 9n; d <= 10n; d++) {
      env.clock.at(d, 13n * 3600n);
      b.wallet = next;
      await mine(env, b);
      await cycle(env, d);
    }
    await call(env, "POST", "/v1/rewards/claim", {}, auth(b));
    await relayClaims(env.deps);
    const paidNew = env.chain.balances.get(next.address.toLowerCase()) ?? 0n;
    const newLeaf = (await env.deps.db.query<{ cumulative: string }>("SELECT cumulative::text FROM ledger_accounts WHERE address = $1", [next.address])).rows[0]!;
    // The new wallet is paid only for days 9 and 10; the old rewards were paid exactly once.
    assert.equal(paidNew, BigInt(newLeaf.cumulative));
    assert.ok(paidNew > 0n && paidNew < 2n * 30n * E18);
    const alerts = (await env.deps.db.query<{ stats: { alerts: string[] } }>("SELECT stats FROM settlements")).rows.flatMap((r) => r.stats.alerts);
    assert.deepEqual(alerts, []);
  } finally {
    await env.close();
  }
});

test("regression: a wallet change after midnight but before settlement does not break settlement", async () => {
  const env = await makeEnv();
  try {
    const b = await readyUser(env, "b");
    for (let d = 0n; d < 7n; d++) await cycle(env, d);
    env.clock.at(7n, 3600n);
    await mine(env, b); // credited to the old wallet
    env.clock.at(8n, 5n * 60n); // 00:05 UTC, before day 7 settles at 00:15
    const next = privateKeyToAccount(generatePrivateKey());
    assert.equal((await changeWallet(env, b, next)).json.changed, true);
    await cycle(env, 7n); // pays the old wallet: that is where the session was mined
    await cycle(env, 8n); // freezes the old wallet; its 24 is held while root 7 can still pay it
    await cycle(env, 9n); // root 8 no longer pays the old wallet, so the 24 moves
    const led = new Map((await env.deps.db.query<{ address: string; cumulative: string }>("SELECT address, cumulative::text FROM ledger_accounts")).rows.map((r) => [r.address.toLowerCase(), r.cumulative]));
    assert.equal(led.get(next.address.toLowerCase()), (24n * E18).toString());
  } finally {
    await env.close();
  }
});

test("regression: a banned user claiming from the live root, or changing wallet, cannot halt settlement", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "a");
    const c = await readyUser(env, "c");
    env.clock.at(0n, 3600n);
    await mine(env, a);
    await mine(env, c);
    await cycle(env, 0n);
    env.clock.at(1n, 13n * 3600n);
    await ban(env, "a");
    await mine(env, c);
    // Day 1 settles with a frozen; root 0 is still claimable while root 1 waits.
    env.clock.at(2n, 16n * 60n);
    await settleNextDay(env.deps);
    await publishNext(env.deps);
    assert.equal(await directClaim(env, a.wallet.address), 24n * E18);
    env.clock.advance(12n * 3600n);
    await indexEvents(env.deps);
    clearRootCache();
    env.clock.at(2n, 13n * 3600n);
    await mine(env, c);
    await cycle(env, 2n); // settlement keeps running for everyone
    const s = (await env.deps.db.query<{ status: string; stats: { alerts: string[] } }>("SELECT status, stats FROM settlements WHERE day = 2")).rows[0]!;
    assert.equal(s.status, "active");
    assert.deepEqual(s.stats.alerts, []);
    // a cannot get anything more.
    assert.equal(await directClaim(env, a.wallet.address), 0n);
  } finally {
    await env.close();
  }
});

test("regression: proofs survive while their root is still claimable during a long pause", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "p");
    env.clock.at(0n, 3600n);
    await mine(env, u);
    await cycle(env, 0n);
    // The publisher stalls (say a guardian pause) for five days while settlement continues.
    for (let d = 1n; d <= 5n; d++) {
      env.clock.at(d + 1n, 16n * 60n);
      await settleNextDay(env.deps);
    }
    assert.equal((await call(env, "GET", `/v1/rewards/proof/${u.wallet.address}`)).status, 200);
  } finally {
    await env.close();
  }
});

/** A verified miner with day 0 settled and active, and a claim for it in the queue. */
async function queuedClaim(env: TestEnv, name = "a"): Promise<{ user: TestUser; id: string; due: bigint }> {
  const user = await readyUser(env, name);
  env.clock.at(0n, 2n * 3600n);
  assert.equal((await mine(env, user)).status, 200);
  await cycle(env, 0n);
  const claim = await call<{ claimId: string; status: string; amount: string }>(env, "POST", "/v1/rewards/claim", {}, auth(user));
  assert.equal(claim.json.status, "queued");
  return { user, id: claim.json.claimId, due: BigInt(claim.json.amount) };
}
async function claimRow(env: TestEnv, id: string) {
  return (await env.deps.db.query<{ status: string; tx_hash: string | null; error: string | null }>(
    "SELECT status, tx_hash, error FROM claims WHERE id = $1",
    [id],
  )).rows[0]!;
}
const paid = (env: TestEnv, u: TestUser) => env.chain.balances.get(u.wallet.address.toLowerCase()) ?? 0n;

test("claims: a run that died after marking a claim sent, before sending, is picked up again", async () => {
  const env = await makeEnv();
  try {
    const { user, id, due } = await queuedClaim(env);
    // The relayer marked it sent and the process stopped there.
    await env.deps.db.query("UPDATE claims SET status = 'sent', day = 0, cumulative = $1::numeric, updated_at = $2 WHERE id = $3", [
      due.toString(), env.clock.now(), id,
    ]);
    assert.equal((await call(env, "POST", "/v1/rewards/claim", {}, auth(user))).json.status, "already_queued");

    // While the run that marked it could still be alive, it is left alone.
    env.clock.advance(SENT_STALE_SECONDS);
    assert.equal(await relayClaims(env.deps), 0);
    assert.equal((await claimRow(env, id)).status, "sent");
    assert.equal(paid(env, user), 0n);

    env.clock.advance(1n);
    assert.equal(await relayClaims(env.deps), 1);
    assert.equal(paid(env, user), due);
    const row = await claimRow(env, id);
    assert.equal(row.status, "confirmed");
    assert.ok(row.tx_hash);
  } finally {
    await env.close();
  }
});

test("claims: a stuck claim that was paid some other way is closed, not sent", async () => {
  const env = await makeEnv();
  try {
    const { user, id, due } = await queuedClaim(env);
    await env.deps.db.query("UPDATE claims SET status = 'sent', day = 0, cumulative = $1::numeric, updated_at = $2 WHERE id = $3", [
      due.toString(), env.clock.now(), id,
    ]);
    // The user claimed straight from the contract, and the indexer missed the row.
    await env.deps.db.query("INSERT INTO claimed_onchain (address, cumulative) VALUES ($1, $2::numeric)", [user.wallet.address, due.toString()]);
    env.clock.advance(SENT_STALE_SECONDS + 1n);
    assert.equal(await relayClaims(env.deps), 0);
    assert.equal((await claimRow(env, id)).status, "confirmed");
    assert.equal(paid(env, user), 0n, "nothing was sent");
  } finally {
    await env.close();
  }
});

test("claims: a transaction not seen to confirm stays open under its hash, and its receipt settles it", async () => {
  const env = await makeEnv();
  try {
    const { user, id, due } = await queuedClaim(env);
    env.chain.nextClaim = "unconfirmed";
    await assert.rejects(relayClaims(env.deps), /no receipt/);
    let row = await claimRow(env, id);
    assert.equal(row.status, "sent", "not failed: the user could otherwise never be told it was paid");
    assert.match(row.tx_hash!, /^0x[0-9a-f]{64}$/);
    assert.match(row.error!, /no receipt/);
    assert.equal(paid(env, user), due);
    assert.equal((await call(env, "POST", "/v1/rewards/claim", {}, auth(user))).json.status, "already_queued");

    env.clock.advance(SENT_STALE_SECONDS + 1n);
    assert.equal(await relayClaims(env.deps), 0);
    row = await claimRow(env, id);
    assert.deepEqual([row.status, row.error], ["confirmed", null]);
    assert.equal(paid(env, user), due, "paid once");
    const after = await call<{ claimable: string; claimed: string }>(env, "GET", "/v1/rewards", undefined, auth(user));
    assert.deepEqual([after.json.claimable, after.json.claimed], ["0", due.toString()]);
  } finally {
    await env.close();
  }
});

test("claims: a transaction that never lands is sent again after an hour, and one that reverted fails", async () => {
  const env = await makeEnv();
  try {
    const { user, id, due } = await queuedClaim(env);
    env.chain.nextClaim = "lost";
    await assert.rejects(relayClaims(env.deps), /no receipt/);
    const hash = (await claimRow(env, id)).tx_hash!;
    assert.ok(hash);

    // No receipt yet: it may still be mined, so it waits.
    env.clock.advance(SENT_STALE_SECONDS + 1n);
    assert.equal(await relayClaims(env.deps), 0);
    assert.deepEqual([(await claimRow(env, id)).status, (await claimRow(env, id)).tx_hash], ["sent", hash]);
    assert.equal(paid(env, user), 0n);

    env.clock.advance(SENT_DROPPED_SECONDS);
    assert.equal(await relayClaims(env.deps), 1);
    assert.equal((await claimRow(env, id)).status, "confirmed");
    assert.equal(paid(env, user), due);
  } finally {
    await env.close();
  }

  const other = await makeEnv();
  try {
    const { user, id } = await queuedClaim(other);
    other.chain.nextClaim = "lost";
    await assert.rejects(relayClaims(other.deps), /no receipt/);
    const hash = (await claimRow(other, id)).tx_hash!;
    other.chain.receipts.set(hash, { success: false, events: [] });
    other.clock.advance(SENT_STALE_SECONDS + 1n);
    assert.equal(await relayClaims(other.deps), 0);
    const row = await claimRow(other, id);
    assert.equal(row.status, "failed");
    assert.match(row.error!, /reverted/);
    // Nothing was paid, and the user can ask again.
    assert.equal(paid(other, user), 0n);
    assert.equal((await call(other, "POST", "/v1/rewards/claim", {}, auth(user))).json.status, "queued");
  } finally {
    await other.close();
  }
});

test("claims: failed only when nothing was sent or the transaction reverted, and the user can claim again", async () => {
  const env = await makeEnv();
  try {
    const { user, id, due } = await queuedClaim(env);
    let last = id;
    for (const [fault, message, hasHash] of [["down", /rpc down/, false], ["refused", /EnforcedPause/, false], ["reverted", /reverted/, true]] as const) {
      env.chain.nextClaim = fault;
      await assert.rejects(relayClaims(env.deps), message);
      const row = await claimRow(env, last);
      assert.equal(row.status, "failed", fault);
      assert.match(row.error!, message);
      assert.equal(row.tx_hash !== null, hasHash, fault);
      assert.equal(paid(env, user), 0n, fault);
      const again = await call<{ claimId: string; status: string }>(env, "POST", "/v1/rewards/claim", {}, auth(user));
      assert.equal(again.json.status, "queued", fault);
      last = again.json.claimId;
    }
    assert.equal(await relayClaims(env.deps), 1);
    assert.equal((await claimRow(env, last)).status, "confirmed");
    assert.equal(paid(env, user), due);
  } finally {
    await env.close();
  }
});

/** Asks the faucet for a drip to a fresh address, as a visitor would. */
async function askFaucet(env: TestEnv): Promise<string> {
  const address = privateKeyToAccount(generatePrivateKey()).address;
  assert.equal((await call(env, "POST", "/v1/faucet", { address, captchaToken: "dev-pass" })).json.status, "queued");
  return address;
}
async function faucetRow(env: TestEnv, address: string) {
  return (await env.deps.db.query<{ status: string; attempts: number; next_attempt_at: bigint; error: string | null; tx_hash: string | null }>(
    "SELECT status, attempts, next_attempt_at, error, tx_hash FROM faucet_requests WHERE address = $1",
    [address],
  )).rows[0]!;
}

test("faucet: a drip that fails for a passing reason stays queued and is tried again later", async () => {
  const env = await makeEnv();
  try {
    const address = await askFaucet(env);
    env.chain.dripErrors.push(new Error("rpc down"));
    assert.equal(await processFaucet(env.deps), 0);
    let row = await faucetRow(env, address);
    assert.deepEqual([row.status, row.attempts, row.error], ["queued", 1, "rpc down"]);
    assert.equal(row.next_attempt_at, env.clock.now() + 60n);

    // Not before its time.
    env.clock.advance(59n);
    assert.equal(await processFaucet(env.deps), 0);
    assert.equal(env.chain.drips.length, 0);
    assert.equal((await faucetRow(env, address)).attempts, 1);

    env.clock.advance(1n);
    assert.equal(await processFaucet(env.deps), 1);
    row = await faucetRow(env, address);
    assert.deepEqual([row.status, row.error], ["sent", null]);
    assert.deepEqual(env.chain.drips.map((d) => d.recipient), [address]);
  } finally {
    await env.close();
  }
});

test("faucet: a drip fails after a few tries, or at once when the contract refuses it", async () => {
  const env = await makeEnv();
  try {
    const unlucky = await askFaucet(env);
    const waits: bigint[] = [];
    for (let i = 1; i <= FAUCET_MAX_ATTEMPTS; i++) {
      env.chain.dripErrors.push(new Error("rpc down"));
      assert.equal(await processFaucet(env.deps), 0);
      const row = await faucetRow(env, unlucky);
      assert.equal(row.attempts, i);
      assert.equal(row.status, i < FAUCET_MAX_ATTEMPTS ? "queued" : "failed");
      if (row.status === "queued") waits.push(row.next_attempt_at - env.clock.now());
      env.clock.t = row.next_attempt_at;
    }
    assert.deepEqual(waits, [60n, 120n, 240n, 480n]);
    // Given up for good: later runs leave it alone.
    env.clock.advance(86_400n);
    assert.equal(await processFaucet(env.deps), 0);
    assert.equal(env.chain.drips.length, 0);

    const refused = await askFaucet(env);
    env.chain.dripErrors.push(new TxError("refused", "CoolingDown"));
    assert.equal(await processFaucet(env.deps), 0);
    const row = await faucetRow(env, refused);
    assert.deepEqual([row.status, row.attempts, row.error], ["failed", 1, "CoolingDown"]);
  } finally {
    await env.close();
  }
});

test("faucet: a drip not seen to confirm is never sent twice", async () => {
  const env = await makeEnv();
  try {
    const hash = `0x${"ab".repeat(32)}` as const;
    const landed = await askFaucet(env);
    env.chain.dripErrors.push(new TxError("unconfirmed", `no receipt for ${hash}`, hash));
    assert.equal(await processFaucet(env.deps), 0);
    let row = await faucetRow(env, landed);
    assert.deepEqual([row.status, row.attempts, row.tx_hash], ["queued", 1, hash]);
    assert.equal(row.next_attempt_at, env.clock.now() + FAUCET_UNCONFIRMED_WAIT);

    // It was mined after all: the row is closed with that hash and nothing more is sent.
    env.chain.receipts.set(hash, { success: true, events: [] });
    env.clock.advance(FAUCET_UNCONFIRMED_WAIT);
    assert.equal(await processFaucet(env.deps), 1);
    row = await faucetRow(env, landed);
    assert.deepEqual([row.status, row.tx_hash], ["sent", hash]);
    assert.equal(env.chain.drips.length, 0);

    // One that never landed has an expired voucher by then, and a fresh drip goes out.
    const dropped = await askFaucet(env);
    const gone = `0x${"ef".repeat(32)}` as const;
    env.chain.dripErrors.push(new TxError("unconfirmed", `no receipt for ${gone}`, gone));
    assert.equal(await processFaucet(env.deps), 0);
    env.clock.advance(FAUCET_UNCONFIRMED_WAIT);
    assert.equal(await processFaucet(env.deps), 1);
    assert.deepEqual(env.chain.drips.map((d) => d.recipient), [dropped]);
    assert.notEqual((await faucetRow(env, dropped)).tx_hash, gone);
  } finally {
    await env.close();
  }
});
