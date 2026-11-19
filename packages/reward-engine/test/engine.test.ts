import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, keccak256, concat } from "viem";
import {
  TESTNET_LAUNCH_PARAMS,
  VERIFICATION_GATED_PARAMS,
  computeDay,
  cumulativeBudget,
  dailyBudget,
  maxRewardPerSession,
  weightOf,
  type Address,
  type MinerInput,
  type ScheduleParams,
} from "../src/index.ts";
import { buildTree, proofFor } from "../src/merkle.ts";
import { EMPTY_LEDGER, settleDay, type ChainView, type LedgerState, type SettleInput } from "../src/settle.ts";
import { NEW_STREAK, applyDay, checkSessionStart, startSession } from "../src/streak.ts";

const E18 = 10n ** 18n;
const DAY = 86_400n;
const START = 20_000n * DAY;

const FLAT: ScheduleParams = {
  startTime: START,
  initialDailyBudget: 12_000_000n * E18,
  periodDays: 30n,
  decayBps: 0n,
  totalCap: 4_000_000_000n * E18,
};
const DECAYING: ScheduleParams = {
  startTime: START,
  initialDailyBudget: 2_139_733n * E18,
  periodDays: 30n,
  decayBps: 182n,
  totalCap: 3_500_000_000n * E18,
};

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const miner = (n: number, over: Partial<MinerInput> = {}): MinerInput => ({
  account: addr(n),
  tier: 2,
  streakDays: 0,
  activeVerifiedInvites: 0,
  contributionBps: 0,
  held: false,
  ...over,
});

// ------------------------------------------------------------------ schedule

test("schedule matches the contract's known values", () => {
  assert.equal(dailyBudget(DECAYING, 29n), 2_139_733n * E18);
  assert.equal(dailyBudget(DECAYING, 30n), (2_139_733n * E18 * 9818n) / 10_000n);
  assert.equal(cumulativeBudget(FLAT, 9n), 120_000_000n * E18);
  assert.equal(cumulativeBudget(FLAT, 333n), 4_000_000_000n * E18);
});

test("cumulative budget equals the sum of daily budgets", () => {
  let sum = 0n;
  for (let d = 0n; d <= 400n; d++) {
    sum += dailyBudget(DECAYING, d);
    assert.equal(cumulativeBudget(DECAYING, d), sum);
  }
});

// ------------------------------------------------------------------- rewards

test("weight follows the formula and the launch caps", () => {
  const p = TESTNET_LAUNCH_PARAMS;
  assert.equal(weightOf(p, miner(1)), 24n * E18);
  assert.equal(weightOf(p, miner(1, { tier: 1 })), 24n * E18);
  assert.equal(weightOf(VERIFICATION_GATED_PARAMS, miner(1, { tier: 1 })), 12n * E18);
  assert.equal(weightOf(p, miner(1, { tier: 0 })), 0n);
  assert.equal(weightOf(p, miner(1, { held: true })), 0n);
  // 10-day streak = +20%, capped there.
  assert.equal(weightOf(p, miner(1, { streakDays: 10 })), (24n * E18 * 12n) / 10n);
  assert.equal(weightOf(p, miner(1, { streakDays: 50 })), (24n * E18 * 12n) / 10n);
  // Referral and contribution bonuses are zero at launch.
  assert.equal(weightOf(p, miner(1, { activeVerifiedInvites: 5, contributionBps: 1000 })), 24n * E18);
  // Highest launch reward: T3 with a full streak = 24 x 1.15 x 1.2 = 33.12.
  assert.equal(weightOf(p, miner(1, { tier: 3, streakDays: 10 })), 3312n * E18 / 100n);
});

test("max reward per session fits the distributor's per-user bound", () => {
  // Every bonus enabled later (1.15 x 1.55) and the largest boost (x2): 24 x 1.7825 x 2 = 85.56 <= 90.
  const allOn = { ...TESTNET_LAUNCH_PARAMS, referralBpsPerInvite: 500n, contributionCapBps: 1000n };
  assert.equal(maxRewardPerSession(allOn), 8556n * E18 / 100n);
  assert.ok(maxRewardPerSession(allOn) <= 90n * E18);
});

test("paid boosts multiply the weight, up to the cap, with exact rounding", () => {
  const p = TESTNET_LAUNCH_PARAMS;
  assert.equal(weightOf(p, miner(1, { boostBps: 0 })), 24n * E18);
  assert.equal(weightOf(p, miner(1, { boostBps: 2500 })), 30n * E18);
  assert.equal(weightOf(p, miner(1, { boostBps: 10_000 })), 48n * E18);
  assert.equal(weightOf(p, miner(1, { boostBps: 50_000 })), 48n * E18, "capped at +100%");
  // Stacks multiplicatively with tier and streak: 24 x 1.15 x 1.2 x 1.5 = 49.68.
  assert.equal(weightOf(p, miner(1, { tier: 3, streakDays: 10, boostBps: 5000 })), 4968n * E18 / 100n);
  // No boost for unverified or held accounts.
  assert.equal(weightOf(p, miner(1, { tier: 0, boostBps: 10_000 })), 0n);
  assert.equal(weightOf(p, miner(1, { held: true, boostBps: 10_000 })), 0n);
  assert.throws(() => weightOf(p, miner(1, { boostBps: -1 })), /boostBps/);
  assert.throws(() => weightOf(p, miner(1, { boostBps: 1.5 })), /boostBps/);
});

test("boosts share the fixed budget: they never mint more than the day's emission", () => {
  const budget = 100n * E18;
  const miners = [miner(1, { boostBps: 10_000 }), miner(2), miner(3), miner(4)];
  const r = computeDay(TESTNET_LAUNCH_PARAMS, budget, miners);
  assert.equal(r.scaled, true);
  assert.ok(r.totalReward <= budget);
  // Weights 48 : 24 : 24 : 24, so the boosted miner gets 40% of the budget and the others 20% each.
  assert.equal(r.rewards[0]!.reward, 40n * E18);
  assert.equal(r.rewards[1]!.reward, 20n * E18);
});

test("rewards run at full rate under the budget", () => {
  const r = computeDay(VERIFICATION_GATED_PARAMS, 12_000_000n * E18, [miner(1), miner(2, { tier: 1 })]);
  assert.equal(r.scaled, false);
  assert.equal(r.rewards[0]?.reward, 24n * E18);
  assert.equal(r.rewards[1]?.reward, 12n * E18);
});

test("rewards scale down pro rata over the budget and never exceed it", () => {
  const miners = Array.from({ length: 7 }, (_, i) => miner(i + 1, { streakDays: i }));
  const budget = 100n * E18;
  const r = computeDay(TESTNET_LAUNCH_PARAMS, budget, miners);
  assert.equal(r.scaled, true);
  assert.ok(r.totalReward <= budget);
  assert.ok(budget - r.totalReward < 7n); // rounding loses at most 1 wei per miner
  // Shares stay proportional to weights.
  const [a, b] = [r.rewards[0]!, r.rewards[6]!];
  assert.ok(a.reward * b.weight <= b.reward * a.weight + b.weight);
});

test("worked example: 1 million miners at weight 28.8", () => {
  // k = 12M / 28.8M; a user with weight 28.8 receives 12.
  const w = (288n * E18) / 10n;
  const k = { num: 12_000_000n * E18, den: 1_000_000n * w };
  assert.equal((w * k.num) / k.den, 12n * E18);
});

test("duplicate miners are rejected", () => {
  assert.throws(() => computeDay(TESTNET_LAUNCH_PARAMS, 1n, [miner(1), miner(1)]), /duplicate/);
});

// -------------------------------------------------------------------- streak

test("session rules: 20-hour renewal, one credit per UTC day, no drift", () => {
  let s = { lastStart: null as bigint | null, lastCreditedDay: null as bigint | null };
  s = startSession(s, START + 10n * 3600n, START); // day 0, 10:00
  assert.equal(s.lastCreditedDay, 0n);
  const early = checkSessionStart(s, START + 20n * 3600n, START);
  assert.equal(early.ok, false); // 10 hours later: still running
  // Next day at 06:00 (20 hours after the last start) is allowed and credited to day 1,
  // so a daily user can pull their routine earlier instead of drifting past midnight.
  s = startSession(s, START + DAY + 6n * 3600n, START);
  assert.equal(s.lastCreditedDay, 1n);
  // A start late on day 1 is refused: day 1 is already credited.
  const sameDay = checkSessionStart(s, START + DAY + 23n * 3600n + 59n * 60n, START + 0n);
  assert.equal(sameDay.ok, false);
});

test("streak grows, banks grace days, and halves on a miss without grace", () => {
  let st = NEW_STREAK;
  for (let i = 0; i < 7; i++) st = applyDay(st, true);
  assert.deepEqual(st, { streakDays: 7, graceBanked: 1, consecutive: 7 });
  st = applyDay(st, false); // grace absorbs the miss
  assert.deepEqual(st, { streakDays: 7, graceBanked: 0, consecutive: 7 });
  st = applyDay(st, false); // no grace left: halve
  assert.deepEqual(st, { streakDays: 3, graceBanked: 0, consecutive: 0 });
  for (let i = 0; i < 21; i++) st = applyDay(st, true);
  assert.equal(st.graceBanked, 2); // capped at two
});

// -------------------------------------------------------------------- merkle

test("leaves match the contract encoding", () => {
  const distributor = addr(0xd157);
  const tree = buildTree(31337n, distributor, [{ account: addr(1), amount: 5n }]);
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
      [31337n, distributor, addr(1), 5n],
    ),
  );
  assert.equal(tree.root, keccak256(concat([inner])));
  assert.deepEqual(proofFor(tree, addr(1)).proof, []);
});

// -------------------------------------------------------------------- settle

function chain(over: Partial<ChainView> = {}): ChainView {
  return {
    chainId: 31337n,
    distributor: addr(0xd157),
    maxRewardPerDay: 43n * E18,
    maxDailyIncrease: 24_000_000n * E18,
    referenceRoot: null,
    claimed: new Map(),
    ...over,
  };
}

function input(day: bigint, over: Partial<SettleInput> = {}): SettleInput {
  return {
    day,
    schedule: FLAT,
    params: VERIFICATION_GATED_PARAMS,
    chain: chain(),
    miners: [],
    verifiedToday: [],
    forfeit: [],
    ...over,
  };
}

test("settlement is sequential and deterministic", () => {
  assert.throws(() => settleDay(EMPTY_LEDGER, input(1n)), /expected 0/);
  const a = settleDay(EMPTY_LEDGER, input(0n, { miners: [miner(2), miner(1)] }));
  const b = settleDay(EMPTY_LEDGER, input(0n, { miners: [miner(1), miner(2)] }));
  assert.equal(a.root, b.root);
  assert.equal(a.dataHash, b.dataHash);
  assert.equal(a.totalEntitled, 48n * E18);
});

test("on testnet every checked miner earns the full rate into the entitlement", () => {
  const out = settleDay(EMPTY_LEDGER, input(0n, { params: TESTNET_LAUNCH_PARAMS, miners: [miner(1, { tier: 1 }), miner(2)] }));
  for (const a of out.ledger.accounts.values()) {
    assert.equal(a.cumulative, 24n * E18);
    assert.equal(a.pending.length, 0);
  }
  assert.equal(out.totalEntitled, 48n * E18);
});

test("T1 rewards stay pending until verification, then release oldest first", () => {
  let led: LedgerState = EMPTY_LEDGER;
  led = settleDay(led, input(0n, { miners: [miner(1, { tier: 1 })] })).ledger;
  led = settleDay(led, input(1n, { miners: [miner(1, { tier: 1 })] })).ledger;
  assert.equal(led.accounts.get(addr(1) as Address)?.cumulative ?? 0n, 0n);
  const out = settleDay(led, input(2n, { miners: [miner(1, { tier: 2 })], verifiedToday: [addr(1)] }));
  const a = [...out.ledger.accounts.values()][0]!;
  assert.equal(a.cumulative, 24n * E18 + 12n * E18 + 12n * E18);
  assert.equal(a.pending.length, 0);
  assert.equal(out.stats.backlogReleased, 24n * E18);
});

test("unverified pending rewards expire after 90 days and are never emitted", () => {
  let led: LedgerState = EMPTY_LEDGER;
  led = settleDay(led, input(0n, { miners: [miner(1, { tier: 1 })] })).ledger;
  for (let d = 1n; d < 90n; d++) led = settleDay(led, input(d)).ledger;
  const out = settleDay(led, input(90n));
  assert.equal(out.stats.expired, 12n * E18);
  assert.equal(out.root, null);
});

test("growth cap defers backlog releases instead of breaking the on-chain limit", () => {
  let led: LedgerState = EMPTY_LEDGER;
  led = settleDay(led, input(0n, { miners: [miner(1, { tier: 1 }), miner(2, { tier: 1 })] })).ledger;
  // Allow only 30 tLONG of growth per day: the 24 earned today fits; the 24 of backlog does not.
  const tight = chain({ maxDailyIncrease: 30n * E18, referenceRoot: { day: 0n, totalEntitled: 0n } });
  const out = settleDay(
    led,
    input(1n, { chain: tight, miners: [miner(1, { tier: 2 })], verifiedToday: [addr(1), addr(2)] }),
  );
  assert.equal(out.totalEntitled, 24n * E18); // backlog of 24 would exceed the 30 cap with today's 24
  assert.equal(out.stats.backlogDeferred, 24n * E18);
  const next = settleDay(
    out.ledger,
    input(2n, { chain: chain({ maxDailyIncrease: 30n * E18, referenceRoot: { day: 1n, totalEntitled: 24n * E18 } }) }),
  );
  assert.equal(next.stats.backlogReleased, 24n * E18);
  assert.equal(next.totalEntitled, 48n * E18);
});

test("forfeiture freezes the entitlement at what was claimed", () => {
  let led: LedgerState = EMPTY_LEDGER;
  led = settleDay(led, input(0n, { miners: [miner(1), miner(2)] })).ledger;
  const claimed = new Map<Address, bigint>([[addr(1), 10n * E18]]);
  const out = settleDay(
    led,
    input(1n, {
      chain: chain({ claimed, referenceRoot: { day: 0n, totalEntitled: 48n * E18 } }),
      miners: [miner(1), miner(2)],
      forfeit: [addr(1)],
    }),
  );
  const acct = out.ledger.accounts;
  const one = [...acct.entries()].find(([k]) => k.toLowerCase() === addr(1))![1];
  const two = [...acct.entries()].find(([k]) => k.toLowerCase() === addr(2))![1];
  assert.equal(one.cumulative, 10n * E18);
  assert.equal(one.frozen, true);
  assert.equal(two.cumulative, 48n * E18);
});

test("wallet rebind moves the unclaimed entitlement and keeps totals unchanged", () => {
  let led: LedgerState = EMPTY_LEDGER;
  led = settleDay(led, input(0n, { miners: [miner(1), miner(3, { tier: 1 })] })).ledger;
  const claimed = new Map<Address, bigint>([[addr(1), 5n * E18]]);
  const ref = { day: 0n, totalEntitled: 24n * E18 };
  const out = settleDay(
    led,
    input(1n, { chain: chain({ claimed, referenceRoot: ref }), rebind: [{ from: addr(1), to: addr(2) }] }),
  );
  const get = (n: number) => [...out.ledger.accounts.entries()].find(([k]) => k.toLowerCase() === addr(n))![1];
  assert.equal(get(1).cumulative, 5n * E18);
  assert.equal(get(1).frozen, true);
  assert.equal(get(2).cumulative, 19n * E18);
  assert.equal(out.totalEntitled, 24n * E18);
  // Rebinding into an address that already exists merges instead of halting settlement.
  const merged = settleDay(out.ledger, input(2n, { rebind: [{ from: addr(3), to: addr(2) }] }));
  assert.equal(merged.totalEntitled, 24n * E18);
  // A frozen account cannot be rebound; settlement continues with an alert.
  const frozen = settleDay(merged.ledger, input(3n, { rebind: [{ from: addr(1), to: addr(9) }] }));
  assert.match(frozen.stats.alerts.join(), /frozen/);
});

test("a wallet change never pays twice: rewards move only once no live root can pay the old address", async () => {
  let led: LedgerState = EMPTY_LEDGER;
  led = settleDay(led, input(0n, { miners: [miner(1)] })).ledger; // X earns 24; root 0 goes live
  const get = (l: LedgerState, n: number) => [...l.accounts.entries()].find(([k]) => k.toLowerCase() === addr(n))![1];
  // Day 1: X changes wallet. Root 0 (X = 24) is still claimable, so the 24 is held in reserve.
  const d1 = settleDay(led, input(1n, {
    chain: chain({ liveLeaves: new Map([[addr(1), 24n * E18]]), referenceRoot: { day: 0n, totalEntitled: 24n * E18 } }),
    rebind: [{ from: addr(1), to: addr(2) }],
    miners: [miner(2)],
  }));
  assert.equal(get(d1.ledger, 1).cumulative, 0n); // X's leaf drops to what it claimed
  assert.equal(get(d1.ledger, 2).cumulative, 24n * E18); // Y has only its own new reward
  assert.equal(d1.stats.reserved, 24n * E18);
  assert.equal(d1.totalEntitled, 48n * E18); // the reserve still backs the root total

  // Path A: X never claims. Once no live root pays X, the reserve moves to Y.
  const notYet = settleDay(d1.ledger, input(2n, { chain: chain({ liveLeaves: new Map([[addr(1), 24n * E18]]) }) }));
  assert.equal(get(notYet.ledger, 2).cumulative, 24n * E18);
  const released = settleDay(notYet.ledger, input(3n, { chain: chain({ liveLeaves: new Map() }) }));
  assert.equal(get(released.ledger, 2).cumulative, 48n * E18);
  assert.equal(released.stats.reserved, 0n);
  assert.equal(released.totalEntitled, 48n * E18);

  // Path B: X claims its 24 from the old root first. The reserve pays for it; Y gets nothing extra.
  const claimedOld = settleDay(d1.ledger, input(2n, { chain: chain({ claimed: new Map([[addr(1), 24n * E18]]), liveLeaves: new Map() }) }));
  assert.equal(get(claimedOld.ledger, 2).cumulative, 24n * E18);
  assert.deepEqual(claimedOld.stats.alerts, []);
  assert.equal(claimedOld.totalEntitled, 48n * E18); // 24 paid to X + 24 owed to Y: never 72
});

test("a ban drops future payouts but covers what a live root can still pay, without alerts", () => {
  let led: LedgerState = EMPTY_LEDGER;
  led = settleDay(led, input(0n, { miners: [miner(1)] })).ledger;
  const live = new Map<Address, bigint>([[addr(1), 24n * E18]]);
  const out = settleDay(led, input(1n, { chain: chain({ liveLeaves: live }), forfeit: [addr(1)], miners: [miner(1)] }));
  const a = [...out.ledger.accounts.values()][0]!;
  assert.equal(a.cumulative, 0n);
  assert.equal(a.frozen, true);
  assert.equal(out.totalEntitled, 24n * E18); // reserve covers the old root's 24
  // The banned address claims its 24 from the old root: absorbed by the reserve, no alert, no halt.
  const after = settleDay(out.ledger, input(2n, { chain: chain({ claimed: new Map([[addr(1), 24n * E18]]) }) }));
  assert.deepEqual(after.stats.alerts, []);
  assert.equal(after.totalEntitled, 24n * E18);
  // Had it not claimed, the reserve is dropped once no live root can pay it.
  const dropped = settleDay(out.ledger, input(2n, {}));
  assert.equal(dropped.totalEntitled, 0n);
});

test("chain data that contradicts the ledger is repaired with an alert, never halting settlement", () => {
  const led = settleDay(EMPTY_LEDGER, input(0n, { miners: [miner(1)] })).ledger;
  const bad = new Map<Address, bigint>([[addr(1), 25n * E18]]);
  const out = settleDay(led, input(1n, { chain: chain({ claimed: bad }) }));
  assert.match(out.stats.alerts.join(), /above ledger entitlement/);
  assert.equal([...out.ledger.accounts.values()][0]!.cumulative, 25n * E18);
});

test("a day where everything is held in reserve still produces a root, so the old leaf retires", () => {
  let led: LedgerState = EMPTY_LEDGER;
  led = settleDay(led, input(0n, { miners: [miner(1)] })).ledger;
  const out = settleDay(led, input(1n, {
    chain: chain({ liveLeaves: new Map([[addr(1), 24n * E18]]) }),
    rebind: [{ from: addr(1), to: addr(2) }],
  }));
  assert.notEqual(out.root, null);
  assert.equal(out.stats.leaves, 1); // the old address, at zero
  assert.equal(out.totalEntitled, 24n * E18);
});
