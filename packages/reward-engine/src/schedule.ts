/**
 * Exact BigInt replica of contracts/src/EmissionSchedule.sol.
 * Any change here must be mirrored in the contract, and the parity tests must pass.
 */

export const BPS = 10_000n;
export const MAX_PERIODS = 2_000n;
export const SECONDS_PER_DAY = 86_400n;

export interface ScheduleParams {
  /** Unix time of UTC midnight that starts day 0. */
  startTime: bigint;
  initialDailyBudget: bigint;
  periodDays: bigint;
  decayBps: bigint;
  totalCap: bigint;
}

export function validateSchedule(p: ScheduleParams): void {
  if (
    p.startTime % SECONDS_PER_DAY !== 0n ||
    p.initialDailyBudget === 0n ||
    p.periodDays === 0n ||
    p.periodDays > 3650n ||
    p.decayBps >= BPS ||
    p.totalCap === 0n
  ) {
    throw new Error("invalid schedule parameters");
  }
}

/** Day index for a unix timestamp. Throws before the start. */
export function dayOf(p: ScheduleParams, timestamp: bigint): bigint {
  if (timestamp < p.startTime) throw new Error("before schedule start");
  return (timestamp - p.startTime) / SECONDS_PER_DAY;
}

export function dailyBudget(p: ScheduleParams, day: bigint): bigint {
  let budget = p.initialDailyBudget;
  if (p.decayBps === 0n) return budget;
  let periods = day / p.periodDays;
  if (periods > MAX_PERIODS) periods = MAX_PERIODS;
  const keep = BPS - p.decayBps;
  for (let i = 0n; i < periods && budget !== 0n; i++) {
    budget = (budget * keep) / BPS;
  }
  return budget;
}

export function cumulativeBudget(p: ScheduleParams, day: bigint): bigint {
  const cap = p.totalCap;
  const numDays = day + 1n;
  let budget = p.initialDailyBudget;
  if (p.decayBps === 0n) {
    if (numDays > cap / budget) return cap;
    const sum = budget * numDays;
    return sum > cap ? cap : sum;
  }
  const full = numDays / p.periodDays;
  const rem = numDays % p.periodDays;
  const keep = BPS - p.decayBps;
  const loops = full < MAX_PERIODS ? full : MAX_PERIODS;
  let sum = 0n;
  for (let i = 0n; i < loops; i++) {
    sum += budget * p.periodDays;
    if (sum >= cap) return cap;
    budget = (budget * keep) / BPS;
  }
  if (full > MAX_PERIODS) {
    const extraDays = (full - MAX_PERIODS) * p.periodDays;
    if (budget !== 0n && extraDays > (cap - sum) / budget) return cap;
    sum += extraDays * budget;
  }
  sum += rem * budget;
  return sum > cap ? cap : sum;
}
