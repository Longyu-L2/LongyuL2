/** Mining in a browser (WEB_MINING): sign-in that returns to the web app, the human check in place of the device check, and the switch. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { pkceChallenge } from "../src/services/external.ts";
import {
  attest, auth, call, linkWallet, makeEnv, mine, raw, signUp, xAccount, xTicket, type TestEnv, type TestUser,
} from "./helpers.ts";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const WEB = "http://localhost:8081/";
const ON = { WEB_MINING: "true", WEB_AUTH_REDIRECT: WEB, WEB_ORIGINS: "https://testnet.longyu.network, http://localhost:8081" };
const INVALID_PAGE = "This sign-in link is no longer valid. Go back to the app and try again.";
const OFF = { status: 403, error: "web_mining_unavailable" };

type Session = { accessToken: string; refreshToken: string; newUser: boolean; error?: string };

/** Starts a sign-in as the web app does. */
async function startWeb(env: TestEnv, purpose: "sign-in" | "wallet-change" = "sign-in", headers: Record<string, string> = {}) {
  const appVerifier = randomBytes(32).toString("base64url");
  const r = await call<{ authorizeUrl: string; error?: string }>(
    env, "POST", "/v1/auth/x/start", { appChallenge: pkceChallenge(appVerifier), purpose, client: "web" }, headers,
  );
  return { status: r.status, error: r.json.error, appVerifier, state: r.status === 200 ? new URL(r.json.authorizeUrl).searchParams.get("state")! : "" };
}

/** The browser coming back from X: where the API sends it next. */
async function comeBack(env: TestEnv, state: string, name: string | { error: string }) {
  const account = typeof name === "string" ? xAccount(name) : null;
  const query = account ? `code=${encodeURIComponent(`dev:${account.id}:${account.username}`)}` : `error=${encodeURIComponent((name as { error: string }).error)}`;
  const res = await raw(env, `/v1/auth/x/callback?state=${encodeURIComponent(state)}&${query}`);
  return { status: res.status, body: res.body, location: typeof res.headers.location === "string" ? res.headers.location : undefined };
}

const ticketOf = (location: string | undefined) => /^http:\/\/localhost:8081\/#ticket=([A-Za-z0-9_-]{43})$/.exec(location ?? "")?.[1];

const finish = (env: TestEnv, t: { ticket: string; appVerifier: string }, platform: "ios" | "android" | "web", installId = "install-web-0001") =>
  call<Session>(env, "POST", "/v1/auth/x/finish", { ...t, installId, platform });

/** Signs in as `name` in a browser. */
async function webUser(env: TestEnv, name: string, installId = `web-install-${name}`): Promise<TestUser> {
  const flow = await startWeb(env);
  const ticket = ticketOf((await comeBack(env, flow.state, name)).location);
  assert.ok(ticket, "a ticket in the fragment");
  const r = await finish(env, { ticket, appVerifier: flow.appVerifier }, "web", installId);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { name, xId: xAccount(name).id, token: r.json.accessToken, refresh: r.json.refreshToken, wallet: privateKeyToAccount(generatePrivateKey()), installId };
}

/** The browser's device check: a human check's token where a phone sends a hardware proof. */
async function webCheck(env: TestEnv, u: TestUser, token = "dev-pass") {
  const c = await call<{ challengeId: string; nonce: string; error?: string }>(env, "POST", "/v1/device/challenge", {}, auth(u));
  if (c.status !== 200) return { status: c.status, json: c.json as Record<string, unknown> };
  return call(env, "POST", "/v1/device/attest", { challengeId: c.json.challengeId, token }, auth(u));
}

async function webMine(env: TestEnv, u: TestUser, body: Record<string, unknown> = { captchaToken: "dev-pass" }) {
  const c = await call<{ challengeId: string; pulseRequired: boolean; error?: string }>(env, "POST", "/v1/mining/challenge", {}, auth(u));
  if (c.status !== 200) return { status: c.status, json: c.json as Record<string, unknown>, pulseRequired: undefined };
  const r = await call(env, "POST", "/v1/mining/start", { challengeId: c.json.challengeId, ...body }, auth(u));
  return { ...r, pulseRequired: c.json.pulseRequired };
}

const platformOf = async (env: TestEnv, installId: string) =>
  (await env.deps.db.query<{ platform: string }>("SELECT platform FROM devices WHERE install_id = $1", [installId])).rows[0]?.platform;

// ------------------------------------------------------------------ sign-in

test("web sign-in: the callback returns to the web app with the ticket after a #, and the ticket opens a web session", async () => {
  const env = await makeEnv({ env: ON });
  try {
    const flow = await startWeb(env);
    assert.equal(flow.status, 200);
    assert.equal((await env.deps.db.query<{ client: string }>("SELECT client FROM x_logins")).rows[0]!.client, "web");

    const back = await comeBack(env, flow.state, "wei");
    assert.equal(back.status, 302);
    const ticket = ticketOf(back.location);
    assert.ok(ticket, back.location);
    assert.equal(new URL(back.location!).search, "", "nothing in the query, which servers log");

    const r = await finish(env, { ticket, appVerifier: flow.appVerifier }, "web");
    assert.equal(r.status, 200);
    assert.equal(r.json.newUser, true);
    assert.equal(await platformOf(env, "install-web-0001"), "web");

    // X refused, or the exchange failed: a fixed code after the #, never X's own text.
    const denied = await startWeb(env);
    assert.equal((await comeBack(env, denied.state, { error: "access_denied" })).location, `${WEB}#error=denied`);
    const failed = await startWeb(env);
    assert.equal((await comeBack(env, failed.state, { error: "server_error<script>" })).location, `${WEB}#error=failed`);

    // A sign-in the app started still returns to the app.
    const app = await xTicket(env, xAccount("wei"));
    assert.match(app.ticket, /^[A-Za-z0-9_-]{43}$/);
  } finally {
    await env.close();
  }
});

test("web sign-in: a ticket opens a session only for the client that started it", async () => {
  const env = await makeEnv({ env: ON });
  try {
    // Started by the web app, redeemed as a phone.
    const flow = await startWeb(env);
    const ticket = ticketOf((await comeBack(env, flow.state, "wei")).location)!;
    const asPhone = await finish(env, { ticket, appVerifier: flow.appVerifier }, "android");
    assert.equal(asPhone.status, 403);
    assert.equal(asPhone.json.error, "ticket_invalid");
    // The failed attempt used the ticket up.
    const again = await finish(env, { ticket, appVerifier: flow.appVerifier }, "web");
    assert.equal(again.status, 403);
    assert.equal(again.json.error, "ticket_invalid");

    // Started by the app, redeemed as a browser.
    const app = await xTicket(env, xAccount("wei"));
    const asWeb = await finish(env, app, "web");
    assert.equal(asWeb.status, 403);
    assert.equal(asWeb.json.error, "ticket_invalid");

    assert.equal(Number((await env.deps.db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM devices")).rows[0]!.n), 0);
    assert.equal(Number((await env.deps.db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM users")).rows[0]!.n), 0);
  } finally {
    await env.close();
  }
});

test("web sign-in: one account on a phone and in a browser, with a device of each kind", async () => {
  const env = await makeEnv({ env: ON });
  try {
    const phone = await signUp(env, "wei");
    // One X account completes one sign-in per half minute.
    env.clock.advance(30n);
    const browser = await webUser(env, "wei");
    const id = async (u: TestUser) => (await call<{ id: string }>(env, "GET", "/v1/me", undefined, auth(u))).json.id;
    assert.equal(await id(phone), await id(browser));
    assert.equal(await platformOf(env, phone.installId), "android");
    assert.equal(await platformOf(env, browser.installId), "web");
  } finally {
    await env.close();
  }
});

// ------------------------------------------------------- device check, mining

test("web device check: a human check moves the account to tier 1, and a failed one does not", async () => {
  const env = await makeEnv({ env: ON });
  try {
    const u = await webUser(env, "wei");
    // A phone's development proof is not a human check's token.
    const c = await call<{ challengeId: string; nonce: string }>(env, "POST", "/v1/device/challenge", {}, auth(u));
    const wrong = await call(env, "POST", "/v1/device/attest", { challengeId: c.json.challengeId, token: `dev:${c.json.nonce}` }, auth(u));
    assert.deepEqual(wrong.json, { attested: false, reason: "human check failed" });
    assert.equal((await call<{ tier: number }>(env, "GET", "/v1/me", undefined, auth(u))).json.tier, 0);
    // The challenge is spent either way.
    const replay = await call(env, "POST", "/v1/device/attest", { challengeId: c.json.challengeId, token: "dev-pass" }, auth(u));
    assert.notEqual(replay.json.attested, true);

    const ok = await webCheck(env, u);
    assert.deepEqual(ok.json, { attested: true });
    assert.equal((await call<{ tier: number }>(env, "GET", "/v1/me", undefined, auth(u))).json.tier, 1);
    const ev = (await env.deps.db.query<{ reason: string; to_tier: number }>("SELECT reason, to_tier FROM tier_events")).rows;
    assert.deepEqual(ev.map((e) => [e.reason, Number(e.to_tier)]), [["web_checked", 1]]);
    const d = (await env.deps.db.query<{ attestation_key_id: string | null; attestation_failures: number }>(
      "SELECT attestation_key_id, attestation_failures FROM devices WHERE install_id = $1", [u.installId],
    )).rows[0]!;
    assert.equal(d.attestation_key_id, null);
    assert.equal(Number(d.attestation_failures), 0);
  } finally {
    await env.close();
  }
});

test("web mining: every session needs the human check, and none needs a device proof", async () => {
  const env = await makeEnv({ env: ON });
  try {
    const u = await webUser(env, "wei");
    assert.equal((await webMine(env, u)).json.error, "device_not_attested");
    await webCheck(env, u);
    assert.equal((await linkWallet(env, u)).status, 200);

    // No token, a wrong token: refused, on every day (a phone is asked on some days only).
    for (const body of [{}, { captchaToken: "nope" }, { attestationToken: "dev:00" }]) {
      const r = await webMine(env, u, body);
      assert.equal(r.pulseRequired, true);
      assert.equal(r.status, 403, JSON.stringify(body));
      assert.equal(r.json.error, "pulse_failed");
    }
    for (let day = 0n; day < 6n; day++) {
      env.clock.at(day, 3600n);
      const r = await webMine(env, u);
      assert.equal(r.pulseRequired, true, `day ${day}`);
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    const s = (await env.deps.db.query<{ pulse_passed: boolean }>("SELECT pulse_passed FROM mining_sessions")).rows;
    assert.equal(s.length, 6);
    assert.ok(s.every((x) => x.pulse_passed));
  } finally {
    await env.close();
  }
});

test("web mining: a phone still has to prove its device at every session", async () => {
  const env = await makeEnv({ env: ON });
  try {
    const u = await signUp(env, "wei");
    await attest(env, u);
    await linkWallet(env, u);
    // A human check's token is not a phone's device check.
    const c0 = await call<{ challengeId: string }>(env, "POST", "/v1/device/challenge", {}, auth(u));
    assert.equal((await call(env, "POST", "/v1/device/attest", { challengeId: c0.json.challengeId, token: "dev-pass" }, auth(u))).json.attested, false);

    const c = await call<{ challengeId: string }>(env, "POST", "/v1/mining/challenge", {}, auth(u));
    const none = await call(env, "POST", "/v1/mining/start", { challengeId: c.json.challengeId, captchaToken: "dev-pass" }, auth(u));
    assert.equal(none.status, 400);
    assert.equal(none.json.error, "attestation_required");
    const bad = await call(env, "POST", "/v1/mining/start", { challengeId: c.json.challengeId, attestationToken: "dev:00", captchaToken: "dev-pass" }, auth(u));
    assert.equal(bad.status, 403);
    assert.equal(bad.json.error, "attestation_failed");
    assert.equal((await mine(env, u)).status, 200);
  } finally {
    await env.close();
  }
});

// ------------------------------------------------------------------- switch

test("web mining switched off: no web sign-in, and the phone app is untouched", async () => {
  const env = await makeEnv(); // WEB_MINING is off unless set
  try {
    const start = await startWeb(env);
    assert.deepEqual({ status: start.status, error: start.error }, OFF);
    assert.equal(Number((await env.deps.db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM x_logins")).rows[0]!.n), 0);

    const app = await xTicket(env, xAccount("wei"));
    const asWeb = await finish(env, app, "web");
    assert.deepEqual({ status: asWeb.status, error: asWeb.json.error }, OFF);
    // Refused before the ticket was looked at, so the app can still use it.
    assert.equal((await finish(env, app, "android")).status, 200);
  } finally {
    await env.close();
  }
});

test("web mining switched off later: browsers stop at once, at every step", async () => {
  const env = await makeEnv({ env: ON });
  try {
    const u = await webUser(env, "wei");
    await webCheck(env, u);
    await linkWallet(env, u);
    assert.equal((await webMine(env, u)).status, 200);
    const phone = await signUp(env, "lan");
    await attest(env, phone);
    await linkWallet(env, phone);

    const midway = await startWeb(env); // at X when the switch goes off
    const held = await call<{ challengeId: string }>(env, "POST", "/v1/mining/challenge", {}, auth(u)); // refused: one session a day
    assert.equal(held.status, 409);
    env.clock.at(1n, 3600n);
    const open = await call<{ challengeId: string }>(env, "POST", "/v1/mining/challenge", {}, auth(u));
    assert.equal(open.status, 200);

    env.deps.config.WEB_MINING = false;

    const back = await comeBack(env, midway.state, "wei");
    assert.equal(back.status, 400);
    assert.equal(back.body, INVALID_PAGE);
    assert.equal(back.location, undefined);

    const refused = async (r: { status: number; json: Record<string, unknown> }, what: string) =>
      assert.deepEqual({ status: r.status, error: r.json.error }, OFF, what);
    await refused(await call(env, "POST", "/v1/device/challenge", {}, auth(u)), "device challenge");
    await refused(await call(env, "POST", "/v1/device/attest", { challengeId: open.json.challengeId, token: "dev-pass" }, auth(u)), "device check");
    await refused(await call(env, "POST", "/v1/mining/challenge", {}, auth(u)), "mining challenge");
    await refused(await call(env, "POST", "/v1/mining/start", { challengeId: open.json.challengeId, captchaToken: "dev-pass" }, auth(u)), "mining start");
    assert.equal(Number((await env.deps.db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM mining_sessions WHERE user_id = (SELECT id FROM users WHERE x_username = 'wei')")).rows[0]!.n), 1);

    // The account, its balance and its wallet stay reachable from the browser.
    assert.equal((await call(env, "GET", "/v1/me", undefined, auth(u))).status, 200);
    assert.equal((await call(env, "GET", "/v1/mining/status", undefined, auth(u))).status, 200);
    // Phones go on as before.
    assert.equal((await mine(env, phone)).status, 200);
  } finally {
    await env.close();
  }
});

// ------------------------------------------------------------------- config

test("config: WEB_MINING needs the web app's own https address, listed in WEB_ORIGINS", () => {
  const base = { JWT_SECRET: "x".repeat(40), RPC_URL: "http://127.0.0.1:1", CHAIN_ID: "1", DISTRIBUTOR_ADDRESS: "0x0000000000000000000000000000000000000001" };
  const mine = "https://mine-testnet.longyu.network";
  assert.equal(loadConfig(base).WEB_MINING, false);
  assert.throws(() => loadConfig({ ...base, WEB_MINING: "true" }), /WEB_AUTH_REDIRECT is required with WEB_MINING/);
  const ok = loadConfig({ ...base, WEB_MINING: "true", WEB_AUTH_REDIRECT: `${mine}/`, WEB_ORIGINS: `https://testnet.longyu.network,${mine}` });
  assert.equal(ok.WEB_AUTH_REDIRECT, `${mine}/`);
  assert.throws(() => loadConfig({ ...base, WEB_MINING: "true", WEB_AUTH_REDIRECT: `${mine}/`, WEB_ORIGINS: "https://testnet.longyu.network" }), /must be listed in WEB_ORIGINS/);
  // Checked even while the switch is off, so a wrong address is found before it is used.
  assert.throws(() => loadConfig({ ...base, WEB_AUTH_REDIRECT: `${mine}/` }), /must be listed in WEB_ORIGINS/);
  for (const bad of [`${mine}/?next=1`, `${mine}/#x`, `${mine}/?`, `${mine}/#`, `https://user:pw@mine-testnet.longyu.network/`, "mine-testnet.longyu.network", "longyumine://auth"]) {
    assert.throws(() => loadConfig({ ...base, WEB_MINING: "true", WEB_AUTH_REDIRECT: bad, WEB_ORIGINS: mine }), /WEB_AUTH_REDIRECT/, bad);
  }
  assert.throws(
    () => loadConfig({ ...base, WEB_MINING: "true", WEB_AUTH_REDIRECT: "http://mine-testnet.longyu.network/", WEB_ORIGINS: "http://mine-testnet.longyu.network" }),
    /must be an https address/,
  );
  // Plain http on the same machine, for development only.
  assert.equal(loadConfig({ ...base, WEB_MINING: "true", WEB_AUTH_REDIRECT: "http://localhost:8081/", WEB_ORIGINS: "http://localhost:8081" }).WEB_MINING, true);
});
