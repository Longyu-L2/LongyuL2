import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../src/app.ts";
import { signWebhook } from "../src/services/external.ts";
import { processFaucet } from "../src/jobs/chain-jobs.ts";
import {
  ADMIN_KEYS,
  attest,
  auth,
  call,
  changeWallet,
  linkWallet,
  makeEnv,
  mine,
  readyUser,
  signUp,
  siwe,
  verifyDev,
} from "./helpers.ts";

test("sign-up with X, then /me", async () => {
  const env = await makeEnv();
  try {
    const u = await signUp(env, "alice");
    const me = await call<{ xUsername: string; tier: number; wallet: string | null }>(env, "GET", "/v1/me", undefined, auth(u));
    assert.equal(me.status, 200);
    assert.equal(me.json.xUsername, "alice");
    assert.ok(!("email" in me.json) && !("xId" in me.json));
    assert.equal(me.json.tier, 0);
    assert.equal(me.json.wallet, null);
    assert.equal((await call(env, "GET", "/v1/me")).status, 401);
    assert.equal((await call(env, "GET", "/v1/me", undefined, { authorization: "Bearer junk" })).status, 401);
  } finally {
    await env.close();
  }
});

test("refresh tokens rotate, and reuse ends the whole session", async () => {
  const env = await makeEnv();
  try {
    const u = await signUp(env, "carol");
    const r1 = await call<{ accessToken: string; refreshToken: string }>(env, "POST", "/v1/auth/refresh", { refreshToken: u.refresh });
    assert.equal(r1.status, 200);
    // Replaying the old token is treated as theft: every token in the family dies.
    assert.equal((await call(env, "POST", "/v1/auth/refresh", { refreshToken: u.refresh })).status, 401);
    assert.equal((await call(env, "POST", "/v1/auth/refresh", { refreshToken: r1.json.refreshToken })).status, 401);
    // Expired access tokens are rejected.
    env.clock.advance(31n * 86_400n);
    assert.equal((await call(env, "GET", "/v1/me", undefined, { authorization: `Bearer ${r1.json.accessToken}` })).status, 401);
  } finally {
    await env.close();
  }
});

test("device attestation moves a new account to T1; bad tokens count as failures", async () => {
  const env = await makeEnv();
  try {
    const u = await signUp(env, "dave");
    const c = await call<{ challengeId: string }>(env, "POST", "/v1/device/challenge", {}, auth(u));
    const bad = await call(env, "POST", "/v1/device/attest", { challengeId: c.json.challengeId, token: "dev:wrong" }, auth(u));
    assert.equal(bad.json.attested, false);
    // A challenge is single-use.
    assert.equal((await call(env, "POST", "/v1/device/attest", { challengeId: c.json.challengeId, token: "dev:x" }, auth(u))).status, 403);
    await attest(env, u);
    const me = await call<{ tier: number; deviceAttested: boolean }>(env, "GET", "/v1/me", undefined, auth(u));
    assert.equal(me.json.tier, 1);
    assert.equal(me.json.deviceAttested, true);
  } finally {
    await env.close();
  }
});

/** A verifier that accepts everything and keeps what it was asked, in order. */
function recordingVerifier(env: Awaited<ReturnType<typeof makeEnv>>) {
  const seen: { step: "attest" | "assert"; platform: string; token: string; nonce: string }[] = [];
  env.deps.attestation = {
    attest: async ({ platform, token, nonce }) => {
      seen.push({ step: "attest", platform, token, nonce });
      return { ok: true, keyId: "key", publicKey: "key", signCount: 0n };
    },
    assert: async ({ platform, token, nonce }) => {
      seen.push({ step: "assert", platform, token, nonce });
      return { ok: true };
    },
  };
  return seen;
}

/** A token shaped as the Android app sends it: "akey:" and base64 certificates joined by ".". */
const androidKeyToken = () => `akey:${[700, 520, 901].map((n) => randomBytes(n).toString("base64")).join(".")}`;

test("an Android key attestation token reaches the verifier, and the device attests to T1", async () => {
  const env = await makeEnv();
  try {
    const seen = recordingVerifier(env);
    const u = await signUp(env, "akey");
    const token = androidKeyToken();
    const c = await call<{ challengeId: string; nonce: string }>(env, "POST", "/v1/device/challenge", {}, auth(u));
    const r = await call(env, "POST", "/v1/device/attest", { challengeId: c.json.challengeId, token }, auth(u));
    assert.deepEqual(r.json, { attested: true });
    assert.deepEqual(seen, [{ step: "attest", platform: "android", token, nonce: c.json.nonce }]);
    const me = await call<{ tier: number; deviceAttested: boolean }>(env, "GET", "/v1/me", undefined, auth(u));
    assert.deepEqual([me.json.tier, me.json.deviceAttested], [1, true]);
    const device = (await env.deps.db.query<{ attestation_failures: number; attestation_key_id: string }>("SELECT attestation_failures, attestation_key_id FROM devices")).rows[0]!;
    assert.deepEqual([device.attestation_failures, device.attestation_key_id], [0, "key"]);
  } finally {
    await env.close();
  }
});

test("an Android key attestation token starts a mining session", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "akey", false);
    env.clock.at(0n, 3600n);
    const seen = recordingVerifier(env);
    const token = androidKeyToken();
    const c = await call<{ challengeId: string; nonce: string }>(env, "POST", "/v1/mining/challenge", {}, auth(u));
    const r = await call(env, "POST", "/v1/mining/start", { challengeId: c.json.challengeId, attestationToken: token, captchaToken: "dev-pass" }, auth(u));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(seen, [{ step: "assert", platform: "android", token, nonce: c.json.nonce }]);
    assert.equal(Number((await env.deps.db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM mining_sessions")).rows[0]!.n), 1);
    assert.equal((await env.deps.db.query<{ attestation_failures: number }>("SELECT attestation_failures FROM devices")).rows[0]!.attestation_failures, 0);
  } finally {
    await env.close();
  }
});

test("a malformed attestation token is refused before the verifier and counts as a failure", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "shape", false);
    env.clock.at(0n, 3600n);
    const seen = recordingVerifier(env);
    const good = androidKeyToken();
    // The prefix is read once, at the start: no ":" passes anywhere else, and the body keeps its bounds.
    const malformed = [`akey:${good}`, good.replace(".", ":"), `x${good}`, `${good} `, "akey:AAAA", "akey:", `play:${good.slice(5)}`];
    for (const token of malformed) {
      const c = await call<{ challengeId: string }>(env, "POST", "/v1/device/challenge", {}, auth(u));
      const r = await call(env, "POST", "/v1/device/attest", { challengeId: c.json.challengeId, token }, auth(u));
      assert.deepEqual(r.json, { attested: false, reason: "malformed token" }, token.slice(0, 12));
    }
    const failures = async () => (await env.deps.db.query<{ attestation_failures: number }>("SELECT attestation_failures FROM devices")).rows[0]!.attestation_failures;
    assert.equal(await failures(), malformed.length);
    const c = await call<{ challengeId: string }>(env, "POST", "/v1/mining/challenge", {}, auth(u));
    const start = await call(env, "POST", "/v1/mining/start", { challengeId: c.json.challengeId, attestationToken: `akey:${good}`, captchaToken: "dev-pass" }, auth(u));
    assert.deepEqual([start.status, start.json.error, start.json.message], [403, "attestation_failed", "malformed token"]);
    assert.equal(await failures(), malformed.length + 1);
    assert.deepEqual(seen, []);
  } finally {
    await env.close();
  }
});

test("wallet linking needs a valid SIWE signature and unique wallets; changes need a fresh sign-in with X and a cooldown", async () => {
  const env = await makeEnv();
  try {
    const u = await signUp(env, "erin");
    const v = await signUp(env, "frank");
    // Signature by a different key than the message's address.
    const s = await siwe(env, u);
    const forged = await privateKeyToAccount(generatePrivateKey()).signMessage({ message: s.message });
    assert.equal((await call(env, "POST", "/v1/wallet/link", { ...s, signature: forged }, auth(u))).status, 403);
    // Wrong chain ID.
    assert.equal((await call(env, "POST", "/v1/wallet/link", await siwe(env, u, u.wallet, 1), auth(u))).status, 400);

    assert.equal((await linkWallet(env, u)).status, 200);
    assert.equal((await linkWallet(env, v, u.wallet)).status, 409); // already someone else's
    const next = privateKeyToAccount(generatePrivateKey());
    assert.equal((await linkWallet(env, u, next)).json.error, "wallet_change_cooldown");
    env.clock.advance(7n * 86_400n);
    // A stolen session alone cannot move the wallet: a fresh sign-in with X is required.
    assert.equal((await linkWallet(env, u, next)).json.error, "reauth_required");
    const changed = await changeWallet(env, u, next);
    assert.equal(changed.json.changed, true);
    const kept = await env.deps.db.query<{ from_address: string; to_address: string }>("SELECT from_address, to_address FROM wallet_changes");
    assert.deepEqual(kept.rows, [{ from_address: u.wallet.address, to_address: next.address }]);
    // The old wallet can never be reused by anyone.
    assert.equal((await linkWallet(env, v, u.wallet)).status, 409);
  } finally {
    await env.close();
  }
});

test("mining needs attestation and a wallet, and credits one session per UTC day", async () => {
  const env = await makeEnv();
  try {
    const u = await signUp(env, "gina");
    assert.equal((await mine(env, u)).json.error, "device_not_attested");
    await attest(env, u);
    assert.equal((await mine(env, u)).json.error, "wallet_required");
    await linkWallet(env, u);

    env.clock.at(0n, 10n * 3600n);
    const s1 = await mine(env, u);
    assert.equal(s1.status, 200);
    assert.equal(s1.json.creditedDay, "0");
    assert.equal((await mine(env, u)).json.error, "session_not_available");

    // 20 hours later it is day 1, 06:00: allowed and credited to day 1.
    env.clock.at(1n, 6n * 3600n);
    const s2 = await mine(env, u);
    assert.equal(s2.json.creditedDay, "1");
    // Late on day 1, more than 20 hours later is impossible; and day 1 is already credited.
    env.clock.at(1n, 23n * 3600n);
    assert.equal((await mine(env, u)).json.error, "session_not_available");

    const status = await call<{ canStart: boolean; tier: number; balances: object }>(env, "GET", "/v1/mining/status", undefined, auth(u));
    assert.equal(status.json.canStart, false);
    assert.ok(status.json.balances);
  } finally {
    await env.close();
  }
});

test("a session with a pulse check needs a passing captcha", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "hank", false);
    env.clock.at(0n, 3600n);
    const c = await call<{ challengeId: string; nonce: string }>(env, "POST", "/v1/mining/challenge", {}, auth(u));
    await env.deps.db.query("UPDATE challenges SET pulse_required = TRUE WHERE id = $1", [c.json.challengeId]);
    const r = await call(env, "POST", "/v1/mining/start", { challengeId: c.json.challengeId, attestationToken: `dev:${c.json.nonce}` }, auth(u));
    assert.equal(r.json.error, "pulse_failed");
  } finally {
    await env.close();
  }
});

test("mainland China and sanctioned regions are blocked", async () => {
  const env = await makeEnv();
  try {
    const r = await call(env, "POST", "/v1/auth/x/start", { appChallenge: "A".repeat(43), purpose: "sign-in" }, { "cf-ipcountry": "CN" });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "region_blocked");
    const u = await readyUser(env, "ivy", false);
    assert.equal((await call(env, "POST", "/v1/mining/challenge", {}, { ...auth(u), "cf-ipcountry": "KP" })).json.error, "region_blocked");
  } finally {
    await env.close();
  }
});

test("verification lifts to T2 once per person; a second account of the same person is held", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "jack", false);
    const b = await readyUser(env, "jill", false);
    assert.equal((await verifyDev(env, a, "face-1")).json.result, "approved");
    assert.equal((await verifyDev(env, b, "face-1")).json.result, "duplicate");
    const tiers = await env.deps.db.query<{ x_username: string; tier: number }>("SELECT x_username, tier FROM users ORDER BY x_username");
    assert.deepEqual(tiers.rows.map((r) => r.tier), [2, 1]); // jack is T2, jill stays T1
    const flags = await call<{ flags: { kind: string }[] }>(env, "GET", "/v1/admin/flags", undefined, { "x-admin-key": ADMIN_KEYS.alice });
    assert.equal(flags.json.flags[0]?.kind, "duplicate_identity");
  } finally {
    await env.close();
  }
});

test("vendor webhooks must carry a valid HMAC signature", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "kate", false);
    const s = await call<{ reference: string }>(env, "POST", "/v1/verification/session", {}, auth(u));
    const body = JSON.stringify({ reference: s.json.reference, status: "approved", uniqueKey: "vendor-face-77" });
    const bad = await env.app.inject({ method: "POST", url: "/v1/verification/webhook", payload: body, headers: { "content-type": "application/json", "x-longyu-signature": "sha256=00" } });
    assert.equal(bad.statusCode, 401);
    const good = await env.app.inject({
      method: "POST", url: "/v1/verification/webhook", payload: body,
      headers: { "content-type": "application/json", "x-longyu-signature": signWebhook("whsec-0123456789abcdef", body) },
    });
    assert.equal(good.statusCode, 200);
    assert.equal(JSON.parse(good.body).result, "approved");
  } finally {
    await env.close();
  }
});

test("BABT holders verify for free by signing with their BSC address", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "liam", false);
    const bscWallet = privateKeyToAccount(generatePrivateKey());
    const noToken = await call(env, "POST", "/v1/verification/babt", await siwe(env, u, bscWallet, 56, "/v1/verification/babt/challenge"), auth(u));
    assert.equal(noToken.json.error, "no_babt");
    env.chain.babt.set(bscWallet.address.toLowerCase(), 1n);
    const ok = await call(env, "POST", "/v1/verification/babt", await siwe(env, u, bscWallet, 56, "/v1/verification/babt/challenge"), auth(u));
    assert.equal(ok.json.result, "approved");
    const me = await call<{ tier: number }>(env, "GET", "/v1/me", undefined, auth(u));
    assert.equal(me.json.tier, 2);
    // The same BABT cannot verify a second account.
    const other = await readyUser(env, "mia", false);
    const dup = await call(env, "POST", "/v1/verification/babt", await siwe(env, other, bscWallet, 56, "/v1/verification/babt/challenge"), auth(other));
    assert.equal(dup.json.result, "duplicate");
  } finally {
    await env.close();
  }
});

test("faucet: captcha, one request per address per day, queued for the relayer job", async () => {
  const env = await makeEnv();
  try {
    const addr = privateKeyToAccount(generatePrivateKey()).address;
    assert.equal((await call(env, "POST", "/v1/faucet", { address: addr, captchaToken: "nope" })).json.error, "captcha_failed");
    assert.equal((await call(env, "POST", "/v1/faucet", { address: "0x123", captchaToken: "dev-pass" })).status, 400);
    assert.equal((await call(env, "POST", "/v1/faucet", { address: addr, captchaToken: "dev-pass" })).json.status, "queued");
    assert.equal((await call(env, "POST", "/v1/faucet", { address: addr, captchaToken: "dev-pass" })).status, 429);
    assert.equal(await processFaucet(env.deps), 1);
    assert.equal(env.chain.drips.length, 1);
    // Spoofed X-Forwarded-For headers do not get around the per-network limit.
    for (let i = 0; i < 2; i++) {
      const a = privateKeyToAccount(generatePrivateKey()).address;
      await call(env, "POST", "/v1/faucet", { address: a, captchaToken: "dev-pass" }, { "x-forwarded-for": `10.0.0.${i}` });
    }
    const blocked = await call(env, "POST", "/v1/faucet", { address: privateKeyToAccount(generatePrivateKey()).address, captchaToken: "dev-pass" }, { "x-forwarded-for": "10.9.9.9" });
    assert.equal(blocked.json.error, "faucet_ip_limit");
  } finally {
    await env.close();
  }
});

test("admin: keys required, and bans need a second admin", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "noah");
    const userId = (await env.deps.db.query<{ id: string }>("SELECT id FROM users")).rows[0]!.id;
    assert.equal((await call(env, "GET", "/v1/admin/flags")).status, 401);
    assert.equal((await call(env, "GET", "/v1/admin/flags", undefined, { "x-admin-key": "wrong-key-wrong-key" })).status, 401);
    const req = await call<{ id: string }>(env, "POST", "/v1/admin/bans", { userId, reason: "bot farm" }, { "x-admin-key": ADMIN_KEYS.alice });
    const self = await call(env, "POST", `/v1/admin/bans/${req.json.id}/approve`, {}, { "x-admin-key": ADMIN_KEYS.alice });
    assert.equal(self.json.error, "second_admin_required");
    const ok = await call(env, "POST", `/v1/admin/bans/${req.json.id}/approve`, {}, { "x-admin-key": ADMIN_KEYS.bob });
    assert.equal(ok.json.status, "executed");
    assert.equal((await mine(env, u)).json.error, "account_restricted");
    // Banned users can still appeal.
    assert.equal((await call(env, "POST", "/v1/appeals", { message: "I am a real person, please review." }, auth(u))).status, 200);
    const appeals = await call<{ appeals: unknown[] }>(env, "GET", "/v1/admin/appeals", undefined, { "x-admin-key": ADMIN_KEYS.bob });
    assert.equal(appeals.json.appeals.length, 1);
  } finally {
    await env.close();
  }
});

test("public endpoints", async () => {
  const env = await makeEnv();
  try {
    assert.equal((await call(env, "GET", "/health")).json.ok, true);
    const net = await call<{ chainId: string; nativeCurrency: { symbol: string }; rewardToken: { symbol: string } }>(env, "GET", "/v1/network");
    assert.equal(net.json.chainId, "31337");
    assert.equal(net.json.nativeCurrency.symbol, "tBNB");
    assert.equal(net.json.rewardToken.symbol, "tLONG");
    assert.equal((await call(env, "GET", "/v1/stats")).status, 200);
    assert.equal((await call(env, "GET", "/v1/leaderboard")).status, 200);
    assert.equal((await call(env, "GET", "/data/roots/..%2Fsecret.json")).status, 400);
    assert.equal((await call(env, "GET", "/v1/rewards/proof/0x0000000000000000000000000000000000000001")).status, 404);
  } finally {
    await env.close();
  }
});

test("the human check cannot be re-rolled, and a new challenge cancels the old one", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "pulse", false);
    env.clock.at(0n, 3600n);
    const first = await call<{ challengeId: string; pulseRequired: boolean }>(env, "POST", "/v1/mining/challenge", {}, auth(u));
    for (let i = 0; i < 5; i++) {
      const again = await call<{ pulseRequired: boolean }>(env, "POST", "/v1/mining/challenge", {}, auth(u));
      assert.equal(again.json.pulseRequired, first.json.pulseRequired);
    }
    const stale = await call(env, "POST", "/v1/mining/start", { challengeId: first.json.challengeId, attestationToken: "dev:00", captchaToken: "dev-pass" }, auth(u));
    assert.equal(stale.json.error, "challenge_invalid");
  } finally {
    await env.close();
  }
});

test("failed session starts are counted and burn the challenge; repeated failures lock the device", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "fail", false);
    env.clock.at(0n, 3600n);
    const c = await call<{ challengeId: string; nonce: string }>(env, "POST", "/v1/mining/challenge", {}, auth(u));
    const bad = await call(env, "POST", "/v1/mining/start", { challengeId: c.json.challengeId, attestationToken: "dev:abcdef", captchaToken: "dev-pass" }, auth(u));
    assert.equal(bad.json.error, "attestation_failed");
    const retry = await call(env, "POST", "/v1/mining/start", { challengeId: c.json.challengeId, attestationToken: `dev:${c.json.nonce}`, captchaToken: "dev-pass" }, auth(u));
    assert.equal(retry.json.error, "challenge_invalid");
    const failures = await env.deps.db.query<{ attestation_failures: number }>("SELECT attestation_failures FROM devices");
    assert.equal(failures.rows[0]!.attestation_failures, 1);
    for (let i = 0; i < 9; i++) {
      const ch = await call<{ challengeId: string }>(env, "POST", "/v1/mining/challenge", {}, auth(u));
      await call(env, "POST", "/v1/mining/start", { challengeId: ch.json.challengeId, attestationToken: "dev:abcdef" }, auth(u));
    }
    assert.equal((await call(env, "POST", "/v1/mining/challenge", {}, auth(u))).json.error, "device_locked");
  } finally {
    await env.close();
  }
});

test("attestation older than 30 days is reported stale so the app re-attests", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "stale", false);
    assert.equal((await call<{ deviceAttested: boolean }>(env, "GET", "/v1/me", undefined, auth(u))).json.deviceAttested, true);
    // Age the attestation rather than the clock, so the test's access token stays valid.
    await env.deps.db.query("UPDATE devices SET attested_at = attested_at - $1", [31n * 86_400n]);
    assert.equal((await call<{ deviceAttested: boolean }>(env, "GET", "/v1/me", undefined, auth(u))).json.deviceAttested, false);
    assert.equal((await mine(env, u)).json.error, "device_not_attested");
    await attest(env, u);
    assert.equal((await mine(env, u)).status, 200);
  } finally {
    await env.close();
  }
});

test("banned users cannot change wallets, claim or verify, but can still appeal", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "ban", false);
    const userId = (await env.deps.db.query<{ id: string }>("SELECT id FROM users")).rows[0]!.id;
    const req = await call<{ id: string }>(env, "POST", "/v1/admin/bans", { userId, reason: "bot farm" }, { "x-admin-key": ADMIN_KEYS.alice });
    await call(env, "POST", `/v1/admin/bans/${req.json.id}/approve`, {}, { "x-admin-key": ADMIN_KEYS.bob });
    env.clock.advance(8n * 86_400n);
    assert.equal((await changeWallet(env, u, privateKeyToAccount(generatePrivateKey()))).json.error, "account_restricted");
    assert.equal((await call(env, "POST", "/v1/rewards/claim", {}, auth(u))).json.error, "account_restricted");
    assert.equal((await call(env, "POST", "/v1/verification/session", {}, auth(u))).json.error, "account_restricted");
    assert.equal((await call(env, "POST", "/v1/appeals", { message: "Please review my account." }, auth(u))).status, 200);
  } finally {
    await env.close();
  }
});

test("verifying the same account twice with the same identity is not an error", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "twice", false);
    assert.equal((await verifyDev(env, u, "face-9")).json.result, "approved");
    await env.deps.db.query("UPDATE users SET tier = 1");
    assert.equal((await verifyDev(env, u, "face-9")).json.result, "approved");
  } finally {
    await env.close();
  }
});

test("in production, requests without the CDN country header are refused", async () => {
  const env = await makeEnv({ env: { REQUIRE_COUNTRY: "true" } });
  try {
    const start = { appChallenge: "A".repeat(43), purpose: "sign-in" };
    assert.equal((await call(env, "POST", "/v1/auth/x/start", start)).json.error, "region_unknown");
    assert.equal((await call(env, "POST", "/v1/auth/x/start", start, { "cf-ipcountry": "SG" })).status, 200);
  } finally {
    await env.close();
  }
});

test("blank settings copied from .env.example count as unset", async () => {
  const { loadConfig } = await import("../src/config.ts");
  const c = loadConfig({
    JWT_SECRET: "x".repeat(40), RPC_URL: "http://127.0.0.1:1", CHAIN_ID: "1",
    DISTRIBUTOR_ADDRESS: "0x0000000000000000000000000000000000000001", PULSE_SECRET: "", VERIFICATION_WEBHOOK_SECRET: "  ",
  });
  assert.equal(c.PULSE_SECRET, undefined);
  assert.equal(c.VERIFICATION_WEBHOOK_SECRET, undefined);
  assert.throws(() => loadConfig({ JWT_SECRET: "x".repeat(40), RPC_URL: "http://127.0.0.1:1", CHAIN_ID: "1", DISTRIBUTOR_ADDRESS: "0x0000000000000000000000000000000000000001", TRUST_PROXY: "true" }), /spoof/);
});

test("a lost race for a unique row answers 409 conflict, not 500", async () => {
  const env = await makeEnv();
  const query = env.deps.db.query;
  try {
    const u = await signUp(env, "a");
    const failWith = (code: string) => {
      env.deps.db.query = async () => {
        throw Object.assign(new Error('duplicate key value violates unique constraint "wallets_address_key"'), { code });
      };
    };
    failWith("23505");
    const lost = await call(env, "POST", "/v1/appeals", { message: "Please review my account." }, auth(u));
    assert.deepEqual([lost.status, lost.json], [409, { error: "conflict" }], "and nothing of the database's message");
    // Any other database error is still a server error.
    failWith("40001");
    const other = await call(env, "POST", "/v1/appeals", { message: "Please review my account." }, auth(u));
    assert.deepEqual([other.status, other.json], [500, { error: "internal_error" }]);
  } finally {
    env.deps.db.query = query;
    await env.close();
  }
});

test("appeals: one open appeal per user, also when two arrive at once", async () => {
  const env = await makeEnv();
  try {
    const u = await signUp(env, "a");
    const post = () => call(env, "POST", "/v1/appeals", { message: "Please review my account." }, auth(u));
    const both = await Promise.all([post(), post()]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    assert.equal(both.find((r) => r.status === 409)!.json.error, "appeal_open");
    assert.equal((await post()).json.error, "appeal_open");

    // The database holds the rule by itself: a second open row is refused whoever writes it.
    const userId = (await env.deps.db.query<{ id: string }>("SELECT id FROM users")).rows[0]!.id;
    const insert = () =>
      env.deps.db.query("INSERT INTO appeals (id, user_id, message, created_at) VALUES ($1,$2,'written directly',$3)", [randomUUID(), userId, env.clock.now()]);
    await assert.rejects(insert(), (e: { code?: string }) => e.code === "23505");
    assert.equal(Number((await env.deps.db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM appeals")).rows[0]!.n), 1);
    // Once it is answered, the user may appeal again.
    await env.deps.db.query("UPDATE appeals SET status = 'denied'");
    assert.equal((await post()).status, 200);
  } finally {
    await env.close();
  }
});

test("migration 009: where a user already has several open appeals, the earliest stays open", async () => {
  const env = await makeEnv();
  try {
    for (const name of ["a", "b", "c"]) await signUp(env, name);
    const users = Object.fromEntries(
      (await env.deps.db.query<{ id: string; x_username: string }>("SELECT id, x_username FROM users")).rows.map((r) => [r.x_username, r.id]),
    );
    // The table as it was before the migration: nothing in the database stops a second open appeal.
    await env.deps.db.query("DROP INDEX appeals_one_open_idx");
    const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
    const rows: [number, string, string, bigint][] = [
      [1, "a", "open", 200n], [2, "a", "open", 100n], [3, "a", "open", 200n],
      // Written in the same second: the lower id counts as first.
      [5, "b", "open", 300n], [4, "b", "open", 300n], [6, "b", "upheld", 50n],
      [7, "c", "open", 400n],
    ];
    for (const [n, user, status, at] of rows) {
      await env.deps.db.query("INSERT INTO appeals (id, user_id, message, status, created_at) VALUES ($1,$2,'Please review.',$3,$4)", [id(n), users[user], status, at]);
    }

    const sql = readFileSync(new URL("../src/db/migrations/009_prelaunch_hardening.sql", import.meta.url), "utf8");
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(/;\s*(?:\n|$)/).map((s) => s.trim());
    const steps = statements.filter((s) => s.startsWith("UPDATE appeals") || s.startsWith("CREATE UNIQUE INDEX appeals_one_open_idx"));
    assert.equal(steps.length, 2);
    for (const step of steps) await env.deps.db.query(step);

    const after = (await env.deps.db.query<{ id: string; status: string; resolved_by: string | null; response: string | null }>(
      "SELECT id, status, resolved_by, response FROM appeals ORDER BY id",
    )).rows;
    assert.deepEqual(after.map((r) => r.status), ["denied", "open", "denied", "open", "denied", "upheld", "open"]);
    for (const r of after) {
      const closed = [id(1), id(3), id(5)].includes(r.id);
      assert.deepEqual([r.resolved_by, r.response], closed ? ["system", "Closed as a duplicate: your earlier appeal is still open."] : [null, null], r.id);
    }
    await assert.rejects(
      env.deps.db.query("INSERT INTO appeals (id, user_id, message, created_at) VALUES ($1,$2,'One more.',500)", [id(8), users.a]),
      (e: { code?: string }) => e.code === "23505",
    );
  } finally {
    await env.close();
  }
});

test("migration 012: failures counted against Android phones are taken back, with the locks and holds they led to", async () => {
  const env = await makeEnv();
  try {
    const a = await signUp(env, "a");
    for (const name of ["b", "c", "d"]) await signUp(env, name);
    const users = Object.fromEntries(
      (await env.deps.db.query<{ id: string; x_username: string }>("SELECT id, x_username FROM users")).rows.map((r) => [r.x_username, r.id]),
    );
    const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
    const lock = env.clock.now() + 80_000n;
    // Each account signed up with an Android phone; some also have another device.
    const phone = (user: string, failures: number, lockedUntil: bigint) =>
      env.deps.db.query("UPDATE devices SET attestation_failures = $1, attestation_locked_until = $2 WHERE user_id = $3", [failures, lockedUntil, users[user]]);
    const other = (n: number, user: string, platform: string, failures: number, lockedUntil = 0n) =>
      env.deps.db.query(
        "INSERT INTO devices (id, user_id, platform, install_id, attestation_failures, attestation_locked_until, created_at, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,0,0)",
        [id(n), users[user], platform, `other-${n}`, failures, lockedUntil],
      );
    const flag = (n: number, user: string, kind: string, status: string, detail: object, day: number) =>
      env.deps.db.query("INSERT INTO flags (id, user_id, kind, severity, detail, status, day, created_at) VALUES ($1,$2,$3,'hold',$4,$5,$6,0)", [
        id(n), users[user], kind, JSON.stringify(detail), status, day,
      ]);
    // a: mined in a browser while the phone's count grew.
    await phone("a", 12, lock);
    await other(1, "a", "web", 0);
    await flag(11, "a", "attestation_failures", "open", { failures: 7 }, 1);
    await flag(12, "a", "shared_device", "open", { installId: "install-a", users: 2 }, 1);
    await flag(13, "a", "attestation_failures", "confirmed", { failures: 5 }, 0);
    // b: an iPhone with failures of its own, so the hold stays.
    await phone("b", 6, 0n);
    await other(2, "b", "ios", 5);
    await flag(14, "b", "attestation_failures", "open", { failures: 6 }, 1);
    // c: the flag recorded more failures than the phone has, so another device was behind it.
    await phone("c", 2, 0n);
    await other(3, "c", "web", 0);
    await flag(15, "c", "attestation_failures", "open", { failures: 9 }, 1);
    // d: a browser's failures and lock are its own.
    await other(4, "d", "web", 11, lock);
    assert.equal((await call(env, "POST", "/v1/device/challenge", {}, auth(a))).json.error, "device_locked");

    const sql = readFileSync(new URL("../src/db/migrations/012_android_attestation_reset.sql", import.meta.url), "utf8");
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(statements.map((s) => s.slice(0, 14)), ["UPDATE flags S", "UPDATE devices"]);
    for (const step of statements) await env.deps.db.query(step);

    const devices = (await env.deps.db.query<{ platform: string; attestation_failures: number; attestation_locked_until: bigint }>(
      "SELECT platform, attestation_failures, attestation_locked_until FROM devices ORDER BY platform, install_id",
    )).rows.map((r) => [r.platform, r.attestation_failures, BigInt(r.attestation_locked_until)]);
    assert.deepEqual(devices, [
      ["android", 0, 0n], ["android", 0, 0n], ["android", 0, 0n], ["android", 0, 0n],
      ["ios", 5, 0n],
      ["web", 0, 0n], ["web", 0, 0n], ["web", 11, lock],
    ]);
    const flags = (await env.deps.db.query<{ id: string; status: string; resolved_by: string | null; resolved_at: bigint | null }>(
      "SELECT id, status, resolved_by, resolved_at FROM flags ORDER BY id",
    )).rows;
    assert.deepEqual(flags.map((r) => [r.status, r.resolved_by]), [["cleared", "system"], ["open", null], ["confirmed", null], ["open", null], ["open", null]]);
    assert.ok(BigInt(flags[0]!.resolved_at!) > 1_700_000_000n);
    // The phone can ask for a device check again.
    assert.equal((await call(env, "POST", "/v1/device/challenge", {}, auth(a))).status, 200);
  } finally {
    await env.close();
  }
});

test("push tokens: a user keeps the newest five", async () => {
  const env = await makeEnv();
  try {
    const u = await signUp(env, "a");
    const v = await signUp(env, "b");
    const register = async (who: typeof u, n: number) => {
      env.clock.advance(10n);
      assert.equal((await call(env, "POST", "/v1/push/register", { token: `ExponentPushToken[phone-${n}]` }, auth(who))).status, 200);
    };
    const tokensOf = async (name: string) =>
      (await env.deps.db.query<{ token: string }>(
        "SELECT p.token FROM push_tokens p JOIN users u ON u.id = p.user_id WHERE u.x_username = $1 ORDER BY p.created_at",
        [name],
      )).rows.map((r) => Number(/phone-(\d+)/.exec(r.token)![1]));
    await register(v, 100);
    for (let n = 1; n <= 5; n++) await register(u, n);
    assert.deepEqual(await tokensOf("a"), [1, 2, 3, 4, 5]);
    // The sixth pushes out the oldest.
    await register(u, 6);
    assert.deepEqual(await tokensOf("a"), [2, 3, 4, 5, 6]);
    // A phone that registers again counts as new, so the next one out is the one after it.
    await register(u, 2);
    await register(u, 7);
    assert.deepEqual(await tokensOf("a"), [4, 5, 6, 2, 7]);
    assert.deepEqual(await tokensOf("b"), [100], "another user's tokens are untouched");
  } finally {
    await env.close();
  }
});

test("the wallet link and BABT routes take ten requests a minute from one address", async () => {
  const env = await makeEnv();
  // The same app with rate limits on, as it runs when deployed.
  const limited = await buildApp(env.deps);
  try {
    for (const url of ["/v1/wallet/link", "/v1/verification/babt"]) {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await limited.inject({ method: "POST", url, payload: {} })).statusCode);
      assert.deepEqual(statuses, [...Array<number>(10).fill(401), 429], url);
    }
    // The limit is per route: the rest of the API still answers this address.
    assert.equal((await limited.inject({ method: "GET", url: "/v1/network" })).statusCode, 200);
  } finally {
    await limited.close();
    await env.close();
  }
});
