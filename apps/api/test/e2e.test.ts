/**
 * End to end against real contracts on a local Anvil chain: the backend's viem chain gateway posts
 * roots, relays claims, drips the faucet and indexes events. Requires Foundry's `anvil` on PATH and
 * compiled contracts (`forge build`, then `npm run generate -w @longyu/abis`).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, parseEther, type Abi, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  emissionScheduleAbi, emissionScheduleBytecode, faucetAbi, faucetBytecode, longTokenAbi, longTokenBytecode, migrationDistributorAbi,
  migrationDistributorBytecode, miningDistributorAbi, miningDistributorBytecode, miningVaultAbi, miningVaultBytecode,
  paymentRouterAbi, paymentRouterBytecode,
} from "@longyu/abis";
import { watchPayments } from "../src/jobs/payments.ts";
import { createPaymentChain } from "../src/services/payments.ts";
import { computeMigration } from "../src/jobs/migration.ts";
import type { ScheduleParams } from "@longyu/reward-engine";
import { createViemChain } from "../src/services/chain.ts";
import { localAccount } from "../src/services/signer.ts";
import { indexEvents, processFaucet, publishNext, relayClaims } from "../src/jobs/chain-jobs.ts";
import { settleNextDay } from "../src/jobs/settlement.ts";
import { clearRootCache } from "../src/modules/mining.ts";
import { ADMIN_KEYS, E18, FakeClock, auth, call, makeEnv, mine, readyUser, type TestEnv } from "./helpers.ts";

const PORT = 8547;
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

test("backend + real contracts: mine, settle, post, relay, index, faucet, self-claim", async () => {
  // As on LONGYU: rewards in the tLONG token, gas and faucet drips in BNB.
  const keys = { admin: generatePrivateKey(), publisher: generatePrivateKey(), relayer: generatePrivateKey(), faucetSigner: generatePrivateKey() };
  const acct = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<keyof typeof keys, ReturnType<typeof privateKeyToAccount>>;
  for (const a of Object.values(acct)) await testClient.setBalance({ address: a.address, value: parseEther("100") });
  const admin = createWalletClient({ account: acct.admin, chain: foundry, transport });

  const now = (await pub.getBlock()).timestamp;
  const schedule: ScheduleParams = {
    startTime: (now / 86_400n) * 86_400n,
    initialDailyBudget: 12_000_000n * E18,
    periodDays: 30n,
    decayBps: 0n,
    totalCap: 4_000_000_000n * E18,
  };
  const deploy = async (abi: Abi, bytecode: Hex, args: unknown[]): Promise<Address> => {
    const hash = await admin.deployContract({ abi, bytecode, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const write = async (address: Address, abi: Abi, functionName: string, args: unknown[]) => {
    const hash = await admin.writeContract({ address, abi, functionName, args } as never);
    assert.equal((await pub.waitForTransactionReceipt({ hash })).status, "success");
  };
  const zero = "0x0000000000000000000000000000000000000000";
  const drip = parseEther("0.001");
  // Stands in for the bridged tLONG: any plain ERC-20 behaves the same for the mining contracts.
  const tlong = await deploy(longTokenAbi, longTokenBytecode, ["LONGYU Testnet Token", "tLONG", 4_000_000_000n * E18, acct.admin.address]);
  const balanceOf = (account: Address) => pub.readContract({ address: tlong, abi: longTokenAbi, functionName: "balanceOf", args: [account] });
  const scheduleAddr = await deploy(emissionScheduleAbi, emissionScheduleBytecode, [schedule.startTime, schedule.initialDailyBudget, 30n, 0n, schedule.totalCap]);
  const vault = await deploy(miningVaultAbi, miningVaultBytecode, [tlong, scheduleAddr, acct.admin.address]);
  const distributor = await deploy(miningDistributorAbi, miningDistributorBytecode, [
    tlong, scheduleAddr, 90n * E18, 12n * 3600n, 24_000_000n * E18, acct.admin.address, acct.publisher.address, acct.admin.address,
  ]);
  const faucet = await deploy(faucetAbi, faucetBytecode, [zero, acct.admin.address, acct.faucetSigner.address, acct.admin.address, drip, 86_400n, parseEther("1")]);
  await write(vault, miningVaultAbi, "setDistributor", [distributor]);
  await write(distributor, miningDistributorAbi, "setVault", [vault]);
  await write(tlong, longTokenAbi, "transfer", [vault, 1_000_000n * E18]);
  await testClient.setBalance({ address: faucet, value: parseEther("1") });

  const chain = createViemChain({
    rpcUrl: RPC, chainId: 31337n, chainName: "LONGYU Testnet", nativeSymbol: "tBNB", distributor, faucet,
    publisher: localAccount(keys.publisher), relayer: localAccount(keys.relayer), faucetSigner: localAccount(keys.faucetSigner),
    bscRpcUrl: RPC, babtAddress: zero,
  });
  assert.deepEqual(await chain.readSchedule(), schedule);
  const snap = await chain.healthSnapshot();
  assert.deepEqual(
    [snap.paused, snap.vaultBalance, snap.faucetBalance, snap.publisherBalance, snap.relayerBalance],
    [false, 1_000_000n * E18, parseEther("1"), parseEther("100"), parseEther("100")],
  );
  assert.deepEqual(await chain.rewardToken(), { address: getAddress(tlong), name: "LONGYU Testnet Token", symbol: "tLONG", decimals: 18 });

  const clock = new FakeClock(now, schedule.startTime);
  const env: TestEnv = await makeEnv({ clock, chain, schedule, env: { DISTRIBUTOR_ADDRESS: distributor, FAUCET_ADDRESS: faucet, FAUCET_DRIP_WEI: drip.toString() } });
  /** Moves the backend clock and the chain's clock together. */
  const moveTo = async (day: bigint, seconds: bigint) => {
    clock.at(day, seconds);
    await testClient.setNextBlockTimestamp({ timestamp: clock.now() });
    await testClient.mine({ blocks: 1 });
    clearRootCache();
  };

  try {
    const alice = await readyUser(env, "alice");
    const bob = await readyUser(env, "bob");
    const carol = await readyUser(env, "carol");
    await moveTo(0n, clock.now() - schedule.startTime + 60n);
    for (const u of [alice, bob, carol]) assert.equal((await mine(env, u)).status, 200);

    await moveTo(1n, 16n * 60n);
    assert.equal(await settleNextDay(env.deps), 0n);
    assert.equal(await publishNext(env.deps), 0n);
    assert.equal((await chain.readRoots()).pending?.day, 0n);

    await moveTo(1n, 12n * 3600n + 17n * 60n);
    await indexEvents(env.deps);
    assert.equal((await chain.readRoots()).active?.day, 0n);

    // Alice and Bob claim through the relayer; one transaction pays both.
    await call(env, "POST", "/v1/rewards/claim", {}, auth(alice));
    await call(env, "POST", "/v1/rewards/claim", {}, auth(bob));
    assert.equal(await relayClaims(env.deps), 2);
    assert.equal(await balanceOf(alice.wallet.address), 24n * E18);
    assert.equal(await balanceOf(bob.wallet.address), 24n * E18);

    // Carol uses the faucet for gas, then claims directly from the contract with the public proof,
    // which is how users can claim even if LONGYU's backend is gone.
    assert.equal((await call(env, "POST", "/v1/faucet", { address: carol.wallet.address, captchaToken: "dev-pass" })).status, 200);
    assert.equal(await processFaucet(env.deps), 1);
    assert.equal(await pub.getBalance({ address: carol.wallet.address }), drip);
    const proof = await call<{ cumulativeAmount: string; proof: Hex[] }>(env, "GET", `/v1/rewards/proof/${carol.wallet.address}`);
    const carolWallet = createWalletClient({ account: carol.wallet, chain: foundry, transport });
    const hash = await carolWallet.writeContract({
      address: distributor, abi: miningDistributorAbi, functionName: "claim",
      args: [carol.wallet.address, BigInt(proof.json.cumulativeAmount), proof.json.proof],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    assert.equal(await pub.getBalance({ address: carol.wallet.address }), drip - gas);
    assert.equal(await balanceOf(carol.wallet.address), 24n * E18);

    // The indexer sees the direct claim, so the app shows nothing left to claim.
    await indexEvents(env.deps);
    const r = await call<{ claimable: string; claimed: string }>(env, "GET", "/v1/rewards", undefined, auth(carol));
    assert.equal(r.json.claimed, (24n * E18).toString());
    assert.equal(r.json.claimable, "0");
    const totalClaimed = await pub.readContract({ address: distributor, abi: miningDistributorAbi, functionName: "totalClaimed" });
    assert.equal(totalClaimed, 72n * E18);

    // Migration: deploy the distributor, snapshot the real database, set the root, claim on-chain.
    const claimStart = (await pub.getBlock()).timestamp + 3600n;
    const migration = await deploy(migrationDistributorAbi, migrationDistributorBytecode, [
      zero, acct.admin.address, acct.admin.address, claimStart, 360n * 86_400n, claimStart + 720n * 86_400n, 2_500, acct.admin.address,
    ]);
    const snap = await computeMigration(env.deps.db, {
      snapshotDay: 0n, pool: 500n * E18, minMiningDays: 1, excludedCountries: [], kycThreshold: null,
    }, { chainId: 31337n, distributor: migration }, env.chain);
    assert.equal(snap.entries.length, 3);
    await write(migration, migrationDistributorAbi, "setRoot", [snap.root, snap.totalAllocated, snap.dataHash]);
    await testClient.setBalance({ address: migration, value: 500n * E18 });
    await testClient.setNextBlockTimestamp({ timestamp: claimStart });
    await testClient.mine({ blocks: 1 });
    const mine0 = snap.entries.find((e) => e.account === bob.wallet.address)!;
    const idx = [...snap.tree!.entries()].find(([, v]) => v[2] === bob.wallet.address)![0];
    const before = await pub.getBalance({ address: bob.wallet.address });
    const relayer = createWalletClient({ account: acct.relayer, chain: foundry, transport });
    const mh = await relayer.writeContract({
      address: migration, abi: migrationDistributorAbi, functionName: "claim",
      args: [bob.wallet.address, mine0.allocation, snap.tree!.getProof(idx) as Hex[]],
    });
    assert.equal((await pub.waitForTransactionReceipt({ hash: mh })).status, "success");
    assert.equal(await pub.getBalance({ address: bob.wallet.address }) - before, (mine0.allocation * 2_500n) / 10_000n);
  } finally {
    await env.close();
  }
});

test("payments: real PaymentRouter, a BEP-20 and native BNB, activated once after finality", async () => {
  const keys = { admin: generatePrivateKey(), treasury: generatePrivateKey(), payer: generatePrivateKey() };
  const acct = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<keyof typeof keys, ReturnType<typeof privateKeyToAccount>>;
  await testClient.setBalance({ address: acct.admin.address, value: parseEther("100") });
  await testClient.setBalance({ address: acct.payer.address, value: parseEther("100") });
  const admin = createWalletClient({ account: acct.admin, chain: foundry, transport });
  const payer = createWalletClient({ account: acct.payer, chain: foundry, transport });
  const send = async (hash: Hex) => {
    const r = await pub.waitForTransactionReceipt({ hash });
    assert.equal(r.status, "success");
    return r;
  };
  const usd = (await send(await admin.deployContract({
    abi: longTokenAbi, bytecode: longTokenBytecode, args: ["Test Dollar", "TUSD", 1_000_000n * E18, acct.payer.address],
  }))).contractAddress!;
  const deployed = await send(await admin.deployContract({
    abi: paymentRouterAbi, bytecode: paymentRouterBytecode, args: [acct.admin.address, acct.admin.address, acct.treasury.address],
  }));
  const router = deployed.contractAddress!;
  await send(await admin.writeContract({ address: router, abi: paymentRouterAbi, functionName: "setAcceptedToken", args: [usd, true] }));
  await send(await admin.writeContract({ address: router, abi: paymentRouterAbi, functionName: "setAcceptedToken", args: ["0x0000000000000000000000000000000000000000", true] }));

  const env = await makeEnv({
    clock: new FakeClock((await pub.getBlock()).timestamp),
    env: {
      PAYMENT_ROUTER_ADDRESS: router,
      PAYMENT_START_BLOCK: deployed.blockNumber.toString(),
      TREASURY_ADDRESS: acct.treasury.address,
      PAYMENT_CHAIN_ID: "31337",
      PAYMENT_TOKENS: `TUSD:${usd}:18,BNB:native:18`,
      BOOST_PLANS: "pro:5000:30:TUSD:9",
      PAYMENT_FINALITY: "finalized",
      PAYMENT_RPC_URL: RPC,
    },
    payments: createPaymentChain({ rpcUrl: RPC, chainId: 31337n, finality: "finalized" }),
  });
  try {
    const create = async (token: string, amount: string) => {
      const r = await call<{ id: string; orderId: Hex; amount: string; pay: { args: [Hex] } }>(env, "POST", "/v1/admin/orders", {
        customer: "Partner Labs", product: "verification_api", description: "Sybil checks for an airdrop", token, amount,
      }, { "x-admin-key": ADMIN_KEYS.alice });
      assert.equal(r.status, 200);
      return r.json;
    };
    const tokenOrder = await create("TUSD", "250");
    const bnbOrder = await create("BNB", "1.5");
    const treasuryBnb = await pub.getBalance({ address: acct.treasury.address });

    await send(await payer.writeContract({ address: usd, abi: longTokenAbi, functionName: "approve", args: [router, 250n * E18] }));
    await send(await payer.writeContract({ address: router, abi: paymentRouterAbi, functionName: "payToken", args: [tokenOrder.pay.args[0], usd, 250n * E18] }));
    await send(await payer.writeContract({ address: router, abi: paymentRouterAbi, functionName: "payNative", args: [bnbOrder.pay.args[0]], value: parseEther("1.5") }));
    // The contract itself refuses a second payment of the same order.
    await assert.rejects(payer.writeContract({ address: router, abi: paymentRouterAbi, functionName: "payNative", args: [bnbOrder.pay.args[0]], value: parseEther("1.5") }));

    // Anvil finalizes 64 blocks behind the head: nothing is activated before that.
    assert.equal(await watchPayments(env.deps), 0);
    const status = async (o: { orderId: Hex }) => (await call<{ status: string }>(env, "GET", `/v1/orders/${o.orderId}`)).json.status;
    assert.equal(await status(tokenOrder), "open");
    await testClient.mine({ blocks: 70 });
    assert.equal(await watchPayments(env.deps), 2);
    assert.equal(await status(tokenOrder), "paid");
    assert.equal(await status(bnbOrder), "paid");
    assert.equal(await watchPayments(env.deps), 0);

    // Funds went straight to the treasury; the router holds nothing.
    assert.equal(await pub.readContract({ address: usd, abi: longTokenAbi, functionName: "balanceOf", args: [acct.treasury.address] }), 250n * E18);
    assert.equal(await pub.getBalance({ address: acct.treasury.address }) - treasuryBnb, parseEther("1.5"));
    assert.equal(await pub.getBalance({ address: router }), 0n);
    const rows = (await env.deps.db.query<{ outcome: string; payer: string; treasury: string }>("SELECT outcome, payer, treasury FROM payments")).rows;
    assert.deepEqual(rows.map((r) => [r.outcome, r.payer, r.treasury]), [
      ["activated", acct.payer.address, acct.treasury.address],
      ["activated", acct.payer.address, acct.treasury.address],
    ]);

    // A miner buys a mining boost through the API and pays it on the real router: the boost starts.
    const booster = await readyUser(env, "booster");
    const order = await call<{ orderId: Hex; amount: string; pay: { router: Address; args: [Hex] } }>(env, "POST", "/v1/boosts/orders", { plan: "pro" }, auth(booster));
    assert.equal(order.status, 200, JSON.stringify(order.json));
    assert.equal(order.json.pay.router.toLowerCase(), router.toLowerCase());
    const price = BigInt(order.json.amount);
    assert.equal(price, 9n * E18);
    // Dust paid under the order's reference lands on another ID and does not use the order up.
    await send(await payer.writeContract({ address: router, abi: paymentRouterAbi, functionName: "payNative", args: [order.json.pay.args[0]], value: 1n }));
    assert.equal(await pub.readContract({ address: router, abi: paymentRouterAbi, functionName: "paid", args: [order.json.orderId] }), false);
    await send(await payer.writeContract({ address: usd, abi: longTokenAbi, functionName: "approve", args: [router, price] }));
    await send(await payer.writeContract({ address: router, abi: paymentRouterAbi, functionName: "payToken", args: [order.json.pay.args[0], usd, price] }));
    assert.equal(await pub.readContract({ address: router, abi: paymentRouterAbi, functionName: "orderIdOf", args: [order.json.pay.args[0], usd, price] }), order.json.orderId);
    assert.equal(await watchPayments(env.deps), 0, "not final yet");
    await testClient.mine({ blocks: 70 });
    assert.equal(await watchPayments(env.deps), 2);
    const outcomes = (await env.deps.db.query<{ outcome: string }>("SELECT outcome FROM payments ORDER BY block_number DESC, log_index DESC LIMIT 2")).rows.map((r) => r.outcome);
    assert.deepEqual(outcomes, ["activated", "unknown_order"]);
    const boosts = (await env.deps.db.query<{ boost_bps: number; days: bigint }>("SELECT boost_bps, end_day - start_day AS days FROM mining_boosts")).rows;
    assert.deepEqual(boosts.map((b) => [b.boost_bps, b.days]), [[5000, 30n]]);
  } finally {
    await env.close();
  }
});

test("wallet sweep: real native transfers, a reverted one, and code checks on a local chain", async () => {
  const adminKey = generatePrivateKey();
  const adminAcct = privateKeyToAccount(adminKey);
  await testClient.setBalance({ address: adminAcct.address, value: parseEther("100") });
  const admin = createWalletClient({ account: adminAcct, chain: foundry, transport });
  const now = (await pub.getBlock()).timestamp;
  const schedule: ScheduleParams = { startTime: (now / 86_400n) * 86_400n, initialDailyBudget: 12_000_000n * E18, periodDays: 30n, decayBps: 0n, totalCap: 4_000_000_000n * E18 };
  const deployed = async (abi: Abi, bytecode: Hex, args: unknown[]) =>
    (await pub.waitForTransactionReceipt({ hash: await admin.deployContract({ abi, bytecode, args }) })).contractAddress!;
  const zero = "0x0000000000000000000000000000000000000000";
  const scheduleAddr = await deployed(emissionScheduleAbi, emissionScheduleBytecode, [schedule.startTime, schedule.initialDailyBudget, 30n, 0n, schedule.totalCap]);
  const distributor = await deployed(miningDistributorAbi, miningDistributorBytecode, [
    zero, scheduleAddr, 90n * E18, 12n * 3600n, 24_000_000n * E18, adminAcct.address, adminAcct.address, adminAcct.address,
  ]);
  const chain = createViemChain({ rpcUrl: RPC, chainId: 31337n, chainName: "LONGYU Testnet", nativeSymbol: "tBNB", distributor, bscRpcUrl: RPC, babtAddress: zero });
  const env = await makeEnv({ clock: new FakeClock(now, schedule.startTime), chain, schedule, env: { DISTRIBUTOR_ADDRESS: distributor } });
  try {
    const { indexTransfers } = await import("../src/jobs/transfers.ts");
    const { runRiskRules } = await import("../src/jobs/risk.ts");
    const farm = privateKeyToAccount(generatePrivateKey()).address;
    const us = [];
    for (let i = 0; i < 6; i++) us.push(await readyUser(env, `sweep${i}`));
    assert.equal(await indexTransfers(env.deps), 0); // first run starts at the head
    for (const u of us) await testClient.setBalance({ address: u.wallet.address, value: parseEther("10") });
    for (const u of us.slice(0, 5)) {
      const w = createWalletClient({ account: u.wallet, chain: foundry, transport });
      await pub.waitForTransactionReceipt({ hash: await w.sendTransaction({ to: farm, value: parseEther("1") }) });
    }
    // The sixth sends value to a contract with no receive function: the transaction reverts and moves nothing.
    const w6 = createWalletClient({ account: us[5]!.wallet, chain: foundry, transport });
    const bad = await pub.waitForTransactionReceipt({ hash: await w6.sendTransaction({ to: scheduleAddr, value: parseEther("1"), gas: 100_000n }) });
    assert.equal(bad.status, "reverted");

    assert.equal(await indexTransfers(env.deps), 5);
    assert.equal(await chain.isContract(scheduleAddr), true);
    assert.equal(await chain.isContract(farm), false);
    await runRiskRules(env.deps, (env.clock.now() - schedule.startTime) / 86_400n);
    const flags = (await env.deps.db.query<{ severity: string; destination: string }>(
      "SELECT severity, detail->>'destination' AS destination FROM flags WHERE kind = 'wallet_sweep'",
    )).rows;
    assert.equal(flags.length, 5);
    assert.ok(flags.every((f) => f.severity === "hold" && f.destination === farm));
  } finally {
    await env.close();
  }
});
