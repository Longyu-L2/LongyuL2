/**
 * Boots the real server wiring (createDeps: viem chain, PGlite, migrations, jobs) against a local
 * devnet and checks a few endpoints over HTTP. Requires Foundry's anvil.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createDeps } from "../src/server.ts";
import { pkceChallenge } from "../src/services/external.ts";
import { startJobs } from "../src/jobs/runner.ts";
import { startDevnet } from "../scripts/devnet.ts";

test("the production wiring boots against a devnet and serves requests", async () => {
  const { env, stop } = await startDevnet({ port: 8549 });
  const dir = mkdtempSync(join(tmpdir(), "longyu-server-"));
  const config = loadConfig({ ...env, PGLITE_DIR: join(dir, "db"), DATA_DIR: join(dir, "data") });
  let cleanup = async () => stop();
  try {
    const deps = await createDeps(config);
    const app = await buildApp(deps);
    const stopJobs = startJobs(deps, (msg, err) => console.error(msg, err));
    cleanup = async () => {
      stopJobs();
      await app.close();
      await deps.db.close();
      stop();
    };
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);
    const network = await (await fetch(`${base}/v1/network`)).json();
    assert.equal(network.chainId, "31337");
    assert.equal(network.distributor, env.DISTRIBUTOR_ADDRESS);
    assert.equal(deps.schedule.initialDailyBudget, 12_000_000n * 10n ** 18n);
    const appVerifier = randomBytes(32).toString("base64url");
    const start = await fetch(`${base}/v1/auth/x/start`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appChallenge: pkceChallenge(appVerifier), purpose: "sign-in" }),
    });
    assert.equal(start.status, 200);
    // Security headers are present on every response.
    assert.equal(start.headers.get("x-content-type-options"), "nosniff");
    // The development sign-in page leads back to this API's callback, which redirects into the app.
    const authorize = new URL((await start.json()).authorizeUrl);
    assert.equal(authorize.pathname, "/v1/auth/x/callback");
    const back = await fetch(`${base}${authorize.pathname}${authorize.search}`, { redirect: "manual" });
    assert.equal(back.status, 302);
    assert.equal(back.headers.get("cache-control"), "no-store");
    assert.equal(back.headers.get("referrer-policy"), "no-referrer");
    const target = back.headers.get("location") ?? "";
    assert.match(target, /^longyumine:\/\/auth\?ticket=[A-Za-z0-9_-]{43}$/);
    const finish = await fetch(`${base}/v1/auth/x/finish`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: target.split("ticket=")[1], appVerifier, installId: "install-boot", platform: "android" }),
    });
    assert.equal(finish.status, 200);
    const session = await finish.json();
    const me = await (await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${session.accessToken}` } })).json();
    assert.deepEqual([session.newUser, me.xUsername], [true, "dev_miner"]);
    // The indexer job ran against the live chain.
    await new Promise((r) => setTimeout(r, 1500));
    const cursor = await deps.db.query<{ block: bigint }>("SELECT block FROM chain_cursor WHERE name = 'distributor'");
    assert.ok(cursor.rows[0] && cursor.rows[0].block > 0n);
  } finally {
    await cleanup();
  }
});
