/** Sign-in with X: the start, callback and finish routes, wallet changes, settings and the X client. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { logRequest } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { cleanup } from "../src/jobs/chain-jobs.ts";
import { X_ACCOUNT_COOLOFF, X_CLIENT_DAILY_SIGNINS } from "../src/modules/auth.ts";
import { sha256Hex } from "../src/lib/util.ts";
import { xProvider } from "../src/server.ts";
import { DevX, XNotBilled, noX, pkceChallenge, telegramNotifier, xAvatar, xOAuth } from "../src/services/external.ts";
import {
  X_CALLBACK, auth, call, linkWallet, makeEnv, raw, signUp, siwe, startX, xAccount, xCallback, xTicket, type TestEnv, type TestUser,
} from "./helpers.ts";

const APP = "longyumine://auth";
const INVALID_PAGE = "This sign-in link is no longer valid. Go back to the app and try again.";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

type Session = { accessToken: string; refreshToken: string; newUser: boolean; error?: string };

const finish = (env: TestEnv, t: { ticket: string; appVerifier: string }, extra: Record<string, unknown> = {}) =>
  call<Session>(env, "POST", "/v1/auth/x/finish", { ...t, installId: "install-test-1", platform: "ios", ...extra });

const count = async (env: TestEnv, table: string) =>
  Number((await env.deps.db.query<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM ${table}`)).rows[0]!.n);

const me = async (env: TestEnv, token: string) =>
  (await call<{ id: string; xUsername: string; banned: boolean; referralCode: string; wallet: string | null }>(env, "GET", "/v1/me", undefined, auth({ token }))).json;

// ------------------------------------------------------------------- start

test("start: returns the X page, stores only a hash of the state, and checks its input", async () => {
  const env = await makeEnv();
  try {
    const flow = await startX(env);
    assert.match(flow.state, TOKEN);
    const rows = (await env.deps.db.query<Record<string, unknown>>("SELECT * FROM x_logins")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state_hash, sha256Hex(flow.state));
    assert.equal(rows[0]!.app_challenge, pkceChallenge(flow.appVerifier));
    assert.equal(rows[0]!.purpose, "sign-in");
    assert.equal(rows[0]!.user_id, null);
    assert.equal(rows[0]!.expires_at, env.clock.now() + 600n);
    assert.ok(!JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes(flow.state), "the state itself is not stored");
    assert.ok(!JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes(flow.appVerifier), "the app never sends its verifier to start");

    const bad = [
      { purpose: "sign-in" },
      { appChallenge: "short", purpose: "sign-in" },
      { appChallenge: "A".repeat(44), purpose: "sign-in" },
      { appChallenge: `${"A".repeat(42)}+`, purpose: "sign-in" },
      { appChallenge: "A".repeat(43), purpose: "admin" },
      { appChallenge: "A".repeat(43) },
    ];
    for (const body of bad) assert.equal((await call(env, "POST", "/v1/auth/x/start", body)).status, 400, JSON.stringify(body));
    assert.equal(await count(env, "x_logins"), 1);
  } finally {
    await env.close();
  }
});

test("start: a wallet change needs a signed-in user and is bound to that user; a sign-in never is", async () => {
  const env = await makeEnv();
  try {
    const body = { appChallenge: "A".repeat(43), purpose: "wallet-change" };
    assert.equal((await call(env, "POST", "/v1/auth/x/start", body)).status, 401);
    assert.equal((await call(env, "POST", "/v1/auth/x/start", body, { authorization: "Bearer junk" })).status, 401);
    assert.equal(await count(env, "x_logins"), 0);

    const u = await signUp(env, "walt");
    const id = (await me(env, u.token)).id;
    await startX(env, "wallet-change", auth(u));
    await startX(env, "sign-in", auth(u));
    const rows = (await env.deps.db.query<{ purpose: string; user_id: string | null }>(
      "SELECT purpose, user_id FROM x_logins WHERE consumed_at IS NULL ORDER BY purpose",
    )).rows;
    assert.deepEqual(rows, [{ purpose: "sign-in", user_id: null }, { purpose: "wallet-change", user_id: id }]);
    // The table itself refuses a wallet change bound to no one and a sign-in bound to someone.
    await assert.rejects(env.deps.db.query("UPDATE x_logins SET user_id = NULL WHERE purpose = 'wallet-change'"));
    await assert.rejects(env.deps.db.query("UPDATE x_logins SET user_id = $1 WHERE purpose = 'sign-in'", [id]));
    await assert.rejects(env.deps.db.query("UPDATE x_logins SET purpose = 'sign-in' WHERE purpose = 'wallet-change'"));
  } finally {
    await env.close();
  }
});

test("start: without X settings sign-in is refused, not replaced by a stand-in", async () => {
  const env = await makeEnv();
  try {
    env.deps.x = noX;
    const r = await call(env, "POST", "/v1/auth/x/start", { appChallenge: "A".repeat(43), purpose: "sign-in" });
    assert.deepEqual([r.status, r.json.error], [503, "sign_in_unavailable"]);
    assert.equal(await count(env, "x_logins"), 0);
  } finally {
    await env.close();
  }
});

// ---------------------------------------------------------------- callback

test("callback: redirects into the app with a one-time ticket, and nowhere else", async () => {
  const env = await makeEnv();
  try {
    const flow = await startX(env);
    const account = xAccount("alice");
    const url = `/v1/auth/x/callback?state=${flow.state}&code=${encodeURIComponent(`dev:${account.id}:alice`)}` +
      "&redirect_uri=https%3A%2F%2Fevil.example&redirect=https%3A%2F%2Fevil.example&next=%2F%2Fevil.example&ticket=mine";
    const r = await raw(env, url, { origin: "https://evil.example" });
    assert.equal(r.status, 302);
    const location = String(r.headers.location);
    assert.match(location, /^longyumine:\/\/auth\?ticket=[A-Za-z0-9_-]{43}$/);
    assert.equal(r.body, "");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["access-control-allow-origin"], undefined);
    assert.equal(r.headers["set-cookie"], undefined);

    // Only hashes of the state and the ticket are kept.
    const ticket = new URL(location).searchParams.get("ticket")!;
    const row = (await env.deps.db.query<{ ticket_hash: string; ticket_expires_at: bigint; x_id: string; x_username: string; consumed_at: bigint }>(
      "SELECT ticket_hash, ticket_expires_at, x_id, x_username, consumed_at FROM x_logins",
    )).rows[0]!;
    assert.deepEqual(row, { ticket_hash: sha256Hex(ticket), ticket_expires_at: env.clock.now() + 300n, x_id: account.id, x_username: "alice", consumed_at: env.clock.now() });
    assert.notEqual(ticket, flow.state);
  } finally {
    await env.close();
  }

  // The target is the configured link, whatever the request says.
  const web = await makeEnv({ env: { APP_AUTH_REDIRECT: "https://app.longyu.network/auth" } });
  try {
    const flow = await startX(web);
    const back = await xCallback(web, flow.state, xAccount("alice"));
    assert.match(back.location!, /^https:\/\/app\.longyu\.network\/auth\?ticket=[A-Za-z0-9_-]{43}$/);
    const denied = await xCallback(web, (await startX(web)).state, { error: "access_denied" });
    assert.equal(denied.location, "https://app.longyu.network/auth?error=denied");
  } finally {
    await web.close();
  }
});

test("callback: a state works once", async () => {
  const env = await makeEnv();
  try {
    const flow = await startX(env);
    const first = await xCallback(env, flow.state, xAccount("alice"));
    assert.equal(first.status, 302);
    const again = await xCallback(env, flow.state, xAccount("mallory"));
    assert.equal(again.status, 400);
    assert.equal(again.body, INVALID_PAGE);
    assert.equal(again.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(again.location, undefined);
    assert.equal(again.headers["cache-control"], "no-store");
    assert.deepEqual(env.x.exchanges, [xAccount("alice")], "the second code never reached X");
    // The ticket from the first answer is unaffected.
    assert.equal((await finish(env, { ticket: first.ticket!, appVerifier: flow.appVerifier })).status, 200);

    // Two answers at the same moment: one gets through.
    const race = await startX(env);
    const both = await Promise.all([xCallback(env, race.state, xAccount("bob")), xCallback(env, race.state, xAccount("bob"))]);
    assert.deepEqual(both.map((b) => b.status).sort(), [302, 400]);
    assert.equal(env.x.exchanges.length, 2);
  } finally {
    await env.close();
  }
});

test("callback: an unknown, malformed or expired state gets a plain page, never a redirect", async () => {
  const env = await makeEnv();
  try {
    const unknown = ["A".repeat(43), "", "short", "<script>alert(1)</script>", `${"A".repeat(42)}%0d`, "A".repeat(500)];
    for (const state of unknown) {
      const r = await raw(env, `/v1/auth/x/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent("dev:5:eve")}`);
      assert.deepEqual([r.status, r.body, r.headers.location], [400, INVALID_PAGE, undefined], state);
      assert.equal(r.headers["content-type"], "text/plain; charset=utf-8");
    }
    for (const url of ["/v1/auth/x/callback", "/v1/auth/x/callback?code=x", "/v1/auth/x/callback?error=access_denied"]) {
      assert.deepEqual([(await raw(env, url)).status, (await raw(env, url)).headers.location], [400, undefined], url);
    }

    // The same state twice in the query is not a state.
    const twice = await startX(env);
    const dup = await raw(env, `/v1/auth/x/callback?state=${twice.state}&state=${twice.state}&code=${encodeURIComponent("dev:5:eve")}`);
    assert.equal(dup.status, 400);

    // Ten minutes to approve at X: the last second works, the next does not.
    const late = await startX(env);
    const onTime = await startX(env);
    env.clock.advance(600n);
    assert.equal((await xCallback(env, onTime.state, xAccount("alice"))).status, 302);
    env.clock.advance(1n);
    const expired = await xCallback(env, late.state, xAccount("alice"));
    assert.deepEqual([expired.status, expired.body, expired.location], [400, INVALID_PAGE, undefined]);
    assert.equal(env.x.exchanges.length, 1);
  } finally {
    await env.close();
  }
});

test("callback: X's error, a missing code or a failed exchange send a fixed error code to the app", async () => {
  const env = await makeEnv();
  try {
    const denied = await startX(env);
    const r = await xCallback(env, denied.state, { error: "access_denied" });
    assert.deepEqual([r.status, r.location, r.body], [302, `${APP}?error=denied`, ""]);
    assert.equal(r.headers["cache-control"], "no-store");
    // The state is spent: a code sent afterwards is not accepted.
    assert.equal((await xCallback(env, denied.state, xAccount("alice"))).status, 400);

    // Nothing the caller sends is copied into the redirect.
    const texts = ["https://evil.example/?a=1", "longyumine://auth?ticket=AAAA", "<script>alert(1)</script>", "x\r\nLocation: https://evil.example", ""];
    for (const text of texts) {
      const flow = await startX(env);
      const back = await raw(env, `/v1/auth/x/callback?state=${flow.state}&error=${encodeURIComponent(text)}&error_description=${encodeURIComponent(text)}&code=${encodeURIComponent("dev:5:eve")}`);
      assert.deepEqual([back.status, back.headers.location], [302, `${APP}?error=failed`], text);
    }

    const noCode = await startX(env);
    assert.equal((await raw(env, `/v1/auth/x/callback?state=${noCode.state}`)).headers.location, `${APP}?error=failed`);
    const longCode = await startX(env);
    assert.equal((await raw(env, `/v1/auth/x/callback?state=${longCode.state}&code=${"a".repeat(2001)}`)).headers.location, `${APP}?error=failed`);
    assert.equal(env.x.exchanges.length, 0, "X was never called");

    // X refuses the code.
    for (const code of ["nope", "dev:abc:eve", "dev:5:not a name", "dev:5:eve:extra", "dev:0:eve"]) {
      const flow = await startX(env);
      const back = await raw(env, `/v1/auth/x/callback?state=${flow.state}&code=${encodeURIComponent(code)}`);
      assert.deepEqual([back.status, back.headers.location], [302, `${APP}?error=failed`], code);
    }
    assert.equal(env.x.exchanges.length, 0);
    assert.equal(Number((await env.deps.db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM x_logins WHERE ticket_hash IS NOT NULL")).rows[0]!.n), 0);
    assert.equal(await count(env, "users"), 0);
  } finally {
    await env.close();
  }
});

test("callback: a day has a ceiling on sign-ins sent to X, and past it nobody is sent", async () => {
  const env = await makeEnv({ env: { X_DAILY_SIGNIN_LIMIT: "3" } });
  try {
    const used = async () =>
      (await env.deps.db.query<{ day: bigint; exchanges: number }>("SELECT day, exchanges FROM x_signin_days ORDER BY day")).rows.map((r) => [r.day, r.exchanges]);
    const today = env.clock.now() / 86_400n;
    const approve = async (name: string) => xCallback(env, (await startX(env)).state, xAccount(name));

    // A code X refuses before it reads the account costs nothing, and does not use up the day.
    for (let i = 0; i < 5; i++) {
      const flow = await startX(env);
      assert.equal((await raw(env, `/v1/auth/x/callback?state=${flow.state}&code=nope`)).headers.location, `${APP}?error=failed`);
    }
    assert.equal((await xCallback(env, (await startX(env)).state, { error: "access_denied" })).location, `${APP}?error=denied`);
    assert.deepEqual(await used(), [[today, 0]]);

    assert.ok((await approve("ann")).ticket);
    assert.ok((await approve("ben")).ticket);
    // A failure after the account was read is billed all the same, so it counts.
    const exchange = env.x.exchange;
    env.x.exchange = async () => {
      throw new Error("X user read failed: 429");
    };
    assert.equal((await approve("cy")).location, `${APP}?error=failed`);
    env.x.exchange = exchange;
    assert.deepEqual(await used(), [[today, 3]]);

    // The ceiling is reached: refused with its own code, and X is not asked.
    const flow = await startX(env);
    const refused = await xCallback(env, flow.state, xAccount("dee"));
    assert.deepEqual([refused.status, refused.location, refused.body], [302, `${APP}?error=paused`, ""]);
    assert.equal(env.x.exchanges.length, 2);
    assert.deepEqual(await used(), [[today, 3]]);
    assert.equal((await xCallback(env, flow.state, xAccount("dee"))).status, 400, "the state is spent");
    assert.equal(await count(env, "users"), 0);
    // Nothing went to X for it, so it is not counted against the client either.
    assert.equal((await env.deps.db.query<{ exchanges: number }>("SELECT exchanges FROM x_signin_clients")).rows[0]!.exchanges, 3);

    // The count starts again at 00:00 UTC.
    env.clock.t = (today + 1n) * 86_400n;
    assert.ok((await approve("dee")).ticket);
    assert.deepEqual(await used(), [[today, 3], [today + 1n, 1]]);
  } finally {
    await env.close();
  }
});

test("callback: one client has a ceiling of its own for the day, and past it the others still sign in", async () => {
  const env = await makeEnv();
  try {
    const HOME = "203.0.113.7";
    const sent = async () =>
      (await env.deps.db.query<{ day: bigint; client: string; exchanges: number }>(
        "SELECT day, client, exchanges FROM x_signin_clients ORDER BY day, client",
      )).rows.map((r) => [r.day, r.client, r.exchanges]);
    const today = env.clock.now() / 86_400n;
    const from = async (remoteAddress: string, code: string) => {
      const flow = await startX(env);
      const res = await env.app.inject({ method: "GET", url: `/v1/auth/x/callback?state=${flow.state}&code=${encodeURIComponent(code)}`, remoteAddress });
      return { status: res.statusCode, location: String(res.headers.location) };
    };
    const approve = (remoteAddress: string, name: string) => {
      const account = xAccount(name);
      return from(remoteAddress, `dev:${account.id}:${account.username}`);
    };

    // A code X refuses before it reads the account does not use up the client's day.
    for (let i = 0; i < 3; i++) assert.equal((await from(HOME, "nope")).location, `${APP}?error=failed`);
    assert.deepEqual(await sent(), [[today, HOME, 0]]);

    for (let i = 0; i < X_CLIENT_DAILY_SIGNINS; i++) assert.match((await approve(HOME, `home${i}`)).location, /\?ticket=/, `sign-in ${i + 1}`);
    assert.equal(env.x.exchanges.length, X_CLIENT_DAILY_SIGNINS);

    // One more from the same client: refused with its own code, and X is not asked.
    const refused = await approve(HOME, "late");
    assert.deepEqual([refused.status, refused.location], [302, `${APP}?error=too_many`]);
    assert.equal(env.x.exchanges.length, X_CLIENT_DAILY_SIGNINS);
    assert.deepEqual(await sent(), [[today, HOME, X_CLIENT_DAILY_SIGNINS]]);
    assert.equal((await env.deps.db.query<{ exchanges: number }>("SELECT exchanges FROM x_signin_days")).rows[0]!.exchanges, X_CLIENT_DAILY_SIGNINS);

    // Another client is not held back. Addresses in one IPv6 /64 are one client.
    assert.match((await approve("198.51.100.9", "other")).location, /\?ticket=/);
    assert.match((await approve("2001:db8:1:2::1", "sixa")).location, /\?ticket=/);
    assert.match((await approve("2001:db8:1:2:aaaa::5", "sixb")).location, /\?ticket=/);
    assert.deepEqual(await sent(), [
      [today, "198.51.100.9", 1], [today, "2001:db8:1:2::", 2], [today, HOME, X_CLIENT_DAILY_SIGNINS],
    ]);

    // The count starts again at 00:00 UTC.
    env.clock.t = (today + 1n) * 86_400n;
    assert.match((await approve(HOME, "late")).location, /\?ticket=/);
    assert.deepEqual((await sent()).at(-1), [today + 1n, HOME, 1]);

    // Counts of days before yesterday are dropped by the cleanup.
    await cleanup(env.deps);
    assert.equal((await sent()).length, 4);
    env.clock.t = (today + 2n) * 86_400n;
    await cleanup(env.deps);
    assert.deepEqual(await sent(), [[today + 1n, HOME, 1]]);
  } finally {
    await env.close();
  }
});

test("callback: one X account completes one sign-in of a kind per half minute", async () => {
  const env = await makeEnv();
  try {
    const alice = xAccount("alice");
    const u = await signUp(env, "alice");
    const tickets = async () =>
      Number((await env.deps.db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM x_logins WHERE ticket_hash IS NOT NULL")).rows[0]!.n);
    // The other kind of sign-in is not held back: a wallet change may follow a sign-in at once.
    const change = await startX(env, "wallet-change", auth(u));
    assert.ok((await xCallback(env, change.state, alice)).ticket);
    assert.equal(await tickets(), 2);

    env.clock.advance(X_ACCOUNT_COOLOFF - 1n);
    const flow = await startX(env);
    const soon = await xCallback(env, flow.state, alice);
    assert.deepEqual([soon.status, soon.location, soon.body], [302, `${APP}?error=too_soon`, ""]);
    const row = (await env.deps.db.query<{ x_id: string | null; ticket_hash: string | null }>(
      "SELECT x_id, ticket_hash FROM x_logins WHERE state_hash = $1",
      [sha256Hex(flow.state)],
    )).rows[0]!;
    assert.deepEqual(row, { x_id: null, ticket_hash: null }, "the attempt holds no account and no ticket");
    const changeAgain = await startX(env, "wallet-change", auth(u));
    assert.equal((await xCallback(env, changeAgain.state, alice)).location, `${APP}?error=too_soon`);
    assert.equal(await tickets(), 2);

    // Another account is not affected.
    assert.ok((await xCallback(env, (await startX(env)).state, xAccount("bob"))).ticket);

    // Half a minute after the completed sign-in, the account signs in again. Refused tries did not push that back.
    env.clock.advance(1n);
    const later = await startX(env);
    const back = await xCallback(env, later.state, alice);
    assert.ok(back.ticket);
    assert.equal((await finish(env, { ticket: back.ticket, appVerifier: later.appVerifier })).status, 200);
    assert.equal(await count(env, "users"), 1);
  } finally {
    await env.close();
  }
});

test("callback: answers GET only, and is not exempt from the origin secret", async () => {
  const env = await makeEnv();
  try {
    const flow = await startX(env);
    const url = `/v1/auth/x/callback?state=${flow.state}&code=${encodeURIComponent("dev:5:eve")}`;
    for (const method of ["HEAD", "POST", "OPTIONS"] as const) {
      const r = await env.app.inject({ method, url });
      assert.ok(r.statusCode === 404 || r.statusCode === 400 || r.statusCode === 204, `${method} ${r.statusCode}`);
      assert.equal(r.headers.location, undefined);
    }
    assert.equal(env.x.exchanges.length, 0);
    assert.equal((await raw(env, url)).status, 302, "the state was not spent by the other methods");
  } finally {
    await env.close();
  }

  const secret = "origin-secret-0123456789-0123456789-abcdef";
  const guarded = await makeEnv({ env: { ORIGIN_SECRET: secret } });
  try {
    const via = { "x-longyu-origin": secret, "cf-ipcountry": "SG" };
    const flow = await startX(guarded, "sign-in", via);
    const url = `/v1/auth/x/callback?state=${flow.state}&code=${encodeURIComponent("dev:5:eve")}`;
    const direct = await raw(guarded, url);
    assert.deepEqual([direct.status, JSON.parse(direct.body).error], [403, "origin_required"]);
    assert.equal((await raw(guarded, url, via)).status, 302);
  } finally {
    await guarded.close();
  }
});

test("callback: the state and X's code are left out of the request log", () => {
  const req = { method: "GET", url: "/v1/auth/x/callback?state=SECRETSTATE&code=SECRETCODE", headers: {}, host: "api.longyu.network", ip: "203.0.113.7", socket: { remotePort: 1 } };
  const logged = logRequest(req as never);
  assert.equal(logged.url, "/v1/auth/x/callback");
  assert.ok(!JSON.stringify(logged).includes("SECRET"));
  assert.equal(logRequest({ ...req, url: "/v1/network?x=1" } as never).url, "/v1/network?x=1");
});

// ------------------------------------------------------------------ finish

test("finish: the ticket needs the verifier the app kept, and a wrong one uses the ticket up", async () => {
  const env = await makeEnv();
  try {
    const t = await xTicket(env, xAccount("alice"));
    const other = await startX(env);
    for (const appVerifier of [other.appVerifier, "A".repeat(43), `${t.appVerifier}A`]) {
      // (Each attempt needs a fresh ticket to show that the verifier alone decides.)
      const fresh = appVerifier === other.appVerifier ? t : await xTicket(env, xAccount("alice"));
      const r = await finish(env, { ticket: fresh.ticket, appVerifier });
      assert.deepEqual([r.status, r.json.error], [403, "ticket_invalid"]);
      const retry = await finish(env, fresh);
      assert.deepEqual([retry.status, retry.json.error], [403, "ticket_invalid"], "a failed attempt spends the ticket");
    }
    assert.equal(await count(env, "users"), 0);
    assert.equal(await count(env, "refresh_tokens"), 0);

    // Malformed input is refused before the ticket is looked at.
    const good = await xTicket(env, xAccount("alice"));
    for (const body of [
      { ...good, appVerifier: "short" }, { ...good, appVerifier: "A".repeat(129) }, { ...good, appVerifier: `${"A".repeat(43)}+` },
      { ...good, ticket: "short" }, { ...good, ticket: undefined }, { ...good, appVerifier: undefined },
    ]) {
      assert.equal((await call(env, "POST", "/v1/auth/x/finish", { ...body, installId: "install-test-1", platform: "ios" })).status, 400);
    }
    assert.equal((await finish(env, good, { installId: "short" })).status, 400);
    assert.equal((await finish(env, good, { platform: "desktop" })).status, 400);
    // A browser is refused while browser mining is switched off (the default), also before the ticket is looked at.
    const web = await finish(env, good, { platform: "web" });
    assert.deepEqual([web.status, web.json.error], [403, "web_mining_unavailable"]);
    assert.equal((await finish(env, good)).status, 200, "none of those spent it");
    assert.equal((await finish(env, { ticket: "B".repeat(43), appVerifier: good.appVerifier })).json.error, "ticket_invalid");
  } finally {
    await env.close();
  }
});

test("finish: a ticket works once, and for five minutes", async () => {
  const env = await makeEnv();
  try {
    const t = await xTicket(env, xAccount("alice"));
    const first = await finish(env, t);
    assert.deepEqual([first.status, first.json.newUser], [200, true]);
    const replay = await finish(env, t);
    assert.deepEqual([replay.status, replay.json.error], [403, "ticket_invalid"]);
    assert.equal(await count(env, "refresh_tokens"), 1);

    // Presented twice at the same moment: one session.
    const race = await xTicket(env, xAccount("bob"));
    const both = await Promise.all([finish(env, race), finish(env, race)]);
    assert.deepEqual(both.map((b) => b.status).sort(), [200, 403]);
    assert.equal(await count(env, "users"), 2);
    assert.equal(await count(env, "refresh_tokens"), 2);

    const onTime = await xTicket(env, xAccount("carol"));
    const late = await xTicket(env, xAccount("dave"));
    env.clock.advance(300n);
    assert.equal((await finish(env, onTime)).status, 200);
    env.clock.advance(1n);
    assert.deepEqual([(await finish(env, late)).status, await count(env, "users")], [403, 3]);
  } finally {
    await env.close();
  }
});

test("finish: one X account is one user, on any device, and the username follows X", async () => {
  const env = await makeEnv();
  try {
    const account = xAccount("alice");
    const a = await finish(env, await xTicket(env, account));
    const b = await finish(env, await xTicket(env, account), { installId: "install-test-2", platform: "android" });
    const c = await finish(env, await xTicket(env, { id: account.id, username: "alice_renamed" }));
    assert.deepEqual([a.json.newUser, b.json.newUser, c.json.newUser], [true, false, false]);
    const ids = await Promise.all([a, b, c].map(async (s) => (await me(env, s.json.accessToken)).id));
    assert.equal(new Set(ids).size, 1);
    assert.deepEqual([await count(env, "users"), await count(env, "devices"), await count(env, "streaks")], [1, 2, 1]);
    assert.equal((await me(env, a.json.accessToken)).xUsername, "alice_renamed");

    // Someone else who takes the old username is a different person: the id decides.
    const d = await finish(env, await xTicket(env, { id: "424242", username: "alice" }));
    assert.equal(d.json.newUser, true);
    assert.notEqual((await me(env, d.json.accessToken)).id, ids[0]);
    assert.equal((await me(env, a.json.accessToken)).xUsername, "alice_renamed");

    // Two first sign-ins of one account at the same moment make one user.
    const [t1, t2] = [await xTicket(env, xAccount("twin")), await xTicket(env, xAccount("twin"))];
    const both = await Promise.all([finish(env, t1), finish(env, t2, { installId: "install-test-3" })]);
    assert.deepEqual(both.map((s) => s.status), [200, 200]);
    assert.equal(await count(env, "users"), 3);
    assert.deepEqual(both.map((s) => s.json.newUser).sort(), [false, true]);
  } finally {
    await env.close();
  }
});

test("finish: X is asked once per completed sign-in and never on refresh", async () => {
  const env = await makeEnv();
  try {
    const u = await signUp(env, "alice");
    assert.equal(env.x.exchanges.length, 1);
    let refresh = u.refresh;
    for (let i = 0; i < 3; i++) {
      const r = await call<{ refreshToken: string }>(env, "POST", "/v1/auth/refresh", { refreshToken: refresh });
      assert.equal(r.status, 200);
      refresh = r.json.refreshToken;
    }
    await me(env, u.token);
    assert.equal(env.x.exchanges.length, 1);
  } finally {
    await env.close();
  }
});

test("finish: an invite code counts on the first sign-in only", async () => {
  const env = await makeEnv();
  try {
    const inviter = await signUp(env, "alice");
    const second = await signUp(env, "bob");
    const code = (await me(env, inviter.token)).referralCode;
    const referredBy = async (name: string) =>
      (await env.deps.db.query<{ referred_by: string | null }>("SELECT referred_by FROM users WHERE x_username = $1", [name])).rows[0]!.referred_by;
    const inviterId = (await me(env, inviter.token)).id;

    const first = await finish(env, await xTicket(env, xAccount("carol")), { referralCode: code.toLowerCase() });
    assert.equal(first.json.newUser, true);
    assert.equal(await referredBy("carol"), inviterId);
    // Signing in again with someone else's code changes nothing.
    await finish(env, await xTicket(env, xAccount("carol")), { referralCode: (await me(env, second.token)).referralCode });
    assert.equal(await referredBy("carol"), inviterId);
    // An account that already exists cannot be attached to an inviter afterwards.
    await finish(env, await xTicket(env, xAccount("bob")), { referralCode: code });
    assert.equal(await referredBy("bob"), null);
    // An unknown code is ignored.
    assert.equal((await finish(env, await xTicket(env, xAccount("dave")), { referralCode: "NOSUCH00" })).status, 200);
    assert.equal(await referredBy("dave"), null);
    assert.equal((await finish(env, await xTicket(env, xAccount("erin")), { referralCode: "X".repeat(17) })).status, 400);
  } finally {
    await env.close();
  }
});

test("finish: a banned user can sign in and appeal, stays banned, and cannot start a wallet change", async () => {
  const env = await makeEnv();
  try {
    const u = await signUp(env, "ban");
    await env.deps.db.query("UPDATE users SET banned = TRUE, tier = 0");
    const again = await finish(env, await xTicket(env, xAccount("ban")));
    assert.deepEqual([again.status, again.json.newUser], [200, false]);
    const profile = await me(env, again.json.accessToken);
    assert.equal(profile.banned, true);
    const start = await call(env, "POST", "/v1/auth/x/start", { appChallenge: "A".repeat(43), purpose: "wallet-change" }, auth(u));
    assert.deepEqual([start.status, start.json.error], [403, "account_restricted"]);
    assert.equal((await call(env, "POST", "/v1/mining/challenge", {}, auth({ token: again.json.accessToken }))).json.error, "account_restricted");
    assert.equal((await call(env, "POST", "/v1/appeals", { message: "Please review my account." }, auth({ token: again.json.accessToken }))).status, 200);
  } finally {
    await env.close();
  }
});

test("finish: blocked regions are refused before the ticket is touched", async () => {
  const env = await makeEnv();
  try {
    const t = await xTicket(env, xAccount("alice"));
    const blocked = await call(env, "POST", "/v1/auth/x/finish", { ...t, installId: "install-test-1", platform: "ios" }, { "cf-ipcountry": "KP" });
    assert.deepEqual([blocked.status, blocked.json.error], [403, "region_blocked"]);
    assert.equal((await finish(env, t)).status, 200);
  } finally {
    await env.close();
  }
});

// ----------------------------------------------------------- wallet change

/** A user whose wallet is linked and past its cooldown, so only the fresh sign-in stands in the way. */
async function walletUser(env: TestEnv, name: string): Promise<TestUser> {
  const u = await signUp(env, name);
  assert.equal((await linkWallet(env, u)).status, 200);
  return u;
}

const link = async (env: TestEnv, u: TestUser, account: ReturnType<typeof privateKeyToAccount>, reauth?: { ticket: string; appVerifier: string }) =>
  call(env, "POST", "/v1/wallet/link", {
    ...(await siwe(env, u, account)), ...(reauth ? { reauthTicket: reauth.ticket, appVerifier: reauth.appVerifier } : {}),
  }, auth(u));

test("wallet change: needs a ticket from this user's own wallet-change sign-in, as the same X account", async () => {
  const env = await makeEnv();
  try {
    const u = await walletUser(env, "alice");
    const v = await walletUser(env, "bob");
    env.clock.advance(7n * 86_400n);
    const next = privateKeyToAccount(generatePrivateKey());
    const self = { id: u.xId, username: u.name };
    const refused = async (reauth: { ticket: string; appVerifier: string } | undefined, error: string, why: string) => {
      const r = await link(env, u, next, reauth);
      assert.deepEqual([r.status, r.json.error], [403, error], why);
      assert.equal((await me(env, u.token)).wallet, u.wallet.address, why);
    };

    await refused(undefined, "reauth_required", "no ticket");
    const half = await call(env, "POST", "/v1/wallet/link", { ...(await siwe(env, u, next)), reauthTicket: (await xTicket(env, self, "wallet-change", auth(u))).ticket }, auth(u));
    assert.equal(half.json.error, "reauth_required", "a ticket without its verifier");

    // A sign-in ticket for the right X account is not a wallet-change ticket.
    await refused(await xTicket(env, self), "reauth_invalid", "sign-in ticket");
    // The flow was approved at X as a different account (a stolen session, the thief's own X login).
    await refused(await xTicket(env, xAccount("mallory"), "wallet-change", auth(u)), "reauth_invalid", "different X account");
    await refused(await xTicket(env, { id: v.xId, username: u.name }, "wallet-change", auth(u)), "reauth_invalid", "same username, different X id");
    // A ticket from another user's wallet-change flow, even approved as this user's X account.
    await refused(await xTicket(env, self, "wallet-change", auth(v)), "reauth_invalid", "another user's ticket");
    await refused(await xTicket(env, { id: v.xId, username: v.name }, "wallet-change", auth(v)), "reauth_invalid", "another user's ticket and account");
    // The right ticket with the wrong verifier, which also uses it up.
    const wrong = await xTicket(env, self, "wallet-change", auth(u));
    await refused({ ticket: wrong.ticket, appVerifier: "A".repeat(43) }, "reauth_invalid", "wrong verifier");
    await refused(wrong, "reauth_invalid", "spent by the failed attempt");
    // Too late.
    const late = await xTicket(env, self, "wallet-change", auth(u));
    env.clock.advance(301n);
    await refused(late, "reauth_invalid", "expired ticket");
    assert.equal(await count(env, "wallet_changes"), 0);

    // The real thing works once.
    const good = await xTicket(env, self, "wallet-change", auth(u));
    assert.equal((await call(env, "POST", "/v1/push/register", { token: "ExponentPushToken[alice-phone]" }, auth(u))).status, 200);
    assert.equal((await call(env, "POST", "/v1/push/register", { token: "ExponentPushToken[bob-phone]" }, auth(v))).status, 200);
    assert.equal(env.pushes.length, 0, "refused changes notify nobody");
    const changed = await link(env, u, next, good);
    assert.deepEqual([changed.status, changed.json.changed], [200, true]);
    // The owner's devices are told, and nobody else's.
    assert.deepEqual(env.pushes.map((p) => [p.to, p.title]), [["ExponentPushToken[alice-phone]", "Rewards wallet changed"]]);
    assert.equal((await me(env, u.token)).wallet, next.address);
    assert.deepEqual((await env.deps.db.query("SELECT from_address, to_address FROM wallet_changes")).rows, [{ from_address: u.wallet.address, to_address: next.address }]);
    env.clock.advance(7n * 86_400n);
    const third = privateKeyToAccount(generatePrivateKey());
    const replay = await link(env, u, third, good);
    assert.deepEqual([replay.status, replay.json.error], [403, "reauth_invalid"], "replayed ticket");
    assert.equal((await me(env, u.token)).wallet, next.address);
  } finally {
    await env.close();
  }
});

test("wallet change: its ticket never signs anyone in, and the old limits still apply", async () => {
  const env = await makeEnv();
  try {
    const u = await walletUser(env, "alice");
    const v = await walletUser(env, "bob");
    const self = { id: u.xId, username: u.name };
    const next = privateKeyToAccount(generatePrivateKey());
    const start = () => call(env, "POST", "/v1/auth/x/start", { appChallenge: "A".repeat(43), purpose: "wallet-change" }, auth(u));

    // Inside the 7-day cooldown the fresh sign-in is not even started: nobody is sent to X for nothing.
    const logins = await count(env, "x_logins");
    env.clock.advance(7n * 86_400n - 1n);
    const early = await start();
    assert.deepEqual([early.status, early.json.error], [403, "wallet_change_cooldown"]);
    assert.equal(await count(env, "x_logins"), logins);
    env.clock.advance(1n);

    const t = await xTicket(env, self, "wallet-change", auth(u));
    const r = await finish(env, t);
    assert.deepEqual([r.status, r.json.error], [403, "ticket_invalid"]);
    assert.equal(await count(env, "refresh_tokens"), 2, "no new session");

    const first = await xTicket(env, self, "wallet-change", auth(u));
    const second = await xTicket(env, self, "wallet-change", auth(u));
    // A wallet LONGYU has seen before stays refused.
    assert.equal((await link(env, u, v.wallet, first)).status, 409);
    assert.equal((await link(env, u, next, first)).json.changed, true, "the refusal above did not spend the ticket");
    // The change restarts the cooldown: a second valid ticket changes nothing, and is not spent by the refusal.
    assert.equal((await link(env, u, privateKeyToAccount(generatePrivateKey()), second)).json.error, "wallet_change_cooldown");
    assert.equal((await start()).json.error, "wallet_change_cooldown");
    const unspent = await env.deps.db.query("SELECT 1 FROM x_logins WHERE ticket_hash = $1 AND ticket_used_at IS NULL", [sha256Hex(second.ticket)]);
    assert.equal(unspent.rows.length, 1);
    // Linking the wallet already held needs no ticket and changes nothing.
    assert.deepEqual((await link(env, u, next)).json, { address: next.address, changed: false });
    assert.equal(await count(env, "wallet_changes"), 1);
    assert.equal((await me(env, u.token)).wallet, next.address);
  } finally {
    await env.close();
  }
});

// ----------------------------------------------------------------- cleanup

test("cleanup drops sign-in attempts a day after they expire", async () => {
  const env = await makeEnv();
  try {
    await signUp(env, "alice");
    await startX(env);
    env.clock.advance(600n + 86_400n);
    await cleanup(env.deps);
    assert.equal(await count(env, "x_logins"), 2);
    env.clock.advance(1n);
    const fresh = await startX(env);
    await cleanup(env.deps);
    assert.equal(await count(env, "x_logins"), 1);
    assert.equal((await xCallback(env, fresh.state, xAccount("alice"))).status, 302);
  } finally {
    await env.close();
  }
});

// ---------------------------------------------------------------- settings

const BASE = { JWT_SECRET: "x".repeat(40), RPC_URL: "http://127.0.0.1:8545", CHAIN_ID: "668801", DISTRIBUTOR_ADDRESS: "0x0000000000000000000000000000000000000001" };
const PROD = {
  ...BASE, NODE_ENV: "production", DATABASE_URL: "postgres://u:p@db/x", TURNSTILE_SECRET: "t", STORAGE_BUCKET: "d", PUBLIC_DATA_BASE_URL: "https://api.longyu.network/data",
  SIGNER_URL: "http://signer.railway.internal:8080", SIGNER_TOKEN: "s".repeat(40),
  ORIGIN_SECRET: "o".repeat(40), PUBLIC_RPC_URL: "https://rpc-testnet.longyu.network",
};
const X = { X_CLIENT_ID: "client-id", X_CLIENT_SECRET: "client-secret", X_REDIRECT_URI: "https://api.longyu.network/v1/auth/x/callback" };

test("settings: production refuses to start without X, with a non-https callback, or with the development stand-in", () => {
  const ok = loadConfig({ ...PROD, ...X });
  assert.equal(ok.APP_AUTH_REDIRECT, "longyumine://auth");
  assert.ok(!(xProvider(ok) instanceof DevX));
  assert.notEqual(xProvider(ok), noX);

  assert.throws(() => loadConfig(PROD), /X_CLIENT_ID, X_CLIENT_SECRET and X_REDIRECT_URI are required in production/);
  assert.throws(() => loadConfig({ ...PROD, X_REDIRECT_URI: X.X_REDIRECT_URI }), /required in production/);
  assert.throws(() => loadConfig({ ...PROD, ...X, X_CLIENT_ID: "" }), /set together/);
  assert.throws(() => loadConfig({ ...PROD, ...X, X_CLIENT_SECRET: " " }), /set together/);
  assert.throws(() => loadConfig({ ...PROD, ...X, X_REDIRECT_URI: "" }), /X_REDIRECT_URI is required/);
  assert.throws(() => loadConfig({ ...PROD, ...X, X_REDIRECT_URI: "http://api.longyu.network/v1/auth/x/callback" }), /https in production/);
  for (const uri of [
    "https://api.longyu.network/", "https://api.longyu.network/v1/auth/x/callback/", "https://api.longyu.network/v1/auth/x/callback?x=1",
    "https://api.longyu.network/v1/auth/x/callback#x", "https://user:pw@api.longyu.network/v1/auth/x/callback", "longyumine://auth/v1/auth/x/callback",
  ]) {
    assert.throws(() => loadConfig({ ...PROD, ...X, X_REDIRECT_URI: uri }), /X_REDIRECT_URI must be this API's/, uri);
  }
  assert.throws(() => loadConfig({ ...PROD, ...X, X_REDIRECT_URI: "not a url" }));

  // The development stand-in: never in production, and never alongside the real settings.
  assert.throws(() => loadConfig({ ...PROD, ALLOW_DEV_X_LOGIN: "true" }), /development X sign-in is not allowed in production/);
  assert.throws(() => loadConfig({ ...PROD, ...X, ALLOW_DEV_X_LOGIN: "true" }), /ALLOW_DEV_X_LOGIN/);
  assert.throws(() => loadConfig({ ...BASE, ...X, ALLOW_DEV_X_LOGIN: "1" }), /ALLOW_DEV_X_LOGIN/);
  // Even a settings object that slipped past loadConfig cannot get the stand-in, or no provider, in production.
  assert.throws(() => xProvider({ ...ok, X_CLIENT_ID: undefined, ALLOW_DEV_X_LOGIN: true }), /not configured/);
  assert.throws(() => xProvider({ ...ok, X_CLIENT_SECRET: undefined }), /not configured/);
  assert.throws(() => xProvider({ ...ok, X_REDIRECT_URI: undefined }), /not configured/);
  assert.ok(!(xProvider({ ...ok, ALLOW_DEV_X_LOGIN: true }) instanceof DevX));
});

test("settings: production refuses to start without the origin secret or the public RPC address", () => {
  const { ORIGIN_SECRET, PUBLIC_RPC_URL, ...rest } = { ...PROD, ...X };
  assert.throws(() => loadConfig({ ...rest, PUBLIC_RPC_URL }), /ORIGIN_SECRET is required in production/);
  assert.throws(() => loadConfig({ ...rest, ORIGIN_SECRET }), /PUBLIC_RPC_URL is required in production/);
  assert.throws(() => loadConfig({ ...rest, ORIGIN_SECRET: "short", PUBLIC_RPC_URL }));
  // Local development runs without either.
  const dev = loadConfig(BASE);
  assert.deepEqual([dev.ORIGIN_SECRET, dev.PUBLIC_RPC_URL], [undefined, undefined]);
});

test("settings: the day's ceiling on X sign-ins defaults to 5000 and cannot be switched off", () => {
  assert.equal(loadConfig(BASE).X_DAILY_SIGNIN_LIMIT, 5000);
  assert.equal(loadConfig({ ...BASE, X_DAILY_SIGNIN_LIMIT: "200" }).X_DAILY_SIGNIN_LIMIT, 200);
  for (const bad of ["0", "-1", "1.5", "many", "1000001"]) {
    assert.throws(() => loadConfig({ ...BASE, X_DAILY_SIGNIN_LIMIT: bad }), bad);
  }
});

test("settings: outside production the stand-in is used only when asked for by name", () => {
  const plain = loadConfig(BASE);
  assert.equal(xProvider(plain), noX);
  assert.ok(xProvider(loadConfig({ ...BASE, ALLOW_DEV_X_LOGIN: "true" })) instanceof DevX);
  const real = xProvider(loadConfig({ ...BASE, ...X, X_REDIRECT_URI: "http://127.0.0.1:8080/v1/auth/x/callback" }));
  assert.ok(real !== noX && !(real instanceof DevX));
  // The stand-in sends the browser to the configured callback.
  const dev = xProvider(loadConfig({ ...BASE, ALLOW_DEV_X_LOGIN: "true", X_REDIRECT_URI: "http://10.0.2.2:8080/v1/auth/x/callback" }));
  assert.ok(dev.authorizeUrl({ state: "s", codeChallenge: "c" }).startsWith("http://10.0.2.2:8080/v1/auth/x/callback?state=s&code="));
});

test("settings: the app link the callback redirects to cannot be a web page or carry a query", () => {
  for (const link of ["longyumine://auth", "longyumine-dev://auth", "https://app.longyu.network/auth"]) {
    assert.equal(loadConfig({ ...BASE, APP_AUTH_REDIRECT: link }).APP_AUTH_REDIRECT, link);
  }
  for (const link of [
    "http://app.longyu.network/auth", "javascript:alert(1)", "data:text/html,x", "longyumine://auth?next=1", "longyumine://auth#x",
    "longyumine://auth?", "https://user:pw@app.longyu.network/auth", "auth", "//evil.example", "longyumine://a b",
  ]) {
    assert.throws(() => loadConfig({ ...BASE, APP_AUTH_REDIRECT: link }), /APP_AUTH_REDIRECT/, link);
  }
});

test("settings: the Telegram bot and chat are set together", () => {
  const token = `123456789:${"A".repeat(35)}`;
  assert.throws(() => loadConfig({ ...BASE, TELEGRAM_BOT_TOKEN: token }), /set together/);
  assert.throws(() => loadConfig({ ...BASE, TELEGRAM_CHAT_ID: "-1001234567890" }), /set together/);
  assert.throws(() => loadConfig({ ...BASE, TELEGRAM_BOT_TOKEN: "not-a-token", TELEGRAM_CHAT_ID: "1" }));
  assert.throws(() => loadConfig({ ...BASE, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "chat/../x" }));
  assert.equal(loadConfig({ ...BASE, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "-1001234567890" }).TELEGRAM_CHAT_ID, "-1001234567890");
});

// ------------------------------------------------------------ the X client

interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A local HTTP server standing in for api.x.com (or api.telegram.org): records requests and answers with `handler`. */
async function fakeServer(handler: (req: Seen, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const s = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
      seen.push(s);
      handler(s, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const TOKEN_OK = { token_type: "bearer", expires_in: 7200, access_token: "access-token-0123456789", scope: "tweet.read users.read" };
const USER_OK = { data: { id: "2244994945", name: "X Dev", username: "XDevelopers" } };
const answer = (token: [number, unknown], user: [number, unknown] = [200, USER_OK]) => (req: Seen, res: ServerResponse) =>
  req.path === "/2/oauth2/token" ? json(res, ...token) : json(res, ...user);

const CLIENT = { clientId: "client-id-1", clientSecret: "s3cret-value", redirectUri: "https://api.longyu.network/v1/auth/x/callback" };

test("X client: the authorize link is X's, with PKCE and only the two read scopes", () => {
  const url = xOAuth(CLIENT).authorizeUrl({ state: "state-1", codeChallenge: "challenge-1" });
  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, "https://x.com/i/oauth2/authorize");
  assert.deepEqual(Object.fromEntries(parsed.searchParams), {
    response_type: "code",
    client_id: "client-id-1",
    redirect_uri: "https://api.longyu.network/v1/auth/x/callback",
    scope: "tweet.read users.read",
    state: "state-1",
    code_challenge: "challenge-1",
    code_challenge_method: "S256",
  });
  assert.ok(url.includes("scope=tweet.read%20users.read"));
  assert.ok(url.includes("redirect_uri=https%3A%2F%2Fapi.longyu.network%2Fv1%2Fauth%2Fx%2Fcallback"));
  assert.ok(!url.includes("s3cret-value"), "the client secret never goes to the browser");
});

test("X client: one token exchange as a confidential client, then one user read", async () => {
  const x = await fakeServer(answer([200, TOKEN_OK]));
  try {
    const account = await xOAuth({ ...CLIENT, apiBaseUrl: x.base }).exchange({ code: "the code/+=&", codeVerifier: "verifier-1" });
    assert.deepEqual(account, { id: "2244994945", username: "XDevelopers", avatar: null });
    assert.equal(x.seen.length, 2);
    const [token, user] = x.seen as [Seen, Seen];

    assert.deepEqual([token.method, token.path], ["POST", "/2/oauth2/token"]);
    assert.equal(token.headers.authorization, `Basic ${Buffer.from("client-id-1:s3cret-value").toString("base64")}`);
    assert.equal(token.headers["content-type"], "application/x-www-form-urlencoded");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(token.body)), {
      code: "the code/+=&",
      grant_type: "authorization_code",
      redirect_uri: "https://api.longyu.network/v1/auth/x/callback",
      code_verifier: "verifier-1",
    });
    assert.ok(!token.body.includes("s3cret-value"), "the secret travels in the header only");

    assert.deepEqual([user.method, user.path, user.body], ["GET", "/2/users/me?user.fields=profile_image_url", ""]);
    assert.equal(user.headers.authorization, "Bearer access-token-0123456789");
  } finally {
    await x.close();
  }
});

test("X client: the profile picture is kept only from X's image host, and never fails a sign-in", async () => {
  const picture = "https://pbs.twimg.com/profile_images/1683325380441128960/yRsRRjGO_normal.jpg";
  assert.equal(xAvatar(picture), "https://pbs.twimg.com/profile_images/1683325380441128960/yRsRRjGO_400x400.jpg");
  assert.equal(xAvatar("https://pbs.twimg.com/profile_images/12/a-b_C.png"), "https://pbs.twimg.com/profile_images/12/a-b_C.png");
  const refused: unknown[] = [
    undefined, null, 5, "", "javascript:alert(1)",
    "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
    "http://pbs.twimg.com/profile_images/1/a_normal.jpg",
    "https://pbs.twimg.com.evil.example/profile_images/1/a_normal.jpg",
    "https://evil.example/https://pbs.twimg.com/profile_images/1/a_normal.jpg",
    "https://pbs.twimg.com/profile_images/1/a_normal.jpg?x=1",
    "https://pbs.twimg.com/profile_images/1/../../a_normal.jpg",
    "https://pbs.twimg.com/profile_images/1/a_normal.svg",
    "https://user@pbs.twimg.com/profile_images/1/a_normal.jpg",
    `https://pbs.twimg.com/profile_images/1/${"a".repeat(65)}.jpg`,
  ];
  for (const url of refused) assert.equal(xAvatar(url), null, String(url));

  for (const [reported, kept] of [[picture, xAvatar(picture)], ["https://evil.example/a.jpg", null], [7, null]] as const) {
    const x = await fakeServer(answer([200, TOKEN_OK], [200, { data: { ...USER_OK.data, profile_image_url: reported } }]));
    try {
      const account = await xOAuth({ ...CLIENT, apiBaseUrl: x.base }).exchange({ code: "c", codeVerifier: "v" });
      assert.deepEqual(account, { id: "2244994945", username: "XDevelopers", avatar: kept });
    } finally {
      await x.close();
    }
  }
});

test("the X profile picture becomes the account's picture and follows the latest sign-in", async () => {
  const env = await makeEnv();
  try {
    const account = xAccount("alice");
    const picture = (name: string) => `https://pbs.twimg.com/profile_images/42/${name}_normal.jpg`;
    const signIn = async () => {
      const { ticket, appVerifier } = await xTicket(env, account);
      const s = await call<{ accessToken: string }>(env, "POST", "/v1/auth/x/finish", { ticket, appVerifier, installId: "install-alice-1", platform: "android" });
      assert.equal(s.status, 200, JSON.stringify(s.json));
      return (await me(env, s.json.accessToken)) as unknown as { avatarUrl: string | null; miningDays: string; invites: string; createdAt: string };
    };
    env.x.avatars.set(account.id, picture("first"));
    const first = await signIn();
    assert.equal(first.avatarUrl, "https://pbs.twimg.com/profile_images/42/first_400x400.jpg");
    assert.deepEqual([first.miningDays, first.invites], ["0", "0"]);
    assert.ok(BigInt(first.createdAt) > 0n);

    env.x.avatars.set(account.id, picture("second"));
    assert.equal((await signIn()).avatarUrl, "https://pbs.twimg.com/profile_images/42/second_400x400.jpg");
    // Removed at X: removed here at the next sign-in.
    env.x.avatars.delete(account.id);
    assert.equal((await signIn()).avatarUrl, null);
    // The database refuses any other address, whatever the code above it does.
    await assert.rejects(env.deps.db.query("UPDATE users SET avatar_url = 'https://evil.example/a.jpg'"));
  } finally {
    await env.close();
  }
});

test("X client: anything but a well-formed answer is refused, without leaking what was sent", async () => {
  const cases: [string, (req: Seen, res: ServerResponse) => void, RegExp, number][] = [
    ["token 400", answer([400, { error: "invalid_request" }]), /^X token exchange failed: 400$/, 1],
    ["token 401", answer([401, { error: "unauthorized_client" }]), /^X token exchange failed: 401$/, 1],
    ["token 500", answer([500, "oops"]), /^X token exchange failed: 500$/, 1],
    ["token 201", answer([201, TOKEN_OK]), /^X token exchange failed: 201$/, 1],
    ["token not JSON", answer([200, "<html>"]), /^X token exchange failed: not JSON$/, 1],
    ["token an array", answer([200, [TOKEN_OK]]), /^X token exchange failed: not an object$/, 1],
    ["token null", answer([200, "null"]), /^X token exchange failed: not an object$/, 1],
    ["token without access_token", answer([200, { token_type: "bearer" }]), /^X token exchange failed: no access token$/, 1],
    ["token with a non-string access_token", answer([200, { ...TOKEN_OK, access_token: 5 }]), /no access token$/, 1],
    ["token with an empty access_token", answer([200, { ...TOKEN_OK, access_token: "" }]), /no access token$/, 1],
    ["token with a header-breaking access_token", answer([200, { ...TOKEN_OK, access_token: "a\r\nx-evil: 1" }]), /no access token$/, 1],
    ["token of another type", answer([200, { ...TOKEN_OK, token_type: "mac" }]), /not a bearer token$/, 1],
    ["token without a type", answer([200, { access_token: "abc" }]), /not a bearer token$/, 1],
    ["token too large", answer([200, { ...TOKEN_OK, padding: "x".repeat(70_000) }]), /response too large$/, 1],
    ["token redirect", (_req, res) => { res.writeHead(307, { location: "http://127.0.0.1:1/steal" }); res.end(); }, /^X token exchange failed: TypeError$/, 1],
    ["user 401", answer([200, TOKEN_OK], [401, { title: "Unauthorized" }]), /^X user read failed: 401$/, 2],
    ["user 429", answer([200, TOKEN_OK], [429, { title: "Too Many Requests" }]), /^X user read failed: 429$/, 2],
    ["user not JSON", answer([200, TOKEN_OK], [200, "nope"]), /^X user read failed: not JSON$/, 2],
    ["user without data", answer([200, TOKEN_OK], [200, { errors: [{ title: "Forbidden" }] }]), /^X user read failed: no user$/, 2],
    ["user data null", answer([200, TOKEN_OK], [200, { data: null }]), /no user$/, 2],
    ["user data a string", answer([200, TOKEN_OK], [200, { data: "2244994945" }]), /no user$/, 2],
    ["id a number", answer([200, TOKEN_OK], [200, { data: { id: 2244994945, username: "XDevelopers" } }]), /invalid id$/, 2],
    ["id missing", answer([200, TOKEN_OK], [200, { data: { username: "XDevelopers" } }]), /invalid id$/, 2],
    ["id not decimal", answer([200, TOKEN_OK], [200, { data: { id: "22449x", username: "XDevelopers" } }]), /invalid id$/, 2],
    ["id negative", answer([200, TOKEN_OK], [200, { data: { id: "-5", username: "XDevelopers" } }]), /invalid id$/, 2],
    ["id zero-padded", answer([200, TOKEN_OK], [200, { data: { id: "0123", username: "XDevelopers" } }]), /invalid id$/, 2],
    ["id empty", answer([200, TOKEN_OK], [200, { data: { id: "", username: "XDevelopers" } }]), /invalid id$/, 2],
    ["id with spaces", answer([200, TOKEN_OK], [200, { data: { id: " 123 ", username: "XDevelopers" } }]), /invalid id$/, 2],
    ["id too long", answer([200, TOKEN_OK], [200, { data: { id: "1".repeat(20), username: "XDevelopers" } }]), /invalid id$/, 2],
    ["username missing", answer([200, TOKEN_OK], [200, { data: { id: "5" } }]), /invalid username$/, 2],
    ["username with markup", answer([200, TOKEN_OK], [200, { data: { id: "5", username: "<b>x</b>" } }]), /invalid username$/, 2],
    ["username too long", answer([200, TOKEN_OK], [200, { data: { id: "5", username: "a".repeat(16) } }]), /invalid username$/, 2],
    ["username empty", answer([200, TOKEN_OK], [200, { data: { id: "5", username: "" } }]), /invalid username$/, 2],
  ];
  for (const [name, handler, expected, requests] of cases) {
    const x = await fakeServer(handler);
    try {
      const err = await xOAuth({ ...CLIENT, apiBaseUrl: x.base }).exchange({ code: "code-123456", codeVerifier: "verifier-123456" }).then(
        () => null,
        (e: Error) => e,
      );
      assert.ok(err, `${name}: must be refused`);
      assert.match(err.message, expected, name);
      for (const secret of ["s3cret-value", "code-123456", "verifier-123456", "access-token-0123456789", x.base]) {
        assert.ok(!err.message.includes(secret) && !String(err.stack).includes(secret), `${name}: error mentions ${secret}`);
      }
      assert.equal(x.seen.length, requests, `${name}: requests made`);
    } finally {
      await x.close();
    }
  }
});

test("X client: a failure is marked as not billed only when it came before the user read", async () => {
  const cases: [string, (req: Seen, res: ServerResponse) => void, boolean][] = [
    ["token 400", answer([400, { error: "invalid_request" }]), true],
    ["token not JSON", answer([200, "<html>"]), true],
    ["token without access_token", answer([200, { token_type: "bearer" }]), true],
    ["token of another type", answer([200, { ...TOKEN_OK, token_type: "mac" }]), true],
    ["user 429", answer([200, TOKEN_OK], [429, { title: "Too Many Requests" }]), false],
    ["user without data", answer([200, TOKEN_OK], [200, { errors: [{ title: "Forbidden" }] }]), false],
    ["id not decimal", answer([200, TOKEN_OK], [200, { data: { id: "22449x", username: "XDevelopers" } }]), false],
  ];
  for (const [name, handler, notBilled] of cases) {
    const x = await fakeServer(handler);
    try {
      const err = await xOAuth({ ...CLIENT, apiBaseUrl: x.base }).exchange({ code: "code-123456", codeVerifier: "verifier-123456" }).then(
        () => null,
        (e: Error) => e,
      );
      assert.ok(err, name);
      assert.equal(err instanceof XNotBilled, notBilled, name);
    } finally {
      await x.close();
    }
  }
  // Nothing listening, and no X settings at all: X was never reached.
  const down = await xOAuth({ ...CLIENT, apiBaseUrl: "http://127.0.0.1:1" }).exchange({ code: "c", codeVerifier: "v" }).catch((e: Error) => e);
  assert.ok(down instanceof XNotBilled);
  assert.ok((await noX.exchange({ code: "c", codeVerifier: "v" }).catch((e: Error) => e)) instanceof XNotBilled);
});

test("X client: gives up when X does not answer in time", async () => {
  // No answer at all.
  const silent = await fakeServer(() => undefined);
  try {
    const started = Date.now();
    await assert.rejects(
      xOAuth({ ...CLIENT, apiBaseUrl: silent.base, timeoutMs: 200 }).exchange({ code: "c", codeVerifier: "v" }),
      /^Error: X token exchange failed: (TimeoutError|AbortError)$/,
    );
    assert.ok(Date.now() - started < 5_000);
    assert.equal(silent.seen.length, 1);
  } finally {
    await silent.close();
  }
  // Headers, then a body that never ends.
  const stalled = await fakeServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"token_type":');
  });
  try {
    await assert.rejects(
      xOAuth({ ...CLIENT, apiBaseUrl: stalled.base, timeoutMs: 200 }).exchange({ code: "c", codeVerifier: "v" }),
      /^Error: X token exchange failed: (TimeoutError|AbortError)$/,
    );
  } finally {
    await stalled.close();
  }
  // The user read stalls after a good token answer.
  const half = await fakeServer((req, res) => (req.path === "/2/oauth2/token" ? json(res, 200, TOKEN_OK) : undefined));
  try {
    await assert.rejects(
      xOAuth({ ...CLIENT, apiBaseUrl: half.base, timeoutMs: 200 }).exchange({ code: "c", codeVerifier: "v" }),
      /^Error: X user read failed: (TimeoutError|AbortError)$/,
    );
    assert.equal(half.seen.length, 2);
  } finally {
    await half.close();
  }
  // Nothing listening.
  await assert.rejects(
    xOAuth({ ...CLIENT, apiBaseUrl: "http://127.0.0.1:1" }).exchange({ code: "c", codeVerifier: "v" }),
    /^Error: X token exchange failed: TypeError$/,
  );
});

test("X client through the API: the verifier matches the link's challenge, one user read per sign-in, none on refresh", async () => {
  const x = await fakeServer(answer([200, TOKEN_OK]));
  const env = await makeEnv();
  try {
    env.deps.x = xOAuth({ ...CLIENT, redirectUri: X_CALLBACK, apiBaseUrl: x.base });
    const flow = await startX(env);
    const authorize = new URL(flow.authorizeUrl);
    assert.equal(`${authorize.origin}${authorize.pathname}`, "https://x.com/i/oauth2/authorize");
    assert.equal(authorize.searchParams.get("redirect_uri"), X_CALLBACK);
    assert.ok(!flow.authorizeUrl.includes(flow.appVerifier) && !flow.authorizeUrl.includes(pkceChallenge(flow.appVerifier)), "the app's secret is not X's business");

    const back = await raw(env, `/v1/auth/x/callback?state=${flow.state}&code=code-from-x`);
    assert.equal(back.status, 302);
    const sent = Object.fromEntries(new URLSearchParams(x.seen[0]!.body));
    assert.equal(sent.code, "code-from-x");
    assert.equal(sent.redirect_uri, X_CALLBACK);
    assert.equal(pkceChallenge(sent.code_verifier!), authorize.searchParams.get("code_challenge"));

    const ticket = new URL(String(back.headers.location)).searchParams.get("ticket")!;
    const session = await finish(env, { ticket, appVerifier: flow.appVerifier });
    assert.deepEqual([session.status, session.json.newUser], [200, true]);
    assert.equal((await me(env, session.json.accessToken)).xUsername, "XDevelopers");
    assert.deepEqual((await env.deps.db.query("SELECT x_id, x_username FROM users")).rows, [{ x_id: "2244994945", x_username: "XDevelopers" }]);
    // X's access token is not kept anywhere.
    const dump = JSON.stringify((await env.deps.db.query("SELECT * FROM x_logins")).rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    assert.ok(!dump.includes(TOKEN_OK.access_token) && !dump.includes(ticket) && !dump.includes(flow.state));

    const r = await call<{ refreshToken: string }>(env, "POST", "/v1/auth/refresh", { refreshToken: session.json.refreshToken });
    assert.equal(r.status, 200);
    await call(env, "POST", "/v1/auth/refresh", { refreshToken: r.json.refreshToken });
    assert.deepEqual(x.seen.map((s) => s.path), ["/2/oauth2/token", "/2/users/me?user.fields=profile_image_url"]);

    // When X refuses the code, the app gets the fixed error and X is not asked for a user.
    const refused = await fakeServer(answer([400, { error: "invalid_request", error_description: "Value passed for the authorization code was invalid." }]));
    try {
      env.deps.x = xOAuth({ ...CLIENT, redirectUri: X_CALLBACK, apiBaseUrl: refused.base });
      const second = await startX(env);
      const failed = await raw(env, `/v1/auth/x/callback?state=${second.state}&code=bad`);
      assert.deepEqual([failed.status, failed.headers.location], [302, `${APP}?error=failed`]);
      assert.deepEqual(refused.seen.map((s) => s.path), ["/2/oauth2/token"]);
    } finally {
      await refused.close();
    }
  } finally {
    await env.close();
    await x.close();
  }
});

// ------------------------------------------------------------- ops notices

test("Telegram notices: one message to the configured chat, and errors never carry the bot token", async () => {
  const token = `123456789:${"A".repeat(35)}`;
  const tg = await fakeServer((_req, res) => json(res, 200, { ok: true }));
  try {
    await telegramNotifier(token, "-1001234567890", fetch, tg.base).notify("Order paid: acme", "Outcome: activated");
    assert.equal(tg.seen.length, 1);
    assert.deepEqual([tg.seen[0]!.method, tg.seen[0]!.path], ["POST", `/bot${token}/sendMessage`]);
    assert.deepEqual(JSON.parse(tg.seen[0]!.body), { chat_id: "-1001234567890", text: "Order paid: acme\n\nOutcome: activated", disable_web_page_preview: true });
    await telegramNotifier(token, "1", fetch, tg.base).notify("s", "x".repeat(10_000));
    assert.equal(JSON.parse(tg.seen[1]!.body).text.length, 4096);
  } finally {
    await tg.close();
  }
  const down = await fakeServer((_req, res) => json(res, 403, { ok: false, description: "bot was kicked" }));
  try {
    await assert.rejects(telegramNotifier(token, "1", fetch, down.base).notify("s", "t"), /^Error: telegram notice failed: 403$/);
  } finally {
    await down.close();
  }
  const err = await telegramNotifier(token, "1", fetch, "http://127.0.0.1:1").notify("s", "t").then(() => null, (e: Error) => e);
  assert.ok(err && !err.message.includes(token) && !String(err.stack).includes(token));
});
