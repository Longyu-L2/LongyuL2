import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { safeEqualHex, sha256PlainHex } from "../src/lib/util.ts";
import { ADMIN_KEYS, call, makeEnv, readyUser } from "./helpers.ts";

const alice = { "x-admin-key": ADMIN_KEYS.alice };
const bob = { "x-admin-key": ADMIN_KEYS.bob };

test("admin console is served same-origin under a strict CSP", async () => {
  const env = await makeEnv();
  try {
    for (const url of ["/admin", "/admin/"]) {
      const page = await env.app.inject({ method: "GET", url });
      assert.equal(page.statusCode, 200);
      assert.match(String(page.headers["content-type"]), /^text\/html/);
      assert.match(page.body, /<script type="module" src="\/admin\/app.js"><\/script>/);
      const csp = String(page.headers["content-security-policy"]);
      for (const d of ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) {
        assert.ok(csp.includes(d), d);
      }
      assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
      assert.equal(page.headers["x-frame-options"], "DENY");
      assert.equal(page.headers["cache-control"], "no-store");
    }
    const js = await env.app.inject({ method: "GET", url: "/admin/app.js" });
    assert.match(String(js.headers["content-type"]), /^text\/javascript/);
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js.body), "console never builds HTML from strings");
    const css = await env.app.inject({ method: "GET", url: "/admin/app.css" });
    assert.match(String(css.headers["content-type"]), /^text\/css/);
    for (const url of ["/admin/index.html", "/admin/../src/config.ts", "/admin/%2e%2e/src/config.ts", "/admin/app.ts"]) {
      assert.equal((await env.app.inject({ method: "GET", url })).statusCode, 404, url);
    }
  } finally {
    await env.close();
  }
});

test("ban requests: listed for review, approved by a second admin or turned down", async () => {
  const env = await makeEnv();
  try {
    const u1 = await readyUser(env, "one");
    const u2 = await readyUser(env, "two");
    const id = async (name: string) => (await env.deps.db.query<{ id: string }>("SELECT id FROM users WHERE x_username = $1", [name])).rows[0]!.id;
    const [id1, id2] = [await id(u1.name), await id(u2.name)];
    const r1 = await call<{ id: string }>(env, "POST", "/v1/admin/bans", { userId: id1, reason: "device farm" }, alice);
    const r2 = await call<{ id: string }>(env, "POST", "/v1/admin/bans", { userId: id2, reason: "shared wallet ring" }, alice);

    assert.equal((await call(env, "GET", "/v1/admin/bans")).status, 401);
    const pending = await call<{ bans: { id: string; handle: string; requested_by: string }[] }>(env, "GET", "/v1/admin/bans", undefined, bob);
    assert.deepEqual(pending.json.bans.map((b) => b.id).sort(), [r1.json.id, r2.json.id].sort());
    assert.ok(pending.json.bans.every((b) => b.requested_by === "alice" && b.handle));

    // The requester cannot approve, but can withdraw; anyone can turn a request down.
    assert.equal((await call(env, "POST", `/v1/admin/bans/${r1.json.id}/approve`, {}, alice)).json.error, "second_admin_required");
    assert.equal((await call(env, "POST", `/v1/admin/bans/${r1.json.id}/reject`, {}, alice)).status, 200);
    assert.equal((await call(env, "POST", `/v1/admin/bans/${r1.json.id}/approve`, {}, bob)).json.error, "action_not_pending");
    assert.equal((await call(env, "POST", `/v1/admin/bans/${r1.json.id}/reject`, {}, bob)).status, 404);
    assert.equal((await call(env, "POST", `/v1/admin/bans/${r2.json.id}/approve`, {}, bob)).status, 200);

    const rejected = await call<{ bans: { id: string; approved_by: string }[] }>(env, "GET", "/v1/admin/bans?status=rejected", undefined, bob);
    assert.deepEqual(rejected.json.bans.map((b) => [b.id, b.approved_by]), [[r1.json.id, "alice"]]);
    const executed = await call<{ bans: { id: string }[] }>(env, "GET", "/v1/admin/bans?status=executed", undefined, bob);
    assert.deepEqual(executed.json.bans.map((b) => b.id), [r2.json.id]);
    const banned = (await env.deps.db.query<{ x_username: string; banned: boolean }>("SELECT x_username, banned FROM users ORDER BY x_username")).rows;
    assert.deepEqual(banned.map((b) => [b.x_username, b.banned]), [["one", false], ["two", true]]);
  } finally {
    await env.close();
  }
});

test("user record for review: profile, flags, wallet changes and appeals", async () => {
  const env = await makeEnv();
  try {
    const u = await readyUser(env, "rev");
    const userId = (await env.deps.db.query<{ id: string }>("SELECT id FROM users WHERE x_username = 'rev'")).rows[0]!.id;
    await env.deps.db.query(
      "INSERT INTO flags (id, user_id, kind, severity, detail, day, created_at) VALUES (gen_random_uuid(), $1, 'shared_device', 'hold', '{\"accounts\":3}', 0, 0)",
      [userId],
    );
    assert.equal((await call(env, "GET", `/v1/admin/users/${userId}`)).status, 401);
    const r = await call<{ user: { handle: string; wallet: string; tier: number; mining_days: string }; flags: { kind: string }[]; appeals: unknown[]; walletChanges: unknown[] }>(
      env, "GET", `/v1/admin/users/${userId}`, undefined, alice,
    );
    assert.equal(r.status, 200);
    assert.equal(r.json.user.wallet, u.wallet.address);
    assert.equal(r.json.user.mining_days, "0");
    assert.deepEqual(r.json.flags.map((f) => f.kind), ["shared_device"]);
    assert.ok(!("x_id" in r.json.user) && !("x_username" in r.json.user), "the console does not need the X account");
    assert.equal((await call(env, "GET", "/v1/admin/users/00000000-0000-4000-8000-000000000000", undefined, alice)).status, 404);
    assert.equal((await call(env, "GET", "/v1/admin/users/not-a-uuid", undefined, alice)).status, 400);
    const cfg = await call<{ enabled: boolean }>(env, "GET", "/v1/admin/payments/config", undefined, alice);
    assert.deepEqual(cfg.json, { enabled: false });
  } finally {
    await env.close();
  }
});

test("ban requests: the user must exist", async () => {
  const env = await makeEnv();
  try {
    await readyUser(env, "one");
    const r = await call(env, "POST", "/v1/admin/bans", { userId: "3f0e7c1a-5b2d-4e8f-9a6b-1c2d3e4f5a6b", reason: "device farm" }, alice);
    assert.deepEqual([r.status, r.json.error], [404, "user_not_found"]);
    assert.equal((await call(env, "POST", "/v1/admin/bans", { userId: "not-an-id", reason: "device farm" }, alice)).status, 400);
    assert.equal(Number((await env.deps.db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM admin_actions")).rows[0]!.n), 0);
    const pending = await call<{ bans: unknown[] }>(env, "GET", "/v1/admin/bans", undefined, bob);
    assert.deepEqual(pending.json.bans, []);
  } finally {
    await env.close();
  }
});

test("admin keys: each entry is checked when the settings load, and a bad one is never echoed", () => {
  const base = { JWT_SECRET: "x".repeat(40), RPC_URL: "http://127.0.0.1:8545", CHAIN_ID: "668801", DISTRIBUTOR_ADDRESS: "0x0000000000000000000000000000000000000001" };
  const hash = sha256PlainHex(ADMIN_KEYS.alice);
  const other = sha256PlainHex(ADMIN_KEYS.bob);
  for (const good of ["", `alice:${hash}`, `alice:${hash},bob:${other}`, `alice:${hash},`, `ops team:${hash}`]) {
    assert.equal(loadConfig({ ...base, ADMIN_KEYS: good }).ADMIN_KEYS, good);
  }
  const bad: [string, string, number][] = [
    ["no hash", "alice", 1],
    ["no name", `:${hash}`, 1],
    ["the key itself, not its hash", `alice:${ADMIN_KEYS.alice}`, 1],
    ["a short hash", `alice:${hash.slice(1)}`, 1],
    ["a long hash", `alice:${hash}0`, 1],
    ["an upper-case hash", `alice:${hash.toUpperCase()}`, 1],
    ["a hash that is not hex", `alice:${"g".repeat(64)}`, 1],
    ["a space after the hash", `alice:${hash} ,bob:${other}`, 1],
    ["a second colon", `alice:${hash}:extra`, 1],
    ["the second entry", `alice:${hash},bob:${other.slice(2)}`, 2],
    ["semicolons between entries", `alice:${hash};bob:${other}`, 1],
  ];
  for (const [why, value, entry] of bad) {
    const err = (() => {
      try {
        loadConfig({ ...base, ADMIN_KEYS: value });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    assert.ok(err, why);
    assert.match(err.message, new RegExp(`^ADMIN_KEYS: entry ${entry} must be name:sha256`), why);
    for (const part of value.split(/[,;:]/).filter((p) => p.length > 5)) assert.ok(!err.message.includes(part), `${why}: the message repeats the entry`);
  }
});

test("admin keys: a malformed stored hash matches nothing and breaks nothing", () => {
  const hash = sha256PlainHex(ADMIN_KEYS.alice);
  assert.equal(safeEqualHex(hash, hash), true);
  assert.equal(safeEqualHex(hash, sha256PlainHex(ADMIN_KEYS.bob)), false);
  // Same length, not hex: these used to decode to buffers of different sizes and throw.
  for (const stored of ["z".repeat(64), `${hash.slice(0, 63)}g`, `${hash.slice(0, 32)}${" ".repeat(32)}`, `0x${hash.slice(2)}`]) {
    assert.equal(safeEqualHex(hash, stored), false, stored);
    assert.equal(safeEqualHex(stored, stored), false, stored);
  }
  assert.equal(safeEqualHex(hash, hash.slice(1)), false);
});
