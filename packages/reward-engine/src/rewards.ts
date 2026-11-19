/**
 * Daily reward formula (docs/MINING_SPEC.md):
 *
 *   w_i = b * tau_i * (1 + s_i + n_i + c_i) * (1 + p_i)
 *   k   = min(1, E / sum(w))
 *
 * p_i is a paid mining boost (0 without one, capped by params). It raises a miner's share of the
 * fixed daily budget E; it never raises E, so boosts cannot create tokens.
 *   r_i = floor(k * w_i)
 *
 * All multipliers are integers in basis points so results are exact and reproducible.
 * Rounding is always down, so the day's rewards can never exceed the budget E.
 */

import { BPS } from "./schedule.ts";

export type Tier = 0 | 1 | 2 | 3;
export type Address = `0x${string}`;

export interface RewardParams {
  /** b: reward for one completed session, in wei. */
  baseReward: bigint;
  /** tau per tier T0..T3, in bps. */
  tierBps: readonly [bigint, bigint, bigint, bigint];
  /**
   * The lowest tier whose rewards go straight into the on-chain entitlement. Tiers below it earn
   * into the off-chain pending list until the account reaches it.
   */
  entitledFromTier: Tier;
  streakBpsPerDay: bigint;
  streakCapBps: bigint;
  /** 0 at launch: Apple rule 3.1.5(v) forbids token rewards for invites. */
  referralBpsPerInvite: bigint;
  referralCapBps: bigint;
  /** 0 at launch for the same reason; up to 1000 if enabled later. */
  contributionCapBps: bigint;
  /** Largest paid boost honoured, in bps (10000 = +100%). */
  boostCapBps: bigint;
}

/**
 * Launch parameters for LONGYU Testnet. Every miner who passed the device check earns the full rate
 * into their entitlement; identity verification is asked for before mainnet conversion instead.
 */
export const TESTNET_LAUNCH_PARAMS: RewardParams = {
  baseReward: 24n * 10n ** 18n,
  tierBps: [0n, 10_000n, 10_000n, 11_500n],
  entitledFromTier: 1,
  streakBpsPerDay: 200n,
  streakCapBps: 2_000n,
  referralBpsPerInvite: 0n,
  referralCapBps: 2_500n,
  contributionCapBps: 0n,
  boostCapBps: 10_000n,
};

/**
 * The same rewards gated on identity verification: an unverified miner earns half, off-chain, and
 * the backlog is released when the account verifies.
 */
export const VERIFICATION_GATED_PARAMS: RewardParams = {
  ...TESTNET_LAUNCH_PARAMS,
  tierBps: [0n, 5_000n, 10_000n, 11_500n],
  entitledFromTier: 2,
};

export interface MinerInput {
  account: Address;
  tier: Tier;
  /** Consecutive mining days before today, from the streak tracker. */
  streakDays: number;
  /** Direct invites that are T2+ and mined at least 5 of the last 7 days. */
  activeVerifiedInvites: number;
  /** Earned contribution bonus for the day, in bps (capped by params). */
  contributionBps: number;
  /** Held for review: earns nothing today. */
  held: boolean;
  /** Paid boost active on this day, in bps (2500 = +25%); 0 or absent without one. */
  boostBps?: number;
}

export interface MinerReward {
  account: Address;
  tier: Tier;
  weight: bigint;
  reward: bigint;
}

export interface DayResult {
  rewards: MinerReward[];
  budget: bigint;
  totalWeight: bigint;
  totalReward: bigint;
  /** True when demand exceeded the budget and rewards were scaled by k = budget / totalWeight. */
  scaled: boolean;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function assertNonNegativeInt(n: number, name: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
}

/** The most one session can earn (top tier, every bonus and boost at its cap). Sizes maxRewardPerDay. */
export function maxRewardPerSession(p: RewardParams): bigint {
  const topTier = p.tierBps.reduce((a, b) => (a > b ? a : b));
  return (p.baseReward * topTier * (BPS + p.streakCapBps + p.referralCapBps + p.contributionCapBps) * (BPS + p.boostCapBps)) / (BPS * BPS * BPS);
}

export function weightOf(p: RewardParams, m: MinerInput): bigint {
  assertNonNegativeInt(m.streakDays, "streakDays");
  assertNonNegativeInt(m.activeVerifiedInvites, "activeVerifiedInvites");
  assertNonNegativeInt(m.contributionBps, "contributionBps");
  assertNonNegativeInt(m.boostBps ?? 0, "boostBps");
  if (m.held) return 0n;
  const tier = p.tierBps[m.tier];
  if (tier === undefined) throw new Error(`unknown tier ${m.tier}`);
  if (tier === 0n) return 0n;
  const s = min(BigInt(m.streakDays) * p.streakBpsPerDay, p.streakCapBps);
  const n = min(BigInt(m.activeVerifiedInvites) * p.referralBpsPerInvite, p.referralCapBps);
  const c = min(BigInt(m.contributionBps), p.contributionCapBps);
  const boost = min(BigInt(m.boostBps ?? 0), p.boostCapBps);
  // One division at the end, so rounding never compounds.
  return (p.baseReward * tier * (BPS + s + n + c) * (BPS + boost)) / (BPS * BPS * BPS);
}

/** Computes every miner's reward for one day against that day's budget. */
export function computeDay(p: RewardParams, budget: bigint, miners: readonly MinerInput[]): DayResult {
  const seen = new Set<string>();
  const weighted = miners.map((m) => {
    const key = m.account.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate miner ${m.account}`);
    seen.add(key);
    return { m, w: weightOf(p, m) };
  });
  const totalWeight = weighted.reduce((s, x) => s + x.w, 0n);
  const scaled = totalWeight > budget;
  const rewards = weighted.map(({ m, w }) => ({
    account: m.account,
    tier: m.tier,
    weight: w,
    reward: scaled ? (w * budget) / totalWeight : w,
  }));
  const totalReward = rewards.reduce((s, r) => s + r.reward, 0n);
  if (totalReward > budget) throw new Error("invariant: rewards exceed budget");
  return { rewards, budget, totalWeight, totalReward, scaled };
}
