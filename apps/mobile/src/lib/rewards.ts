/**
 * What an account has mined, and how the figures move between two answers from the API.
 * (No React Native imports, so this runs under plain Node tests.)
 *
 * The API counts a running session into `pending` up to the moment it answered (`at`), and says
 * how fast the session adds to it (`accrual`). From there the device counts on by itself, so the
 * Mine and Wallet screens show the same amount and neither has to poll for it.
 */

export interface Balances {
  /** Everything mined so far: claimed, claimable and pending together. */
  earned: string;
  claimed: string;
  /** In a published settlement, ready to claim. */
  claimable: string;
  /** Mined but not claimable yet: the running session and the days waiting for settlement. */
  pending: string;
  /** Set while a session is running: what it adds per hour, and the second it stops. */
  accrual?: { perHour: string; until: string } | null;
  /**
   * When pending rewards can next be claimed, in the server's seconds: to the second for a settlement
   * that is posted, and the scheduled time for a day not settled yet. Null when no time is known.
   */
  unlock?: { at: string; exact: boolean } | null;
  /** The server's clock when the figures were read, in seconds. */
  at?: string;
}

/** One answer from the API, and the device's clock (ms) when it arrived. */
export interface Reading {
  balances: Balances;
  receivedAt: number;
  /** What the reading before this one already showed as pending for the same session: not shown below it. */
  floor?: bigint;
}

export interface Live {
  earned: bigint;
  claimed: bigint;
  claimable: bigint;
  pending: bigint;
  /** A session is still adding to `pending`. */
  accruing: boolean;
}

const big = (v: string | undefined): bigint => (v && /^\d+$/.test(v) ? BigInt(v) : 0n);

/** The figures at `nowMs` on the device's clock. */
export function liveBalances(reading: Reading, nowMs: number): Live {
  const b = reading.balances;
  const claimed = big(b.claimed);
  const claimable = big(b.claimable);
  let pending = big(b.pending);
  let accruing = false;
  if (b.accrual && b.at !== undefined) {
    // Only the time since the answer is counted, so a wrong clock on the device cannot move the total.
    const left = Math.max(0, (Number(b.accrual.until) - Number(b.at)) * 1000);
    const since = Math.max(0, nowMs - reading.receivedAt);
    if (Number.isFinite(left) && Number.isFinite(since)) {
      pending += (big(b.accrual.perHour) * BigInt(Math.floor(Math.min(since, left)))) / 3_600_000n;
      accruing = since < left;
    }
  }
  if (reading.floor !== undefined && pending < reading.floor) pending = reading.floor;
  return { earned: claimed + claimable + pending, claimed, claimable, pending, accruing };
}

/** The same session is still counting, and nothing was settled or claimed between the two answers. */
const sameSession = (a: Balances, b: Balances): boolean =>
  Boolean(a.accrual && b.accrual) && a.accrual!.until === b.accrual!.until && a.claimed === b.claimed && a.claimable === b.claimable;

/**
 * Of two readings, the one the server made later; an older answer that arrives late is dropped.
 *
 * The device may have counted a moment ahead of the answer that takes over: the API reads its clock
 * in whole seconds, and answers do not all take as long to arrive. While the same session runs, the
 * figure then waits where it is until the session catches up, and does not step back. A change the
 * API made (a settlement, a claim, the session ending) shows as the API has it, down as well as up.
 */
export function newer(held: Reading | null, next: Reading): Reading {
  if (!held) return next;
  if (Number(next.balances.at ?? 0) < Number(held.balances.at ?? 0)) return held;
  if (!sameSession(held.balances, next.balances)) return next;
  const shown = liveBalances(held, next.receivedAt).pending;
  return liveBalances(next, next.receivedAt).pending < shown ? { ...next, floor: shown } : next;
}

/** When pending rewards can next be claimed, as the wallet words it. */
export interface Unlock {
  /**
   * The day it falls on by the device's calendar. "due": the moment has come, and the balances the
   * device holds are from before it.
   */
  day: "today" | "tomorrow" | "later" | "due";
  /** The moment, at the full minute: never before the rewards can be claimed. */
  at: Date;
  /** False for the scheduled time of a day that is not settled yet. */
  exact: boolean;
}

/** No settlement waits longer than this, so a time further away is not one to show. */
const UNLOCK_HORIZON_MS = 10 * 86_400_000;

/** The unlock time of `b` at `serverNowMs` on the server's clock, or null when the API gave none. */
export function unlockOf(b: Balances, serverNowMs: number): Unlock | null {
  const u = b.unlock;
  if (!u || typeof u.at !== "string" || !/^\d{1,12}$/.test(u.at)) return null;
  const ms = Number(u.at) * 1000;
  if (ms - serverNowMs > UNLOCK_HORIZON_MS) return null;
  const at = new Date(Math.ceil(ms / 60_000) * 60_000);
  const exact = u.exact === true;
  if (ms <= serverNowMs) return { day: "due", at, exact };
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // Rounded: a day with a clock change is an hour longer or shorter.
  const days = Math.round((midnight(at) - midnight(new Date(serverNowMs))) / 86_400_000);
  return { day: days <= 0 ? "today" : days === 1 ? "tomorrow" : "later", at, exact };
}

/** The parts of everything mined, each from 0 to 1, for the bar under the total. */
export function shares(live: Pick<Live, "earned" | "claimed" | "claimable" | "pending">): { claimed: number; claimable: number; pending: number } {
  if (live.earned <= 0n) return { claimed: 0, claimable: 0, pending: 0 };
  const part = (v: bigint) => Number((v * 10_000n) / live.earned) / 10_000;
  return { claimed: part(live.claimed), claimable: part(live.claimable), pending: part(live.pending) };
}
