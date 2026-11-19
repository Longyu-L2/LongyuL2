import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, api, saveTokens, setSignedOutHandler } from "./core.web.ts";
import { REQUEST_TIMEOUT_MS } from "./request.ts";

// Outside a browser this file keeps the session in memory, which is all these tests need.
const SESSION = { accessToken: "access-1", refreshToken: "refresh-1" };
const realFetch = globalThis.fetch;
let signedOut = 0;

type Call = { path: string; authorization: string | undefined; signal: AbortSignal | null | undefined };

/** Answers each request with what `answer` gives for it; "stall" never answers until the request is abandoned. */
function remote(answer: (call: Call) => Response | "stall"): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (url, init) => {
    const call = {
      path: new URL(String(url)).pathname,
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
      signal: init?.signal,
    };
    calls.push(call);
    const res = answer(call);
    if (res !== "stall") return Promise.resolve(res);
    return new Promise<never>((_, reject) => call.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  };
  return calls;
}

const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Lets the request get as far as waiting, then lets its time run out. */
async function runOut(): Promise<void> {
  for (let i = 0; i < 5; i++) await settle();
  mock.timers.tick(REQUEST_TIMEOUT_MS);
}

beforeEach(async () => {
  signedOut = 0;
  setSignedOutHandler(() => signedOut++);
  await saveTokens(SESSION);
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
});

test("a request the API does not answer fails as a timeout", async () => {
  const calls = remote(() => "stall");
  const asked = api("GET", "/v1/me");
  await runOut();
  await assert.rejects(asked, (e) => e instanceof ApiError && e.status === 0 && e.code === "timeout");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.signal?.aborted, true);
  assert.equal(signedOut, 0);
});

test("a session renewal that runs out of time leaves the session open", async () => {
  const calls = remote((call) => (call.path === "/v1/auth/refresh" ? "stall" : json(401, { error: "unauthorized" })));
  const asked = api("GET", "/v1/me");
  await runOut();
  await assert.rejects(asked, (e) => e instanceof ApiError && e.status === 0 && e.code === "timeout");
  assert.deepEqual(calls.map((c) => c.path), ["/v1/me", "/v1/auth/refresh"]);
  assert.equal(signedOut, 0);

  // The next request still goes out with the session, and renews it once the API answers.
  const later = remote((call) => {
    if (call.path === "/v1/auth/refresh") return json(200, { accessToken: "access-2", refreshToken: "refresh-2" });
    return call.authorization === "Bearer access-2" ? json(200, { handle: "pearl" }) : json(401);
  });
  assert.deepEqual(await api("GET", "/v1/me"), { handle: "pearl" });
  assert.deepEqual(later.map((c) => [c.path, c.authorization]), [["/v1/me", "Bearer access-1"], ["/v1/auth/refresh", undefined], ["/v1/me", "Bearer access-2"]]);
  assert.equal(signedOut, 0);
});

test("a renewal that fails without a refusal leaves the session open too", async () => {
  for (const answer of [json(503, { error: "unavailable" }), new Response("<html>Bad gateway</html>", { status: 200 })]) {
    remote((call) => (call.path === "/v1/auth/refresh" ? answer : json(401)));
    await assert.rejects(api("GET", "/v1/me"), (e) => e instanceof ApiError && e.code === "refresh_failed");
    assert.equal(signedOut, 0);
    const next = remote(() => json(200));
    await api("GET", "/v1/me");
    assert.equal(next[0]!.authorization, "Bearer access-1");
  }
});

test("only a refused renewal ends the session", async () => {
  for (const status of [400, 401]) {
    signedOut = 0;
    await saveTokens(SESSION);
    remote((call) => (call.path === "/v1/auth/refresh" ? json(status, { error: "invalid_refresh_token" }) : json(401, { error: "unauthorized" })));
    await assert.rejects(api("GET", "/v1/me"), (e) => e instanceof ApiError && e.status === 401);
    assert.equal(signedOut, 1);
    const next = remote(() => json(200));
    await api("GET", "/v1/me");
    assert.equal(next[0]!.authorization, undefined);
  }
});
