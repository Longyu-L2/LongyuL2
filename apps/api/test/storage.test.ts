import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { hashJson } from "@longyu/reward-engine";
import { loadConfig } from "../src/config.ts";
import { publishNext } from "../src/jobs/chain-jobs.ts";
import { rootFilePath, settleNextDay } from "../src/jobs/settlement.ts";
import { localFileStore, s3Client, s3FileStore } from "../src/services/external.ts";
import { makeEnv, mine, readyUser } from "./helpers.ts";

/** A minimal path-style S3 endpoint: enough to check what the real SDK sends and how replies parse. */
async function fakeS3() {
  const objects = new Map<string, { body: string; headers: IncomingHttpHeaders }>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const key = decodeURIComponent((req.url ?? "").split("?")[0]!);
      if (req.method === "PUT") {
        objects.set(key, { body: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
        res.writeHead(200, { etag: '"1"' }).end();
      } else if (req.method === "GET" && objects.has(key)) {
        const o = objects.get(key)!;
        res.writeHead(200, { "content-type": String(o.headers["content-type"]) }).end(o.body);
      } else {
        res.writeHead(404, { "content-type": "application/xml" })
          .end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { objects, endpoint: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("s3 store: the real SDK writes immutable public JSON and reads it back", async () => {
  const s3 = await fakeS3();
  try {
    const client = s3Client({ bucket: "longyu-data", region: "auto", endpoint: s3.endpoint, accessKeyId: "k", secretAccessKey: "s" });
    const store = s3FileStore(client, "longyu-data", "https://data.longyu.network/");
    const body = JSON.stringify({ day: 3, root: "0xabc", note: "龙宇" });
    assert.equal(await store.put("roots/day-3-0123456789abcdef.json", body), "https://data.longyu.network/roots/day-3-0123456789abcdef.json");
    const stored = s3.objects.get("/longyu-data/roots/day-3-0123456789abcdef.json");
    assert.ok(stored, "path-style key under the bucket");
    assert.equal(stored.body, body);
    assert.equal(stored.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(stored.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.ok(String(stored.headers.authorization).startsWith("AWS4-HMAC-SHA256 Credential=k/"));
    assert.ok(!Object.keys(stored.headers).some((h) => h.startsWith("x-amz-checksum-")), "no optional checksums for S3-compatible stores");
    assert.equal(await store.get("roots/day-3-0123456789abcdef.json"), body);
    assert.equal(await store.get("roots/day-4-0123456789abcdef.json"), null);
    assert.equal(store.url("roots/x.json"), "https://data.longyu.network/roots/x.json");
  } finally {
    await s3.close();
  }
});

test("file stores refuse paths outside their root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "longyu-files-"));
  const local = localFileStore(dir, "http://localhost/data");
  const s3 = s3FileStore({ send: async () => ({}) }, "b", "https://x.example");
  for (const bad of ["../secret.json", "roots/../../x", "/etc/passwd", "roots//x.json", "Roots/x.json", "roots\\x.json", ""]) {
    await assert.rejects(local.put(bad, "{}"), /invalid file path/, bad);
    await assert.rejects(local.get(bad), /invalid file path/, bad);
    await assert.rejects(s3.put(bad, "{}"), /invalid file path/, bad);
  }
  await local.put("roots/day-1-0000000000000000.json", '{"a":1}');
  assert.equal(await local.get("roots/day-1-0000000000000000.json"), '{"a":1}');
  assert.equal(await local.get("roots/day-2-0000000000000000.json"), null);
});

test("s3 store: other storage errors are not mistaken for a missing file", async () => {
  const failing = s3FileStore(
    { send: async () => { throw Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }); } },
    "b",
    "https://x.example",
  );
  await assert.rejects(failing.get("roots/a.json"), /denied/);
});

test("config: production needs a bucket and a public https data URL", () => {
  const base = {
    NODE_ENV: "production",
    JWT_SECRET: "x".repeat(40),
    RPC_URL: "http://127.0.0.1:8545",
    CHAIN_ID: "668801",
    DISTRIBUTOR_ADDRESS: "0x0000000000000000000000000000000000000001",
    DATABASE_URL: "postgres://u:p@db/x",
    TURNSTILE_SECRET: "t",
    X_CLIENT_ID: "client-id",
    X_CLIENT_SECRET: "client-secret",
    X_REDIRECT_URI: "https://api.longyu.network/v1/auth/x/callback",
    SIGNER_URL: "http://signer.railway.internal:8080",
    SIGNER_TOKEN: "s".repeat(40),
    ORIGIN_SECRET: "o".repeat(40),
    PUBLIC_RPC_URL: "https://rpc-testnet.longyu.network",
  };
  assert.throws(() => loadConfig({ ...base, PUBLIC_DATA_BASE_URL: "https://data.longyu.network" }), /STORAGE_BUCKET is required/);
  assert.throws(() => loadConfig({ ...base, STORAGE_BUCKET: "d" }), /public https URL/);
  assert.throws(() => loadConfig({ ...base, STORAGE_BUCKET: "d", PUBLIC_DATA_BASE_URL: "http://data.longyu.network" }), /public https URL/);
  assert.throws(
    () => loadConfig({ ...base, STORAGE_BUCKET: "d", PUBLIC_DATA_BASE_URL: "https://api.longyu.network/data", STORAGE_ACCESS_KEY_ID: "a" }),
    /set together/,
  );
  const ok = loadConfig({ ...base, STORAGE_BUCKET: "d", PUBLIC_DATA_BASE_URL: "https://api.longyu.network/data" });
  assert.equal(ok.STORAGE_REGION, "auto");
  assert.equal(ok.STORAGE_PUBLIC_READ, false);

  // A private bucket answers nobody directly: an address nothing serves would be written on-chain
  // with every root, for good. It must be this API's own.
  const stored = { ...base, STORAGE_BUCKET: "d" };
  for (const url of [
    "https://data.longyu.network", "https://data.longyu.network/data", "https://api.longyu.network", "https://api.longyu.network/files",
    "https://api.longyu.network/data/roots", "https://api.longyu.network:8443/data", "https://api.longyu.network.evil.example/data",
  ]) {
    assert.throws(() => loadConfig({ ...stored, PUBLIC_DATA_BASE_URL: url }), /PUBLIC_DATA_BASE_URL must be https:\/\/api\.longyu\.network\/data/, url);
  }
  assert.equal(loadConfig({ ...stored, PUBLIC_DATA_BASE_URL: "https://api.longyu.network/data/" }).STORAGE_PUBLIC_READ, false);
  // A bucket with its own public address is named as one.
  const open = loadConfig({ ...stored, STORAGE_PUBLIC_READ: "true", PUBLIC_DATA_BASE_URL: "https://data.longyu.network" });
  assert.equal(open.STORAGE_PUBLIC_READ, true);
});

test("publisher refuses to post a root whose data file is missing or altered", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "a");
    env.clock.at(0n, 3600n);
    await mine(env, a);
    env.clock.at(1n, 16n * 60n);
    assert.equal(await settleNextDay(env.deps), 0n);
    const s = (await env.deps.db.query<{ data_hash: string; data_uri: string }>("SELECT data_hash, data_uri FROM settlements WHERE day = 0")).rows[0]!;
    const path = rootFilePath(0n, s.data_hash);
    assert.equal(s.data_uri, env.deps.files.url(path));
    const original = (await env.deps.files.get(path))!;
    assert.equal(hashJson(original), s.data_hash, "file stored before the settlement committed");

    const files = env.deps.files;
    env.deps.files = { ...files, get: async () => null };
    await assert.rejects(publishNext(env.deps), /missing or does not match/);
    env.deps.files = files;
    await env.deps.files.put(path, `${original}
`);
    await assert.rejects(publishNext(env.deps), /missing or does not match/);
    assert.equal(env.chain.pending, null);

    await env.deps.files.put(path, original);
    assert.equal(await publishNext(env.deps), 0n);
    assert.equal((await env.chain.readRoots()).pending?.dataHash, s.data_hash);

    // The API serves the same bytes under the content-addressed name only.
    const file = await env.app.inject({ method: "GET", url: `/data/${path}` });
    assert.equal(file.statusCode, 200);
    assert.equal(hashJson(file.body), s.data_hash);
    assert.equal(file.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal((await env.app.inject({ method: "GET", url: "/data/roots/day-0.json" })).statusCode, 400);

    // Any page may read a published file, as the claim page does from the address on-chain.
    const cross = await env.app.inject({ method: "GET", url: `/data/${path}`, headers: { origin: "https://anywhere.example" } });
    assert.equal(cross.statusCode, 200);
    assert.equal(cross.headers["access-control-allow-origin"], "*");
    assert.equal(cross.headers["access-control-allow-credentials"], undefined);
    assert.equal(hashJson(cross.body), s.data_hash);
    // Nothing else is opened to other sites.
    for (const url of ["/v1/stats", "/health", "/data/roots", "/v1/data/roots/x"]) {
      const other = await env.app.inject({ method: "GET", url, headers: { origin: "https://anywhere.example" } });
      assert.equal(other.headers["access-control-allow-origin"], undefined, url);
    }
  } finally {
    await env.close();
  }
});

test("a failed upload leaves the day unsettled, so the next run retries it", async () => {
  const env = await makeEnv();
  try {
    const a = await readyUser(env, "a");
    env.clock.at(0n, 3600n);
    await mine(env, a);
    env.clock.at(1n, 16n * 60n);
    const files = env.deps.files;
    env.deps.files = { ...files, put: async () => { throw new Error("storage down"); } };
    await assert.rejects(settleNextDay(env.deps), /storage down/);
    const n = (await env.deps.db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM settlements")).rows[0]!.n;
    assert.equal(n, 0n);
    env.deps.files = files;
    assert.equal(await settleNextDay(env.deps), 0n);
  } finally {
    await env.close();
  }
});
