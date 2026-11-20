import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { TESTNET_LAUNCH_PARAMS, VERIFICATION_GATED_PARAMS } from "@longyu/reward-engine";
import { loadConfig } from "../src/config.ts";
import { rewardParams } from "../src/invites.ts";
import { settleNextDay } from "../src/jobs/settlement.ts";
import { uuid } from "../src/lib/util.ts";
import { E18, attest, auth, call, linkWallet, makeEnv, signUp, verifyDev, xAccount, xTicket, type TestEnv, type TestUser } from "./helpers.ts";

type Status = { estimatedPerHour: string; invites: { active: number; bps: number; bpsEach: number; capBps: number } };

const status = async (env: TestEnv, u: TestUser) => (await call<Status>(env, "GET", "/v1/mining/status", undefined, auth(u))).json;
const codeOf = async (env: TestEnv, u: TestUser) =>
  (await call<{ referralCode: string }>(env, "GET", "/v1/me", undefined, auth(u))).json.referralCode;
const cumulative = async (env: TestEnv, u: TestUser) =>
  (await env.deps.db.query<{ c: string }>("SELECT cumulative::text AS c FROM ledger_accounts WHERE address = $1", [u.wallet.address])).rows[0]?.c;
const idOf = async (env: TestEnv, u: TestUser) =>
  (await env.deps.db.query<{ id: string }>("SELECT id FROM users WHERE x_username = $1", [u.name])).rows[0]!.id;

/** A new account that can mine, signed up with `code` when one is given. */
async function join(env: TestEnv, name: string, code?: string, installId = `install-${name}`): Promise<TestUser> {
  const account = xAccount(name);
  const r = await call<{ accessToken: string; refreshToken: string }>(env, "POST", "/v1/auth/x/finish", {
    ...(await xTicket(env, account)), installId, platform: "android", ...(code ? { referralCode: code } : {}),
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const u: TestUser = { name, xId: account.id, token: r.json.accessToken, refresh: r.json.refreshToken, wallet: privateKeyToAccount(generatePrivateKey()), installId };
  await attest(env, u);
  assert.equal((await linkWallet(env, u)).status, 200);
  return u;
}

/** Starts a session for `u` from the network address `ip`. */
async function mineFrom(env: TestEnv, u: TestUser, ip: string): Promise<void> {
  const post = async (url: string, body: unknown) => {
    const r = await env.app.inject({ method: "POST", url, payload: body as never, headers: { "content-type": "application/json", ...auth(u) }, remoteAddress: ip });
    return { status: r.statusCode, json: JSON.parse(r.body) as Record<string, string> };
  };
  const c = await post("/v1/mining/challenge", {});
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const s = await post("/v1/mining/start", { challengeId: c.json.challengeId, attestationToken: `dev:${c.json.nonce}`, captchaToken: "dev-pass" });
  assert.equal(s.status, 200, JSON.stringify(s.json));
}

async function cycle(env: TestEnv, day: bigint) {
  env.clock.at(day + 1n, 16n * 60n);
  assert.equal(await settleNextDay(env.deps), day);
}

test("each invited miner adds 5% to the inviter's day, up to +25%, and the estimate is what settlement pays", async () => {
  const env = await makeEnv();
  try {
    const ann = await join(env, "ann");
    const code = await codeOf(env, ann);
    const friends: TestUser[] = [];
    for (let i = 1; i <= 6; i++) friends.push(await join(env, `friend${i}`, code));
    const sol = await join(env, "sol");

    // Day 0: two of the six mine, before the inviter does.
    await mineFrom(env, friends[0]!, "10.0.1.1");
    await mineFrom(env, friends[1]!, "10.0.1.2");
    assert.deepEqual((await status(env, ann)).invites, { active: 2, bps: 1000, bpsEach: 500, capBps: 2500 });
    await mineFrom(env, ann, "10.0.0.1");
    await mineFrom(env, sol, "10.0.2.1");
    const day0 = await status(env, ann);
    assert.deepEqual(day0.invites, { active: 2, bps: 1000, bpsEach: 500, capBps: 2500 });
    assert.equal(day0.estimatedPerHour, (11n * E18 / 10n).toString(), "24 x 1.10 a day");
    // The bonus is the inviter's alone: an invited account and an account without invites earn the base rate.
    assert.equal((await status(env, friends[0]!)).estimatedPerHour, E18.toString());
    assert.deepEqual((await status(env, sol)).invites, { active: 0, bps: 0, bpsEach: 500, capBps: 2500 });
    await cycle(env, 0n);
    assert.equal(await cumulative(env, ann), (264n * E18 / 10n).toString(), "24 x 1.10");
    assert.equal(await cumulative(env, friends[0]!), (24n * E18).toString());
    assert.equal(await cumulative(env, sol), (24n * E18).toString());

    // Day 1: all six mine. Five reach the cap, the sixth adds nothing.
    env.clock.at(1n, 3600n);
    await mineFrom(env, ann, "10.0.0.1");
    for (const [i, f] of friends.entries()) await mineFrom(env, f, `10.0.1.${i + 1}`);
    const day1 = await status(env, ann);
    assert.deepEqual(day1.invites, { active: 6, bps: 2500, bpsEach: 500, capBps: 2500 });
    assert.equal(day1.estimatedPerHour, (127n * E18 / 100n).toString(), "24 x (1 + 0.02 streak + 0.25) a day");
    await cycle(env, 1n);
    assert.equal(await cumulative(env, ann), (264n * E18 / 10n + 3048n * E18 / 100n).toString(), "day 1: 24 x 1.27");

    // Day 2: the six mine and the inviter does not. Nothing is paid to an inviter who is not mining.
    env.clock.at(2n, 3600n);
    for (const [i, f] of friends.entries()) await mineFrom(env, f, `10.0.1.${i + 1}`);
    await cycle(env, 2n);
    assert.equal(await cumulative(env, ann), (264n * E18 / 10n + 3048n * E18 / 100n).toString());

    // Day 3: the inviter mines alone and earns no bonus.
    env.clock.at(3n, 3600n);
    await mineFrom(env, ann, "10.0.0.1");
    assert.equal((await status(env, ann)).invites.active, 0);
    const before = BigInt((await cumulative(env, ann))!);
    const perHour = BigInt((await status(env, ann)).estimatedPerHour);
    await cycle(env, 3n);
    assert.equal(BigInt((await cumulative(env, ann))!) - before, perHour * 24n, "the day pays the estimate, without a bonus");
    assert.ok(perHour * 24n < 26n * E18);
  } finally {
    await env.close();
  }
});

test("an invited account counts only when it is someone else mining", async () => {
  const env = await makeEnv();
  try {
    const ann = await join(env, "ann");
    const code = await codeOf(env, ann);
    // The inviter has also signed in on a second install, which she does not mine from.
    await signUp(env, "ann", "install-spare");

    const clean = await join(env, "clean", code);
    const sameInstall = await join(env, "sameinstall", code, "install-spare");
    const sameNetwork = await join(env, "samenetwork", code);
    const pairA = await join(env, "paira", code);
    const pairB = await join(env, "pairb", code);
    const banned = await join(env, "banned", code);
    const held = await join(env, "held", code);
    await join(env, "resting", code);
    assert.equal((await call<{ invites: string }>(env, "GET", "/v1/me", undefined, auth(ann))).json.invites, "8");

    await mineFrom(env, ann, "10.0.0.1");
    await mineFrom(env, clean, "10.0.1.1");
    await mineFrom(env, sameInstall, "10.0.1.2");
    await mineFrom(env, sameNetwork, "10.0.0.1");
    await mineFrom(env, pairA, "2001:db8:5:5::a");
    await mineFrom(env, pairB, "2001:db8:5:5:1:2:3:4");
    await mineFrom(env, banned, "10.0.1.5");
    await mineFrom(env, held, "10.0.1.6");
    await env.deps.db.query("UPDATE users SET banned = TRUE WHERE id = $1", [await idOf(env, banned)]);
    await env.deps.db.query(
      "INSERT INTO flags (id, user_id, kind, severity, day, created_at) VALUES ($1, $2, 'manual_review', 'hold', 0, $3)",
      [uuid(), await idOf(env, held), env.clock.now()],
    );

    // Counted: `clean`, and the two on one network once between them.
    assert.deepEqual((await status(env, ann)).invites, { active: 2, bps: 1000, bpsEach: 500, capBps: 2500 });
    await cycle(env, 0n);
    assert.equal(await cumulative(env, ann), (264n * E18 / 10n).toString(), "24 x 1.10");
    // No account was held by the day's own rules: the guards above are the invite bonus's.
    const flags = (await env.deps.db.query<{ kind: string }>("SELECT kind FROM flags WHERE kind <> 'manual_review' AND severity = 'hold'")).rows;
    assert.deepEqual(flags, []);
  } finally {
    await env.close();
  }
});

test("an invited account below the entitled tier does not count", async () => {
  const env = await makeEnv({ rewards: VERIFICATION_GATED_PARAMS });
  try {
    const ann = await join(env, "ann");
    await verifyDev(env, ann);
    const code = await codeOf(env, ann);
    const verified = await join(env, "verified", code);
    await verifyDev(env, verified);
    const unverified = await join(env, "unverified", code);
    await mineFrom(env, ann, "10.0.0.1");
    await mineFrom(env, verified, "10.0.1.1");
    await mineFrom(env, unverified, "10.0.1.2");
    assert.equal((await status(env, ann)).invites.active, 1);
    await cycle(env, 0n);
    assert.equal(await cumulative(env, ann), (252n * E18 / 10n).toString(), "24 x 1.05");
  } finally {
    await env.close();
  }
});

test("INVITE_REWARD is the switch: off, invites add nothing", async () => {
  const base = { JWT_SECRET: "x".repeat(40), RPC_URL: "http://127.0.0.1:1", CHAIN_ID: "1", DISTRIBUTOR_ADDRESS: "0x0000000000000000000000000000000000000001" };
  assert.equal(rewardParams(loadConfig(base)).referralBpsPerInvite, 0n, "off unless it is set");
  assert.equal(rewardParams(loadConfig({ ...base, INVITE_REWARD: "false" })).referralBpsPerInvite, 0n);
  assert.deepEqual(rewardParams(loadConfig({ ...base, INVITE_REWARD: "true" })), TESTNET_LAUNCH_PARAMS);
  assert.equal(TESTNET_LAUNCH_PARAMS.referralBpsPerInvite, 500n);
  // Off changes the invite rate and nothing else.
  assert.deepEqual({ ...rewardParams(loadConfig(base)), referralBpsPerInvite: 500n }, TESTNET_LAUNCH_PARAMS);

  const env = await makeEnv({ rewards: rewardParams(loadConfig(base)) });
  try {
    const ann = await join(env, "ann");
    const friend = await join(env, "friend", await codeOf(env, ann));
    await mineFrom(env, ann, "10.0.0.1");
    await mineFrom(env, friend, "10.0.1.1");
    const s = await status(env, ann);
    assert.deepEqual(s.invites, { active: 0, bps: 0, bpsEach: 0, capBps: 2500 });
    assert.equal(s.estimatedPerHour, E18.toString());
    await cycle(env, 0n);
    assert.equal(await cumulative(env, ann), (24n * E18).toString());
  } finally {
    await env.close();
  }
});
