/**
 * Contract verification end to end, the way a project does it: a Foundry project built and deployed
 * on a local Anvil chain, then `forge verify-contract` pointed at the explorer. The explorer
 * downloads the pinned compiler, compiles in its isolated process and compares with the chain.
 * Requires Foundry (`anvil`, `forge`) on PATH and a network connection for the compiler.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createTestClient, http, parseEther, type Hex } from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { createPgliteDb, migrate } from "../src/db.ts";
import { Indexer } from "../src/indexer.ts";
import * as Q from "../src/queries.ts";
import { httpRpc } from "../src/rpc.ts";

const PORT = 8550;
const RPC = `http://127.0.0.1:${PORT}`;
const transport = http(RPC);
const pub = createPublicClient({ chain: foundry, transport });
const testClient = createTestClient({ chain: foundry, mode: "anvil", transport });
const shell = process.platform === "win32";
let anvil: ChildProcess;

before(async () => {
  anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore", shell });
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("anvil did not start");
});

after(() => {
  if (shell) spawn("taskkill", ["/pid", String(anvil.pid), "/T", "/F"]);
  else anvil.kill();
});

const COUNTER = (by: string) => `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract Counter {
    uint256 public immutable step;
    uint256 public count;

    constructor(uint256 step_) {
        step = step_;
    }

    function bump() external {
        count += ${by};
    }
}
`;

test("forge verify-contract publishes a contract's source, and a changed source is refused", { timeout: 600_000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), "longyu-forge-"));
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "foundry.toml"), '[profile.default]\nsrc = "src"\nout = "out"\nsolc = "0.8.28"\nevm_version = "cancun"\noptimizer = true\noptimizer_runs = 10000\n');
  writeFileSync(join(project, "src", "Counter.sol"), COUNTER("step"));
  const forge = (...args: string[]) => spawnSync("forge", args, { cwd: project, encoding: "utf8", shell, timeout: 300_000 });
  /** forge, without stopping this process: the explorer it talks to is served from here. */
  const forgeWhileServing = (...args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn("forge", args, { cwd: project, shell });
      const out = { stdout: "", stderr: "" };
      child.stdout.on("data", (d) => (out.stdout += d));
      child.stderr.on("data", (d) => (out.stderr += d));
      child.on("close", (status) => done({ status, ...out }));
    });

  const key = generatePrivateKey();
  await testClient.setBalance({ address: privateKeyToAccount(key).address, value: parseEther("10") });
  const deploy = (step: bigint): Hex => {
    const made = forge("create", "src/Counter.sol:Counter", "--rpc-url", RPC, "--private-key", key, "--broadcast", "--constructor-args", String(step));
    const address = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(made.stdout)?.[1];
    assert.ok(address, `forge create: ${made.stdout}\n${made.stderr}`);
    return address.toLowerCase() as Hex;
  };
  const [first, second] = [deploy(7n), deploy(9n)];

  const db = await createPgliteDb();
  await migrate(db);
  const rpc = httpRpc(RPC);
  const indexer = new Indexer(db, rpc, { startBlock: 0n, batchSize: 50 });
  const head = await pub.getBlockNumber({ cacheTime: 0 });
  for (let i = 0; i < 10; i++) if ((await indexer.step()).tip === head) break;

  const config = ConfigSchema.parse({ RPC_URL: RPC, CHAIN_ID: "31337", NODE_ENV: "test", COMPILER_CACHE_DIR: mkdtempSync(join(tmpdir(), "longyu-compilers-")) });
  const app = await buildApp({ db, rpc, config });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const api = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
  const args = (step: bigint) => `0x${step.toString(16).padStart(64, "0")}`;
  const verify = (address: Hex, step: bigint, verifier: string[]) =>
    forgeWhileServing("verify-contract", address, "src/Counter.sol:Counter", "--chain-id", "31337", ...verifier, "--verifier-url", api, "--constructor-args", args(step), "--watch");
  try {
    const sent = await verify(first, 7n, ["--verifier", "blockscout"]);
    assert.equal(sent.status, 0, `${sent.stdout}\n${sent.stderr}`);
    assert.match(sent.stdout, /Pass - Verified/);
    const row = (await Q.verified(db, first))!;
    assert.deepEqual(
      [row.name, row.file, row.compiler, row.match_kind, row.creation_checked, row.constructor_args, row.optimizer, row.runs, row.evm_version],
      ["Counter", "src/Counter.sol", "0.8.28+commit.7893614a", "full", true, args(7n).slice(2), true, 10000n, "cancun"],
    );
    const page = await fetch(`${api.replace("/api", "")}/address/${first}?tab=contract`);
    assert.ok((await page.text()).includes("uint256 public immutable step;"));

    // Sent again, forge finds it verified and stops there.
    const again = await verify(first, 7n, ["--verifier", "blockscout"]);
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
    assert.match(again.stdout, /already verified/i);

    // Another through forge's client for explorers that speak Etherscan's API with a key, as Hardhat's plugin does.
    const other = await verify(second, 9n, ["--verifier", "custom", "--verifier-api-key", "none"]);
    assert.equal(other.status, 0, `${other.stdout}\n${other.stderr}`);
    assert.equal((await Q.verified(db, second))!.constructor_args, args(9n).slice(2));

    // A third contract, and a source that is not the one it was built from.
    const third = deploy(11n);
    for (let i = 0; i < 10; i++) if ((await indexer.step()).tip === (await pub.getBlockNumber({ cacheTime: 0 }))) break;
    writeFileSync(join(project, "src", "Counter.sol"), COUNTER("step + 1"));
    const wrong = await verify(third, 11n, ["--verifier", "blockscout"]);
    assert.notEqual(wrong.status, 0);
    assert.match(`${wrong.stdout}${wrong.stderr}`, /Fail - Unable to verify/);
    assert.equal(await Q.verified(db, third), null);
  } finally {
    await app.close();
    await db.close();
  }
});
