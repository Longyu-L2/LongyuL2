/**
 * LONGYU Scan end to end on a local Anvil chain: real transactions (a token with a hostile name,
 * transfers, a failed call, a contract creation, a plain payment), indexed and then served.
 * Requires Foundry's `anvil` on PATH.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, parseEther, type Hex } from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { longTokenAbi, longTokenBytecode } from "@longyu/abis";
import { buildApp } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { createPgliteDb, migrate } from "../src/db.ts";
import { Indexer } from "../src/indexer.ts";
import { httpRpc } from "../src/rpc.ts";

const PORT = 8549;
const RPC = `http://127.0.0.1:${PORT}`;
const transport = http(RPC);
const pub = createPublicClient({ chain: foundry, transport });
const testClient = createTestClient({ chain: foundry, mode: "anvil", transport });
let anvil: ChildProcess;

before(async () => {
  anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore", shell: process.platform === "win32" });
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
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(anvil.pid), "/T", "/F"]);
  else anvil.kill();
});

const EVIL = `<img src=x onerror=alert(1)>`;

test("index a real chain and serve it", async () => {
  const [alice, bob] = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
  await testClient.setBalance({ address: alice.address, value: parseEther("10") });
  const wallet = createWalletClient({ account: alice, chain: foundry, transport });
  const wait = async (hash: Hex) => pub.waitForTransactionReceipt({ hash });

  const deploy = await wait(await wallet.deployContract({ abi: longTokenAbi, bytecode: longTokenBytecode, args: [EVIL, "EVIL", 1_000_000n * 10n ** 18n, alice.address] }));
  const token = deploy.contractAddress!.toLowerCase();
  const transfer = await wait(await wallet.writeContract({ address: token as Hex, abi: longTokenAbi, functionName: "transfer", args: [bob.address, 250n * 10n ** 18n] }));
  const payment = await wait(await wallet.sendTransaction({ to: bob.address, value: parseEther("1.5") }));
  // A transfer of more than Alice holds, sent with a fixed gas limit so it is mined and reverts.
  const failed = await wait(await wallet.sendTransaction({
    to: token as Hex, gas: 100_000n,
    data: encodeFunctionData({ abi: longTokenAbi, functionName: "transfer", args: [bob.address, 10n ** 40n] }),
  }));
  assert.equal(failed.status, "reverted");

  const db = await createPgliteDb();
  await migrate(db);
  const rpc = httpRpc(RPC);
  const indexer = new Indexer(db, rpc, { startBlock: 0n, batchSize: 50 });
  const head = await pub.getBlockNumber({ cacheTime: 0 });
  for (let i = 0; i < 10; i++) if ((await indexer.step()).tip === head) break;

  const config = ConfigSchema.parse({ RPC_URL: RPC, CHAIN_ID: "31337", NODE_ENV: "test", KNOWN_ADDRESSES: `${token}:Test token`, SWAP_URL: "https://pages.example/swap.html" });
  assert.throws(() => ConfigSchema.parse({ RPC_URL: RPC, CHAIN_ID: "31337", SWAP_URL: "javascript:alert(1)" }));
  const app = await buildApp({ db, rpc, config });
  const get = (url: string) => app.inject({ method: "GET", url });
  try {
    const home = await get("/");
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /LONGYU<\/span><span class="scan">Scan/);
    assert.match(String(home.headers["content-security-policy"]), /script-src 'self'/);
    assert.equal(home.headers["x-frame-options"], "DENY");
    assert.ok(home.body.includes('<a href="https://pages.example/swap.html" rel="noopener">Swap</a>'), "the footer links to the swap page");

    // The hostile token name is shown, escaped, wherever it appears.
    for (const url of [`/token/${token}`, "/tokens", `/address/${bob.address.toLowerCase()}?tab=tokens`, `/tx/${transfer.transactionHash}`]) {
      const r = await get(url);
      assert.equal(r.statusCode, 200, url);
      assert.ok(!r.body.includes("<img src=x"), `${url} must not contain raw markup`);
    }
    const tokenPage = await get(`/token/${token}?tab=holders`);
    assert.ok(tokenPage.body.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(tokenPage.body.includes("999,750"), "Alice's balance after the transfer");

    const tx = await get(`/tx/${transfer.transactionHash}`);
    assert.match(tx.body, /<strong>transfer<\/strong>/);
    assert.match(tx.body, /<strong>Transfer<\/strong>/);
    assert.match(tx.body, /Success/);
    assert.match((await get(`/tx/${failed.transactionHash}`)).body, /Failed/);
    assert.match((await get(`/tx/${deploy.transactionHash}`)).body, /Contract created/);

    const addr = await get(`/address/${bob.address.toLowerCase()}`);
    assert.equal(addr.statusCode, 200);
    assert.match(addr.body, /<strong>1\.5 <small>/, "Bob's live balance: the 1.5 he was paid");
    assert.equal((await get(`/address/${bob.address.toLowerCase()}?tab=transfers`)).statusCode, 200);
    assert.equal((await get(`/block/${transfer.blockNumber}`)).statusCode, 200);
    assert.equal((await get("/blocks")).statusCode, 200);
    assert.equal((await get("/txs")).statusCode, 200);
    assert.equal((await get("/bridge")).statusCode, 200);
    assert.equal((await get("/api-docs")).statusCode, 200);

    // Search
    assert.equal((await get(`/search?q=${transfer.blockNumber}`)).headers.location, `/block/${transfer.blockNumber}`);
    assert.equal((await get(`/search?q=${transfer.transactionHash}`)).headers.location, `/tx/${transfer.transactionHash}`);
    assert.equal((await get(`/search?q=${token}`)).headers.location, `/token/${token}`);
    assert.equal((await get("/search?q=evil")).headers.location, `/token/${token}`);
    assert.equal((await get(`/search?q=${bob.address}`)).headers.location, `/address/${bob.address.toLowerCase()}`);

    // Unknown paths and traversal attempts
    assert.equal((await get("/nope")).statusCode, 404);
    assert.equal((await get("/tx/0x1234")).statusCode, 404);
    assert.equal((await get("/static/app.css")).statusCode, 200);
    assert.equal((await get("/static/../src/app.ts")).statusCode, 404);
    assert.equal((await get("/static/%2e%2e/package.json")).statusCode, 404);

    // JSON API
    const apiTx = (await get(`/api/v1/tx/${transfer.transactionHash}`)).json();
    assert.equal(apiTx.call.name, "transfer");
    assert.equal(apiTx.transfers[0].value, (250n * 10n ** 18n).toString());
    assert.equal((await get(`/api/v1/tx/0x${"00".repeat(32)}`)).statusCode, 404);
    const stats = (await get("/api/v1/stats")).json();
    assert.equal(stats.head.number, head.toString());
    assert.equal(stats.transactions, "4");

    // Etherscan-compatible API
    const txlist = (await get(`/api?module=account&action=txlist&address=${alice.address}&sort=asc`)).json();
    assert.equal(txlist.status, "1");
    assert.deepEqual(txlist.result.map((t: { isError: string }) => t.isError), ["0", "0", "0", "1"]);
    assert.equal(txlist.result[0].contractAddress, token);
    const tokentx = (await get(`/api?module=account&action=tokentx&contractaddress=${token}&address=${bob.address}`)).json();
    assert.equal(tokentx.result.length, 1);
    assert.equal(tokentx.result[0].tokenSymbol, "EVIL");
    const tb = (await get(`/api?module=account&action=tokenbalance&contractaddress=${token}&address=${bob.address}`)).json();
    assert.equal(tb.result, (250n * 10n ** 18n).toString());
    const supply = (await get(`/api?module=stats&action=tokensupply&contractaddress=${token}`)).json();
    assert.equal(supply.result, (1_000_000n * 10n ** 18n).toString());
    assert.equal((await get("/api?module=account&action=txlist&address=nope")).json().message, "NOTOK");
    assert.equal(payment.status, "success");
  } finally {
    await app.close();
    await db.close();
  }
});
