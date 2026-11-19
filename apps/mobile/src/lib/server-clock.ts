/**
 * The server's clock, as the device can tell it. A session ends, and the next may start, at the
 * server's times, and a device's own clock can be minutes off. So the Mine screen reads the time
 * through the offset that the API's answers show. No native imports, so the unit tests run it.
 */

/** A drop in the estimate larger than this means the device's clock was set, not that an answer was slow. */
const RESET_MS = 5000;

/** How long after an answer that came too early the status is asked for again, and how many times in a row. */
export const RECHECK_MS = 10_000;
export const RECHECKS = 6;

/**
 * How far the server's clock is ahead of the device's, in ms (negative when it is behind), from an
 * answer the server timed at `at` (its seconds) and the device received at `receivedAt` (its ms).
 * Null when the answer carries no time. The estimate is short by the time the answer travelled and
 * by the cut to whole seconds, and never over.
 */
export function clockOffset(at: string | undefined, receivedAt: number): number | null {
  return at !== undefined && /^\d+$/.test(at) ? Number(at) * 1000 - receivedAt : null;
}

/**
 * The estimate to go on with when an answer brings a new one. Each is short of the truth, so the
 * larger is the nearer, and keeping it means the time read through it never steps back because one
 * answer was slow. A much smaller one replaces it: the device's clock has been moved.
 */
export function steadyOffset(held: number | null, next: number | null): number | null {
  if (next === null || held === null) return next ?? held;
  return next > held || held - next > RESET_MS ? next : held;
}

/** What the mining status says about time. */
export interface SessionTimes {
  session: { endsAt: string } | null;
  canStart: boolean;
  nextAllowedAt: string | null;
}

/**
 * When to ask for the mining status again: in `wait` ms, or not at all (null). It changes when the
 * session ends and when the next may start, so it is asked for a second after whichever comes
 * first on the server's clock (`serverNowMs`).
 *
 * `overdue` is an answer that still refuses a start whose time has passed: the clocks are further
 * apart than the offset tells. The status is then asked for again every ten seconds, and after
 * `RECHECKS` such tries in a row (`rechecked`) no more, until something else brings an answer.
 */
export function nextCheck(status: SessionTimes, serverNowMs: number, rechecked: number): { wait: number | null; overdue: boolean } {
  const left = (at: string | null | undefined) => (at ? Number(at) * 1000 - serverNowMs : NaN);
  const opens = status.canStart ? NaN : left(status.nextAllowedAt);
  const waits = [left(status.session?.endsAt), opens].filter((ms) => ms > 0).map((ms) => ms + 1000);
  const overdue = opens <= 0;
  if (overdue && rechecked < RECHECKS) waits.push(RECHECK_MS);
  return { wait: waits.length ? Math.min(...waits) : null, overdue };
}
