/**
 * Daily settlement: turns one closed UTC day of mining activity into the next Merkle root.
 *
 * Ledger rules (docs/MINING_SPEC.md):
 * - Miners at or above params.entitledFromTier add the day's reward to their on-chain cumulative
 *   entitlement.
 * - Miners below it earn into a pending list that stays off-chain. When the account reaches the
 *   tier, the backlog is released into its entitlement, oldest first, within two limits the
 *   contract also enforces: the cumulative budget to date, and the per-day growth cap.
 *   Pending rewards of accounts that never reach it expire after 90 days and are never emitted.
 * - Forfeiture freezes an account's entitlement at what it already claimed. Nothing paid is
 *   clawed back, and a frozen account earns nothing more.
 * - Settlement is deterministic: the same inputs always give the same root and data hash.
 */

import { getAddress } from "viem";
import { computeDay, type Address, type MinerInput, type RewardParams } from "./rewards.ts";
import { cumulativeBudget, dailyBudget, type ScheduleParams } from "./schedule.ts";
import { buildTree, canonicalJson, hashJson, LEAF_ENCODING, type RewardTree } from "./merkle.ts";

export const DEFAULT_PENDING_EXPIRY_DAYS = 90n;
export const DATA_FORMAT = "longyu-mining-root/1";

export interface PendingReward {
  day: bigint;
  amount: bigint;
}

/**
 * Rewards held back from a frozen address: they still count toward each root's total but sit in
 * no leaf. They move to `to` (a new wallet) or are dropped (a ban) once no live root can pay the
 * frozen address more than it has claimed.
 */
export interface Reserve {
  to: Address | null;
  amount: bigint;
}

export interface AccountState {
  cumulative: bigint;
  claimed: bigint;
  pending: PendingReward[];
  verified: boolean;
  frozen: boolean;
  reserve?: Reserve;
}

export interface LedgerState {
  lastSettledDay: bigint | null;
  accounts: Map<Address, AccountState>;
}

export const EMPTY_LEDGER: LedgerState = { lastSettledDay: null, accounts: new Map() };

export interface ChainView {
  chainId: bigint;
  distributor: Address;
  maxRewardPerDay: bigint;
  maxDailyIncrease: bigint;
  /** The latest root posted on-chain, active or still waiting; null before the first root. */
  referenceRoot: { day: bigint; totalEntitled: bigint } | null;
  /** Amount claimed so far per account, from the indexer. */
  claimed: ReadonlyMap<Address, bigint>;
  /**
   * Each account's highest leaf in any root that is claimable now or could become claimable
   * (the active root and the waiting root). An address can always still claim up to this amount
   * on-chain, so a freeze must never go below it.
   */
  liveLeaves?: ReadonlyMap<Address, bigint>;
}

export interface SettleInput {
  day: bigint;
  schedule: ScheduleParams;
  params: RewardParams;
  chain: ChainView;
  /** Users whose session was credited to `day`, with their tier and bonuses. */
  miners: readonly MinerInput[];
  /** Accounts that reached T2 or above during `day`. */
  verifiedToday: readonly Address[];
  /** Accounts confirmed as abusive during `day`. */
  forfeit: readonly Address[];
  /**
   * Wallet changes approved during `day`. The old address is frozen at what it can still claim
   * on-chain (its claims or its live leaf, whichever is higher); everything above that, plus its
   * pending rewards and verified status, moves to the new address. Totals do not change.
   */
  rebind?: readonly { from: Address; to: Address }[];
  pendingExpiryDays?: bigint;
}

export interface SettleStats {
  miners: number;
  budget: bigint;
  totalWeight: bigint;
  scaled: boolean;
  dayReward: bigint;
  toEntitlement: bigint;
  toPending: bigint;
  backlogReleased: bigint;
  backlogDeferred: bigint;
  expired: bigint;
  /** Rewards held back from frozen addresses, included in the root total but in no leaf. */
  reserved: bigint;
  forfeitedAccounts: number;
  leaves: number;
  /** Inconsistencies that were repaired instead of halting settlement; each needs a look. */
  alerts: string[];
}

export interface SettleOutput {
  ledger: LedgerState;
  day: bigint;
  /** Null when nobody has an entitlement yet, so there is nothing to post. */
  root: `0x${string}` | null;
  totalEntitled: bigint;
  dataJson: string;
  dataHash: `0x${string}`;
  tree: RewardTree | null;
  stats: SettleStats;
}

function cloneAccount(a: AccountState): AccountState {
  return { ...a, pending: a.pending.map((p) => ({ ...p })), reserve: a.reserve ? { ...a.reserve } : undefined };
}

function account(accounts: Map<Address, AccountState>, addr: Address): AccountState {
  const key = getAddress(addr);
  let a = accounts.get(key);
  if (!a) {
    a = { cumulative: 0n, claimed: 0n, pending: [], verified: false, frozen: false };
    accounts.set(key, a);
  }
  return a;
}

export function settleDay(prev: LedgerState, input: SettleInput): SettleOutput {
  const { day, schedule, params, chain } = input;
  const expiry = input.pendingExpiryDays ?? DEFAULT_PENDING_EXPIRY_DAYS;
  const expected = prev.lastSettledDay === null ? 0n : prev.lastSettledDay + 1n;
  if (day !== expected) throw new Error(`settle day ${day}, expected ${expected}`);

  const accounts = new Map<Address, AccountState>();
  for (const [k, v] of prev.accounts) accounts.set(k, cloneAccount(v));

  // Nothing a user can do may halt settlement for everyone: inconsistencies are repaired
  // conservatively and reported as alerts.
  const alerts: string[] = [];
  const live = new Map<string, bigint>();
  for (const [addr, amount] of chain.liveLeaves ?? []) live.set(getAddress(addr), amount);

  /**
   * Freezing lowers the address's leaf to what it has claimed and moves the rest into a reserve.
   * The reserve still counts toward the root total, so claims an older root still allows are
   * covered, and it is released only once no live root can pay this address more (step 2c).
   * Result: no reward is paid twice, and nothing is stranded when the old wallet is lost.
   */
  const freeze = (a: AccountState, to: Address | null) => {
    a.reserve = { to, amount: a.cumulative - a.claimed };
    a.cumulative = a.claimed;
    a.pending = [];
    a.frozen = true;
  };

  // 1. Sync claims from the chain. Claims only grow.
  for (const [addr, claimed] of chain.claimed) {
    const key = getAddress(addr);
    const a = account(accounts, key);
    if (claimed < a.claimed) {
      alerts.push(`${key}: indexer claimed ${claimed} below ledger ${a.claimed}`);
      continue;
    }
    if (claimed > a.cumulative) {
      const extra = claimed - a.cumulative;
      if (a.reserve && extra <= a.reserve.amount) {
        // Paid by an older root after the freeze: it comes out of the reserve.
        a.reserve.amount -= extra;
      } else {
        alerts.push(`${key}: claimed ${claimed} above ledger entitlement ${a.cumulative}`);
        if (a.reserve) a.reserve.amount = 0n;
      }
      a.cumulative = claimed;
    }
    a.claimed = claimed;
  }

  // 2. Wallet changes: freeze the old address; its rewards follow once it is safe.
  for (const { from, to } of input.rebind ?? []) {
    const fromKey = getAddress(from);
    const toKey = getAddress(to);
    if (fromKey === toKey) {
      alerts.push(`${fromKey}: rebind to the same address ignored`);
      continue;
    }
    const a = account(accounts, fromKey);
    if (a.frozen) {
      alerts.push(`${fromKey}: rebind from a frozen account ignored`);
      continue;
    }
    if (accounts.get(toKey)?.frozen) {
      alerts.push(`${toKey}: rebind into a frozen account ignored`);
      continue;
    }
    const merging = accounts.has(toKey);
    const pending = a.pending;
    const verified = a.verified;
    freeze(a, toKey);
    const b = account(accounts, toKey);
    if (!merging) {
      // Pending rewards are off-chain, so they can move at once with the verification status.
      b.pending = pending;
      b.verified = verified;
    } else if (verified === b.verified) {
      b.pending = [...b.pending, ...pending];
    } else if (pending.length > 0) {
      alerts.push(`${fromKey}: pending rewards not merged into ${toKey} (verification differs)`);
    }
  }

  // 2b. Forfeitures: freeze; the reserve is dropped once no live root can pay it.
  for (const addr of input.forfeit) {
    const a = account(accounts, getAddress(addr));
    if (!a.frozen) freeze(a, null);
  }

  // 2c. Release reserves of addresses that no live root can pay beyond what they claimed.
  for (const [key, a] of accounts) {
    const r = a.reserve;
    if (!r) continue;
    if ((live.get(key) ?? 0n) > a.claimed) continue; // an older root could still pay this address
    delete a.reserve;
    if (r.amount === 0n || r.to === null) continue;
    let target = accounts.get(r.to);
    for (let hops = 0; target?.frozen && target.reserve?.to && hops < 10; hops++) target = accounts.get(target.reserve.to);
    if (!target) {
      alerts.push(`${key}: reserve target ${r.to} missing; ${r.amount} dropped`);
    } else if (target.frozen) {
      if (target.reserve) target.reserve.amount += r.amount;
      else alerts.push(`${key}: reserve target frozen; ${r.amount} dropped`);
    } else {
      target.cumulative += r.amount;
    }
  }

  // 3. Newly verified accounts become eligible to release their backlog.
  for (const addr of input.verifiedToday) {
    const a = account(accounts, addr);
    if (!a.frozen) a.verified = true;
  }

  // 4. The day's rewards. Frozen accounts earn nothing.
  const miners = input.miners.map((m) => {
    const a = account(accounts, m.account);
    if (m.tier >= params.entitledFromTier && !a.frozen) a.verified = true;
    return a.frozen ? { ...m, tier: 0 as const } : m;
  });
  const result = computeDay(params, dailyBudget(schedule, day), miners);
  let toEntitlement = 0n;
  let toPending = 0n;
  for (const r of result.rewards) {
    if (r.reward === 0n) continue;
    const a = account(accounts, r.account);
    if (r.tier >= params.entitledFromTier) {
      a.cumulative += r.reward;
      toEntitlement += r.reward;
    } else {
      a.pending.push({ day, amount: r.reward });
      toPending += r.reward;
    }
  }

  // 5. Expire old pending rewards of accounts that never verified.
  let expired = 0n;
  for (const a of accounts.values()) {
    if (a.verified) continue;
    const keep = a.pending.filter((p) => day - p.day < expiry);
    for (const p of a.pending) if (day - p.day >= expiry) expired += p.amount;
    a.pending = keep;
  }

  // 6. Release backlogs of verified accounts, oldest first, within both on-chain limits.
  const budgetToDate = cumulativeBudget(schedule, day);
  const ref = chain.referenceRoot;
  const elapsed = ref === null ? day + 1n : day - ref.day;
  if (ref !== null && elapsed <= 0n) throw new Error("reference root is not older than the settled day");
  const growthLimit = (ref?.totalEntitled ?? 0n) + chain.maxDailyIncrease * elapsed;
  const allowedTotal = budgetToDate < growthLimit ? budgetToDate : growthLimit;
  // The root's total covers every leaf plus every reserve still held back.
  let total = 0n;
  let reserved = 0n;
  for (const a of accounts.values()) {
    total += a.cumulative;
    if (a.reserve) reserved += a.reserve.amount;
  }
  total += reserved;
  if (total > allowedTotal) {
    throw new Error(`entitlement ${total} exceeds the allowed total ${allowedTotal}; check maxDailyIncrease`);
  }
  const backlog: { addr: Address; a: AccountState; p: PendingReward }[] = [];
  for (const [addr, a] of accounts) {
    if (a.verified && !a.frozen) for (const p of a.pending) backlog.push({ addr, a, p });
  }
  backlog.sort((x, y) => (x.p.day !== y.p.day ? (x.p.day < y.p.day ? -1 : 1) : x.addr < y.addr ? -1 : 1));
  let backlogReleased = 0n;
  let blocked = false;
  const released = new Set<PendingReward>();
  for (const { a, p } of backlog) {
    if (blocked || total + p.amount > allowedTotal) {
      blocked = true; // strict first-in, first-out: nothing jumps the queue
      continue;
    }
    a.cumulative += p.amount;
    total += p.amount;
    backlogReleased += p.amount;
    released.add(p);
  }
  let backlogDeferred = 0n;
  for (const a of accounts.values()) {
    a.pending = a.pending.filter((p) => !released.has(p));
    if (a.verified) for (const p of a.pending) backlogDeferred += p.amount;
  }

  // 7. Safety checks that mirror the contract.
  const userBound = chain.maxRewardPerDay * (day + 1n);
  let totalClaimed = 0n;
  for (const [addr, a] of accounts) {
    if (a.cumulative > userBound) throw new Error(`${addr} entitlement ${a.cumulative} above per-user bound`);
    if (a.cumulative < a.claimed) throw new Error(`${addr} entitlement below claimed`);
    totalClaimed += a.claimed;
  }
  if (total > budgetToDate) throw new Error("invariant: total above cumulative budget");
  if (total < totalClaimed) throw new Error("invariant: total below total claimed");

  // 8. Root and published data.
  const entries = [...accounts.entries()]
    // Frozen addresses holding a reserve keep a leaf (even at zero) so a new root is always posted
    // that retires their old, higher leaf; otherwise the reserve could never be released.
    .filter(([, a]) => a.cumulative > 0n || a.reserve !== undefined)
    .sort(([x], [y]) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1))
    .map(([addr, a]) => ({ account: addr, amount: a.cumulative }));
  const tree = entries.length > 0 ? buildTree(chain.chainId, chain.distributor, entries) : null;
  const root = tree ? (tree.root as `0x${string}`) : null;

  const stats: SettleStats = {
    miners: input.miners.length,
    budget: result.budget,
    totalWeight: result.totalWeight,
    scaled: result.scaled,
    dayReward: result.totalReward,
    toEntitlement,
    toPending,
    backlogReleased,
    backlogDeferred,
    expired,
    reserved,
    forfeitedAccounts: input.forfeit.length,
    leaves: entries.length,
    alerts,
  };
  const dataJson = canonicalJson({
    format: DATA_FORMAT,
    chainId: chain.chainId,
    distributor: getAddress(chain.distributor),
    day,
    root,
    totalEntitled: total,
    leafEncoding: LEAF_ENCODING,
    entries: entries.map((e) => ({ account: e.account, cumulative: e.amount })),
    stats,
  });

  return {
    ledger: { lastSettledDay: day, accounts },
    day,
    root,
    totalEntitled: total,
    dataJson,
    dataHash: hashJson(dataJson),
    tree,
    stats,
  };
}
