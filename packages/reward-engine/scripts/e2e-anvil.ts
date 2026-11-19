/**
 * End-to-end run on a local Anvil chain:
 *   deploy contracts -> settle two days with the engine -> post the root -> wait out the veto
 *   window -> a relayer claims for every miner in one batch -> balances match the engine.
 *
 * Usage (from packages/reward-engine, with Anvil listening on 127.0.0.1:8545):
 *   npx tsx scripts/e2e-anvil.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEther,
  type Abi,
  type Hex,
} from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { VERIFICATION_GATED_PARAMS, type Address, type MinerInput, type ScheduleParams } from "../src/index.ts";
import { proofFor } from "../src/merkle.ts";
import { EMPTY_LEDGER, settleDay, type ChainView } from "../src/settle.ts";

const RPC = "http://127.0.0.1:8545";
const E18 = 10n ** 18n;
const transport = http(RPC);
const pub = createPublicClient({ chain: foundry, transport });
const testClient = createTestClient({ chain: foundry, mode: "anvil", transport });

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = fileURLToPath(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url));
  const json = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function waitForRpc(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Anvil is not reachable at " + RPC);
}

async function main(): Promise<void> {
  await waitForRpc();
  const keys = { admin: generatePrivateKey(), publisher: generatePrivateKey(), guardian: generatePrivateKey(), relayer: generatePrivateKey() };
  const accounts = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<keyof typeof keys, ReturnType<typeof privateKeyToAccount>>;
  for (const a of Object.values(accounts)) await testClient.setBalance({ address: a.address, value: parseEther("100") });
  const wallet = (who: keyof typeof keys) => createWalletClient({ account: accounts[who], chain: foundry, transport });

  // Day 0 started two UTC days ago, so days 0 and 1 are closed.
  const now = (await pub.getBlock()).timestamp;
  const schedule: ScheduleParams = {
    startTime: (now / 86_400n) * 86_400n - 2n * 86_400n,
    initialDailyBudget: 12_000_000n * E18,
    periodDays: 30n,
    decayBps: 0n,
    totalCap: 4_000_000_000n * E18,
  };

  const deploy = async (name: string, args: unknown[]): Promise<Address> => {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet("admin").deployContract({ abi, bytecode, args });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`deploy ${name} failed`);
    return receipt.contractAddress as Address;
  };
  const scheduleAddr = await deploy("EmissionSchedule", [schedule.startTime, schedule.initialDailyBudget, 30n, 0n, schedule.totalCap]);
  const vaultAddr = await deploy("MiningVault", ["0x0000000000000000000000000000000000000000", scheduleAddr, accounts.admin.address]);
  const distAddr = await deploy("MiningDistributor", [
    "0x0000000000000000000000000000000000000000", scheduleAddr, 43n * E18, 12n * 3600n, 24_000_000n * E18,
    accounts.admin.address, accounts.publisher.address, accounts.guardian.address,
  ]);
  const vaultAbi = artifact("MiningVault").abi;
  const distAbi = artifact("MiningDistributor").abi;
  const send = async (who: keyof typeof keys, address: Address, abi: Abi, functionName: string, args: unknown[]) => {
    const hash = await wallet(who).writeContract({ address, abi, functionName, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return r;
  };
  await send("admin", vaultAddr, vaultAbi, "setDistributor", [distAddr]);
  await send("admin", distAddr, distAbi, "setVault", [vaultAddr]);
  await testClient.setBalance({ address: vaultAddr, value: 1_000_000n * E18 });
  console.log(`deployed: schedule ${scheduleAddr}, vault ${vaultAddr}, distributor ${distAddr}`);

  // Ten miners: mixed tiers, one newcomer who verifies on day 1.
  const users = Array.from({ length: 10 }, () => privateKeyToAccount(generatePrivateKey()).address as Address);
  const miner = (i: number, tier: 0 | 1 | 2 | 3, streakDays = 0): MinerInput => ({
    account: users[i]!, tier, streakDays, activeVerifiedInvites: 0, contributionBps: 0, held: false,
  });
  const chainView = (claimed = new Map<Address, bigint>()): ChainView => ({
    chainId: BigInt(foundry.id), distributor: distAddr, maxRewardPerDay: 43n * E18,
    maxDailyIncrease: 24_000_000n * E18, referenceRoot: null, claimed,
  });
  const base = { schedule, params: VERIFICATION_GATED_PARAMS, forfeit: [] as Address[] };
  const day0 = settleDay(EMPTY_LEDGER, {
    ...base, day: 0n, chain: chainView(), verifiedToday: [],
    miners: [miner(0, 2), miner(1, 3, 4), miner(2, 1), miner(3, 2), miner(4, 2)],
  });
  const day1 = settleDay(day0.ledger, {
    ...base, day: 1n, chain: chainView(), verifiedToday: [users[2]!],
    miners: users.map((_, i) => miner(i, i === 2 ? 2 : (i % 4 === 0 ? 3 : 2), i < 5 ? 1 : 0)),
  });
  if (!day1.root || !day1.tree) throw new Error("no root");
  console.log(`settled: ${day1.stats.leaves} leaves, total ${day1.totalEntitled} wei, backlog released ${day1.stats.backlogReleased}`);

  // Publish the root, then show it is not claimable during the veto window.
  await send("publisher", distAddr, distAbi, "proposeRoot", [1n, day1.root, day1.totalEntitled, day1.dataHash, "local://day-1.json"]);
  const first = proofFor(day1.tree, users[0]!);
  try {
    await pub.simulateContract({ address: distAddr, abi: distAbi, functionName: "claim", args: [users[0], first.amount, first.proof], account: accounts.relayer });
    throw new Error("claim should fail before the veto window ends");
  } catch (e) {
    if ((e as Error).message.includes("should fail")) throw e;
    console.log("claim during veto window: rejected as expected");
  }
  await testClient.increaseTime({ seconds: 12 * 3600 });
  await testClient.mine({ blocks: 1 });

  // One relayed batch pays everyone; the relayer only pays gas.
  const batch = users.map((u) => proofFor(day1.tree!, u));
  const receipt = await send("relayer", distAddr, distAbi, "claimMany", [users, batch.map((b) => b.amount), batch.map((b) => b.proof)]);
  console.log(`claimMany: ${users.length} claims in one transaction, gas used ${receipt.gasUsed}`);

  for (let i = 0; i < users.length; i++) {
    const bal = await pub.getBalance({ address: users[i]! });
    if (bal !== batch[i]!.amount) throw new Error(`user ${i}: balance ${bal} != entitlement ${batch[i]!.amount}`);
  }
  const totalClaimed = (await pub.readContract({ address: distAddr, abi: distAbi, functionName: "totalClaimed" })) as bigint;
  if (totalClaimed !== day1.totalEntitled) throw new Error("totalClaimed mismatch");
  console.log(`OK: every miner received exactly their entitlement; total paid ${totalClaimed} wei`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
