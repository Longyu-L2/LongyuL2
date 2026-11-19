import { test } from "node:test";
import assert from "node:assert/strict";
import { ipBucket } from "../src/context.ts";
import { turnstile } from "../src/services/external.ts";
import { makeEnv } from "./helpers.ts";

const SECRET = "origin-secret-0123456789-0123456789-abcdef";
const via = (extra: Record<string, string> = {}) => ({ "x-longyu-origin": SECRET, "cf-ipcountry": "SG", ...extra });

test("with ORIGIN_SECRET, only requests that came through Cloudflare are served", async () => {
  const env = await makeEnv({ env: { ORIGIN_SECRET: SECRET } });
  try {
    const get = (url: string, headers: Record<string, string> = {}) => env.app.inject({ method: "GET", url, headers });
    assert.equal((await get("/health")).statusCode, 200, "platform health check needs no secret");
    const forged: Record<string, string>[] = [{}, { "x-longyu-origin": "wrong" }, { "x-longyu-origin": `${SECRET}x` }, { "x-longyu-origin": SECRET.slice(1) }];
    for (const headers of forged) {
      const r = await get("/v1/network", headers);
      assert.equal(r.statusCode, 403);
      assert.equal(JSON.parse(r.body).error, "origin_required");
    }
    assert.equal((await get("/health?x=1")).statusCode, 403);
    assert.equal((await get("/v1/network", via())).statusCode, 200);
    assert.equal((await get("/admin", via())).statusCode, 200);
    assert.equal((await get("/admin")).statusCode, 403, "the console too");
  } finally {
    await env.close();
  }
});

test("with ORIGIN_SECRET, the client address is Cloudflare's, not a forwarded header", async () => {
  const env = await makeEnv({ env: { ORIGIN_SECRET: SECRET } });
  try {
    const address = "0x000000000000000000000000000000000000beef";
    const r = await env.app.inject({
      method: "POST", url: "/v1/faucet",
      headers: via({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1", "content-type": "application/json" }),
      payload: { address, captchaToken: "dev-pass" },
    });
    assert.equal(r.statusCode, 200, r.body);
    const ip = (await env.deps.db.query<{ ip: string }>("SELECT ip FROM faucet_requests")).rows[0]!.ip;
    assert.equal(ip, "203.0.113.7");
  } finally {
    await env.close();
  }
  const plain = await makeEnv();
  try {
    // Without the secret (a tunnel or firewall deployment), Cloudflare's header is not trusted blindly.
    await plain.app.inject({
      method: "POST", url: "/v1/faucet",
      headers: { "cf-connecting-ip": "203.0.113.7", "content-type": "application/json" },
      payload: { address: "0x000000000000000000000000000000000000beef", captchaToken: "dev-pass" },
    });
    const ip = (await plain.deps.db.query<{ ip: string }>("SELECT ip FROM faucet_requests")).rows[0]!.ip;
    assert.equal(ip, "127.0.0.1");
  } finally {
    await plain.close();
  }
});

test("other sites: the claim page may call the API, anyone may read a published data file, nothing else", async () => {
  const CLAIM = "https://testnet.longyu.network";
  const env = await makeEnv({ env: { WEB_ORIGINS: `${CLAIM}, https://pay.longyu.network` } });
  try {
    const allow = async (method: "GET" | "OPTIONS", url: string, origin: string, ask?: string) => {
      const r = await env.app.inject({
        method, url,
        headers: { origin, ...(ask ? { "access-control-request-method": ask, "access-control-request-headers": "content-type,authorization" } : {}) },
      });
      return { status: r.statusCode, origin: r.headers["access-control-allow-origin"], methods: r.headers["access-control-allow-methods"], credentials: r.headers["access-control-allow-credentials"] };
    };
    // The claim page: simple reads and the preflight before a JSON POST.
    assert.equal((await allow("GET", "/v1/network", CLAIM)).origin, CLAIM);
    assert.equal((await allow("GET", "/v1/network", "https://pay.longyu.network")).origin, "https://pay.longyu.network");
    const preflight = await allow("OPTIONS", "/v1/faucet", CLAIM, "POST");
    assert.equal(preflight.status, 204);
    assert.equal(preflight.origin, CLAIM);
    assert.equal(preflight.methods, "GET, POST");
    assert.equal(preflight.credentials, undefined, "bearer tokens, never cookies");
    // Any other site gets no permission, by request or by preflight.
    for (const origin of ["https://evil.example", "https://testnet.longyu.network.evil.example", "http://testnet.longyu.network", "null"]) {
      assert.equal((await allow("GET", "/v1/network", origin)).origin, undefined, origin);
      assert.equal((await allow("OPTIONS", "/v1/faucet", origin, "POST")).origin, undefined, origin);
      assert.equal((await allow("GET", "/admin", origin)).origin, undefined, origin);
    }
    // Published data files are public: read-only, from anywhere, found or not.
    const file = "/data/roots/day-1-0123456789abcdef.json";
    for (const origin of [CLAIM, "https://evil.example"]) {
      const r = await allow("GET", file, origin);
      assert.equal(r.status, 404);
      assert.equal(r.origin, "*");
      assert.equal(r.credentials, undefined);
    }
    assert.equal((await allow("OPTIONS", file, "https://evil.example", "GET")).methods, "GET");
    // A path that only resembles the data folder is not opened.
    for (const url of ["/data/rootsx/day-1-0123456789abcdef.json", "/data/roots", "/v1/network?next=/data/roots/", "//data/roots/x"]) {
      assert.equal((await allow("GET", url, "https://evil.example")).origin, undefined, url);
    }
  } finally {
    await env.close();
  }
});

test("limits count an IPv6 client by its /64, an IPv4 client by its address", () => {
  const cases: [string, string][] = [
    ["203.0.113.7", "203.0.113.7"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::"],
    ["2001:0DB8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:2::"],
    ["2001:db8:1:2::9", "2001:db8:1:2::"],
    ["2001:db8:1:3::9", "2001:db8:1:3::"],
    ["2001:db8::1", "2001:db8:0:0::"],
    ["::1", "0:0:0:0::"],
    ["fe80::1%eth0", "fe80:0:0:0::"],
    // IPv4 written as IPv6 is still that one IPv4 address.
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["::ffff:cb00:7107", "203.0.113.7"],
    ["0:0:0:0:0:ffff:cb00:7107", "203.0.113.7"],
    ["64:ff9b::203.0.113.7", "64:ff9b:0:0::"],
    // Not an address: left as it is.
    ["unknown", "unknown"],
    ["", ""],
  ];
  for (const [ip, bucket] of cases) assert.equal(ipBucket(ip), bucket, ip);
});

test("a new IPv6 address in the same /64 does not get around the faucet's per-network limit", async () => {
  const env = await makeEnv({ env: { ORIGIN_SECRET: SECRET } });
  try {
    const ask = (ip: string, n: number) =>
      env.app.inject({
        method: "POST", url: "/v1/faucet",
        headers: via({ "cf-connecting-ip": ip, "content-type": "application/json" }),
        payload: { address: `0x${n.toString(16).padStart(40, "0")}`, captchaToken: "dev-pass" },
      });
    for (let n = 1; n <= 3; n++) assert.equal((await ask(`2001:db8:1:2:${n}:${n}:${n}:${n}`, n)).statusCode, 200);
    const ips = (await env.deps.db.query<{ ip: string }>("SELECT DISTINCT ip FROM faucet_requests")).rows.map((r) => r.ip);
    assert.deepEqual(ips, ["2001:db8:1:2::"]);
    const fourth = await ask("2001:db8:1:2:ffff:ffff:ffff:ffff", 4);
    assert.equal(fourth.statusCode, 429);
    assert.equal(JSON.parse(fourth.body).error, "faucet_ip_limit");
    // The next /64 is another customer.
    assert.equal((await ask("2001:db8:1:3::1", 5)).statusCode, 200);
  } finally {
    await env.close();
  }
});

test("captcha: Cloudflare is told the client's exact address, and the check has a time limit", async () => {
  // The limit counts the /64, but Turnstile compares the address with the one that solved the widget.
  const env = await makeEnv({ env: { ORIGIN_SECRET: SECRET } });
  try {
    const told: (string | undefined)[] = [];
    env.deps.captcha = { verify: async (_token, ip) => (told.push(ip), true) };
    const r = await env.app.inject({
      method: "POST", url: "/v1/faucet",
      headers: via({ "cf-connecting-ip": "2001:db8:1:2:3:4:5:6", "content-type": "application/json" }),
      payload: { address: "0x000000000000000000000000000000000000beef", captchaToken: "token-1" },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(told, ["2001:db8:1:2:3:4:5:6"]);
    assert.equal((await env.deps.db.query<{ ip: string }>("SELECT ip FROM faucet_requests")).rows[0]!.ip, "2001:db8:1:2::");
  } finally {
    await env.close();
  }

  const calls: { url: string; init: RequestInit }[] = [];
  const answer = (status: number, body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  assert.equal(await turnstile("turnstile-secret", answer(200, { success: true })).verify("token-1", "203.0.113.7"), true);
  assert.equal(await turnstile("turnstile-secret", answer(200, { success: false })).verify("token-1"), false);
  assert.equal(await turnstile("turnstile-secret", answer(500, { success: true })).verify("token-1"), false);
  const [first, second] = calls as [typeof calls[number], typeof calls[number]];
  assert.equal(first.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.deepEqual(Object.fromEntries(first.init.body as URLSearchParams), { secret: "turnstile-secret", response: "token-1", remoteip: "203.0.113.7" });
  assert.deepEqual(Object.fromEntries(second.init.body as URLSearchParams), { secret: "turnstile-secret", response: "token-1" });
  assert.ok(calls.every((c) => c.init.signal instanceof AbortSignal && !c.init.signal.aborted), "a hung check is cut off, not waited on");
});
