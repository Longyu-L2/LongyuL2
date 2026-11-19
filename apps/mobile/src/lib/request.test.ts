import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { REQUEST_TIMEOUT_MS, request } from "./request.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

class TimedOut extends Error {}
const timedOut = () => new TimedOut("timeout");

/** A request that ends only when it is abandoned, as a stalled connection does. */
const untilAborted = (signal: AbortSignal | null | undefined) =>
  new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

test("a request has twenty seconds", () => {
  assert.equal(REQUEST_TIMEOUT_MS, 20_000);
});

test("an answer in time is passed on with its status and body", async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ error: "nothing_to_claim" }), { status: 409 });
  };
  const res = await request("https://api.test/v1/rewards/claim", { method: "POST", headers: { authorization: "Bearer a" }, body: "{}" }, timedOut, 50);
  assert.deepEqual(res, { status: 409, ok: false, json: { error: "nothing_to_claim" } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "https://api.test/v1/rewards/claim");
  assert.equal(sent[0]!.init.method, "POST");
  assert.deepEqual(sent[0]!.init.headers, { authorization: "Bearer a" });
  assert.equal(sent[0]!.init.body, "{}");
  assert.equal(sent[0]!.init.signal?.aborted, false);
});

test("a body that is not JSON reads as none", async () => {
  globalThis.fetch = async () => new Response("<html>Bad gateway</html>", { status: 502 });
  assert.deepEqual(await request("https://api.test/v1/me", {}, timedOut, 50), { status: 502, ok: false, json: undefined });
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.deepEqual(await request("https://api.test/v1/me", {}, timedOut, 50), { status: 204, ok: true, json: undefined });
});

test("a request that stalls is abandoned and fails as a timeout", async () => {
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = (_url, init) => {
    signal = init?.signal;
    return untilAborted(signal);
  };
  const started = Date.now();
  await assert.rejects(request("https://api.test/v1/me", {}, timedOut, 20), TimedOut);
  assert.equal(signal?.aborted, true);
  assert.ok(Date.now() - started < 2000);
});

test("the limit covers a body that stalls after the headers arrived", async () => {
  globalThis.fetch = async (_url, init) => ({ status: 200, ok: true, json: () => untilAborted(init?.signal) }) as unknown as Response;
  await assert.rejects(request("https://api.test/v1/me", {}, timedOut, 20), TimedOut);
});

test("a request that cannot be abandoned still fails as a timeout", async () => {
  globalThis.fetch = () => new Promise<Response>(() => undefined);
  await assert.rejects(request("https://api.test/v1/me", {}, timedOut, 20), TimedOut);
});

test("a connection that fails at once is reported as it is, not as a timeout", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Network request failed");
  };
  await assert.rejects(request("https://api.test/v1/me", {}, timedOut, 50), TypeError);
});
