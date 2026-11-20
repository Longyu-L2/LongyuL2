/**
 * Writes contracts/test/fixtures/engine-root.json: three settled days produced by this engine.
 * contracts/test/EngineParity.t.sol posts that root to the real MiningDistributor and claims
 * every leaf, proving the engine and the contract agree on leaves, proofs and totals.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERIFICATION_GATED_PARAMS, type Address, type MinerInput, type ScheduleParams } from "../src/index.ts";
import { proofFor } from "../src/merkle.ts";
import { EMPTY_LEDGER, settleDay, type ChainView } from "../src/settle.ts";

const E18 = 10n ** 18n;
const schedule: ScheduleParams = {
  startTime: 20_000n * 86_400n,
  initialDailyBudget: 100n * E18, // small budget so day 1 is scaled pro rata
  periodDays: 30n,
  decayBps: 0n,
  totalCap: 4_000_000_000n * E18,
};
const distributor = "0x000000000000000000000000000000000000D157" as Address;
const addr = (n: number): Address => `0x${(0xa000 + n).toString(16).padStart(40, "0")}` as Address;
const m = (n: number, tier: 0 | 1 | 2 | 3, streakDays = 0): MinerInput => ({
  account: addr(n), tier, streakDays, activeInvites: 0, contributionBps: 0, held: false,
});
const chain = (ref: ChainView["referenceRoot"]): ChainView => ({
  chainId: 31337n,
  distributor,
  maxRewardPerDay: 43n * E18,
  maxDailyIncrease: 200n * E18,
  referenceRoot: ref,
  claimed: new Map(),
});
const base = { schedule, params: VERIFICATION_GATED_PARAMS, verifiedToday: [] as Address[], forfeit: [] as Address[] };

const d0 = settleDay(EMPTY_LEDGER, { ...base, day: 0n, chain: chain(null), miners: [m(1, 2), m(2, 3, 5), m(3, 1)] });
const d1 = settleDay(d0.ledger, {
  ...base, day: 1n, chain: chain({ day: 0n, totalEntitled: d0.totalEntitled }),
  miners: [m(1, 2, 1), m(2, 3, 6), m(3, 1, 1), m(4, 2), m(5, 2)],
});
const d2 = settleDay(d1.ledger, {
  ...base, day: 2n, chain: chain({ day: 1n, totalEntitled: d1.totalEntitled }),
  miners: [m(1, 2, 2), m(3, 2, 2), m(5, 3)], verifiedToday: [addr(3)],
});
if (!d2.tree || !d2.root) throw new Error("no root");

const accounts: string[] = [];
const amounts: string[] = [];
const proofFlat: string[] = [];
const proofLens: number[] = [];
for (const [a, st] of d2.ledger.accounts) {
  if (st.cumulative === 0n) continue;
  const { amount, proof } = proofFor(d2.tree, a);
  accounts.push(a);
  amounts.push(amount.toString());
  proofLens.push(proof.length);
  proofFlat.push(...proof);
}
const fixture = {
  chainId: 31337,
  distributor,
  scheduleStart: schedule.startTime.toString(),
  dailyBudget: schedule.initialDailyBudget.toString(),
  day: 2,
  root: d2.root,
  dataHash: d2.dataHash,
  totalEntitled: d2.totalEntitled.toString(),
  day1Scaled: d1.stats.scaled,
  accounts,
  amounts,
  proofFlat,
  proofLens,
};
const out = fileURLToPath(new URL("../../../contracts/test/fixtures/engine-root.json", import.meta.url));
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${out}: ${accounts.length} leaves, total ${d2.totalEntitled}, day 1 scaled: ${d1.stats.scaled}`);
