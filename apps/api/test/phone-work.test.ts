import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { puzzleSolved } from "../src/modules/phone-work.ts";
import { outputRootOf, type ChainChecker, type OutputRef, type RootParts } from "../src/services/chain-check.ts";
import { clearHealthCache } from "../src/modules/health.ts";
import { ADMIN_KEYS, auth, call, makeEnv, readyUser, type TestEnv, type TestUser } from "./helpers.ts";

const word = (): Hex => `0x${randomBytes(32).toString("hex")}`;
const partsOf = (): RootParts => ({ stateRoot: word(), messagePasserRoot: word(), blockHash: word() });

/** State roots "posted on BSC", and what "LONGYU's own node" rebuilds for each block. */
class FakeChecker implements ChainChecker {
  readonly outputs = new Map<bigint, OutputRef>();
  readonly own = new Map<bigint, RootParts>();
  next = 7n;
  post(index: bigint, parts = partsOf(), root?: Hex): RootParts {
    const l2Block = index * 3600n;
    this.own.set(l2Block, parts);
    this.outputs.set(index, { index, l2Block, root: root ?? outputRootOf(parts) });
    return parts;
  }
  async pick() {
    return this.outputs.get(this.next)!;
  }
  async latest() {
    return [...this.outputs.keys()].reduce((a, b) => (b > a ? b : a), 0n);
  }
  async output(index: bigint) {
    return this.outputs.get(index) ?? null;
  }
  async partsAt(l2Block: bigint) {
    return this.own.get(l2Block)!;
  }
}

function solve(nonce: string, bits: number): string {
  for (let i = 0; ; i++) if (puzzleSolved(nonce, String(i), bits)) return String(i);
}

function unsolved(nonce: string, bits: number): string {
  for (let i = 0; ; i++) if (!puzzleSolved(nonce, String(i), bits)) return String(i);
}

type Challenge = { challengeId: string; nonce: string; work: { bits: number; output: { index: string; l2Block: string } | null } };

async function start(env: TestEnv, u: TestUser, work: (c: Challenge) => Record<string, unknown> | undefined) {
  const c = await call<Challenge>(env, "POST", "/v1/mining/challenge", {}, auth(u));
  assert.equal(c.status, 200);
  return { challenge: c.json, ...(await call(env, "POST", "/v1/mining/start", { challengeId: c.json.challengeId, attestationToken: `dev:${c.json.nonce}`, captchaToken: "dev-pass", work: work(c.json) }, auth(u))) };
}

test("puzzle: a counter solves it when the hash starts with that many zero bits", () => {
  const nonce = "a1b2c3";
  const counter = solve(nonce, 12);
  const digest = createHash("sha256").update(`${nonce}:${counter}`).digest();
  assert.equal(digest[0], 0);
  assert.equal(digest[1]! >> 4, 0);
  assert.ok(puzzleSolved(nonce, counter, 12));
  assert.ok(puzzleSolved(nonce, "anything", 0));
  // Most counters fail 12 bits: of the first 64, at most a few pass.
  let passed = 0;
  for (let i = 0; i < 64; i++) if (puzzleSolved("other", String(i), 12)) passed++;
  assert.ok(passed <= 2);
});

test("phone work: required devices must solve the puzzle and rebuild the state root to start", async () => {
  const checker = new FakeChecker();
  const parts7 = checker.post(7n);
  const parts8 = checker.post(8n);
  const env = await makeEnv({ env: { PHONE_WORK_PLATFORMS: "android" } });
  env.deps.chainCheck = checker;
  try {
    const u = await readyUser(env, "ana");
    let r = await start(env, u, () => undefined);
    assert.deepEqual([r.status, r.json.error], [403, "work_required"]);
    assert.equal(r.challenge.work.bits, 8);
    assert.deepEqual(r.challenge.work.output, { index: "7", l2Block: "25200" });

    r = await start(env, u, (c) => ({ counter: unsolved(c.nonce, 8), parts: parts7 }));
    assert.deepEqual([r.status, r.json.error], [403, "work_invalid"]);
    r = await start(env, u, (c) => ({ counter: solve(c.nonce, 8) }));
    assert.deepEqual([r.status, r.json.error], [403, "work_required"], "the chain check is part of the work");
    r = await start(env, u, (c) => ({ counter: solve(c.nonce, 8), parts: { ...parts7, blockHash: word() } }));
    assert.deepEqual([r.status, r.json.error], [403, "chain_check_failed"]);

    r = await start(env, u, (c) => ({ counter: solve(c.nonce, 8), parts: parts7 }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const status = await call<{ session: { chainChecks: number; lastCheckedOutput: string } }>(env, "GET", "/v1/mining/status", undefined, auth(u));
    assert.deepEqual([status.json.session.chainChecks, status.json.session.lastCheckedOutput], [1, "7"]);

    // While the session runs, each newer state root counts once.
    const check = (index: string, parts: RootParts) => call<{ match: boolean; counted: boolean; checks: number; error?: string }>(env, "POST", "/v1/mining/check", { index, parts }, auth(u));
    assert.deepEqual((await check("8", parts8)).json, { match: true, counted: true, checks: 2 });
    assert.deepEqual((await check("8", parts8)).json, { match: true, counted: false, checks: 2 });
    assert.deepEqual((await check("7", parts7)).json, { match: true, counted: false, checks: 2 });
    checker.post(9n);
    const wrong = await check("9", partsOf());
    assert.deepEqual([wrong.status, wrong.json.error], [403, "chain_check_failed"]);
    assert.equal((await check("10", parts8)).status, 400, "a root not posted yet");
    checker.post(20n);
    const old = await check("11", parts8);
    assert.deepEqual([old.status, old.json.error], [400, "output_too_old"]);
  } finally {
    await env.close();
  }
});

test("phone work: a posted root that LONGYU's own node does not rebuild is reported, and the miner is not turned away", async () => {
  const checker = new FakeChecker();
  // The proposer posted a root that does not match the chain.
  const real = checker.post(7n, partsOf(), word());
  const env = await makeEnv({ env: { PHONE_WORK_PLATFORMS: "android" } });
  env.deps.chainCheck = checker;
  try {
    const u = await readyUser(env, "ben");
    const r = await start(env, u, (c) => ({ counter: solve(c.nonce, 8), parts: real }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(env.notices.length, 1);
    assert.equal(env.notices[0]!.subject, "State root mismatch");
    assert.match(env.notices[0]!.text, /^The state root posted on BSC at index 7 \(LONGYU block 25200\)/);
    // Reported again by the next phone: one alert, one notice.
    checker.post(8n, partsOf(), word());
    const again = await call(env, "POST", "/v1/mining/check", { index: "8", parts: checker.own.get(28800n) }, auth(u));
    assert.deepEqual(again.json, { match: false, counted: false, checks: 0 });
    clearHealthCache(env.deps);
    const h = await call<{ checks: { name: string; status: string; detail: string }[] }>(env, "GET", "/v1/admin/health", undefined, { "x-admin-key": ADMIN_KEYS.alice });
    const c = h.json.checks.find((x) => x.name === "chain checks")!;
    assert.deepEqual([h.status, c.status], [503, "critical"]);
    assert.match(c.detail, /^the state root posted at index 8 \(block 28800\) does not match LONGYU's own node/);
  } finally {
    await env.close();
  }
});

test("phone work: devices it is not required of may start without it, and BSC out of reach does not stop a session", async () => {
  const checker = new FakeChecker();
  checker.post(7n);
  const env = await makeEnv({ env: { PHONE_WORK_PLATFORMS: "web" } });
  env.deps.chainCheck = checker;
  try {
    const u = await readyUser(env, "cai");
    assert.equal((await start(env, u, () => undefined)).status, 200);
    const v = await readyUser(env, "dee");
    checker.output = async () => {
      throw new Error("BSC RPC down");
    };
    assert.equal((await start(env, v, (c) => ({ counter: solve(c.nonce, 8), parts: partsOf() }))).status, 200);
    const s = await call<{ session: { chainChecks: number } }>(env, "GET", "/v1/mining/status", undefined, auth(v));
    assert.equal(s.json.session.chainChecks, 0);
  } finally {
    await env.close();
  }
});
