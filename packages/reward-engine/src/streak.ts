/**
 * Session and streak rules (docs/MINING_SPEC.md).
 *
 * - A session lasts 24 hours. A new one may start 20 hours after the previous start.
 * - A session is credited to the UTC day in which it STARTS, at most one per day.
 *   The 4-hour early-renewal window lets a daily user keep the same routine without their
 *   start time drifting past midnight and losing a day.
 * - Streak: +1 per credited day. Every 7 consecutive days earns a grace day (max 2 banked).
 *   A missed day consumes a grace day if one is banked; otherwise the streak halves.
 */

import { SECONDS_PER_DAY } from "./schedule.ts";

export const SESSION_LENGTH = 24n * 3600n;
export const RENEW_AFTER = 20n * 3600n;
export const MAX_GRACE = 2;
export const GRACE_EVERY = 7;

export interface SessionState {
  lastStart: bigint | null;
  lastCreditedDay: bigint | null;
}

export type StartCheck = { ok: true; creditedDay: bigint } | { ok: false; reason: string; nextAllowedAt: bigint };

/** Whether a session may start at `now`, and which day it would be credited to. */
export function checkSessionStart(state: SessionState, now: bigint, scheduleStart: bigint): StartCheck {
  if (now < scheduleStart) return { ok: false, reason: "mining has not started", nextAllowedAt: scheduleStart };
  if (state.lastStart !== null && now < state.lastStart + RENEW_AFTER) {
    return { ok: false, reason: "session still running", nextAllowedAt: state.lastStart + RENEW_AFTER };
  }
  const day = (now - scheduleStart) / SECONDS_PER_DAY;
  if (state.lastCreditedDay !== null && day <= state.lastCreditedDay) {
    return {
      ok: false,
      reason: "already mined this UTC day",
      nextAllowedAt: scheduleStart + (state.lastCreditedDay + 1n) * SECONDS_PER_DAY,
    };
  }
  return { ok: true, creditedDay: day };
}

export function startSession(state: SessionState, now: bigint, scheduleStart: bigint): SessionState {
  const check = checkSessionStart(state, now, scheduleStart);
  if (!check.ok) throw new Error(check.reason);
  return { lastStart: now, lastCreditedDay: check.creditedDay };
}

export interface StreakState {
  streakDays: number;
  graceBanked: number;
  consecutive: number;
}

export const NEW_STREAK: StreakState = { streakDays: 0, graceBanked: 0, consecutive: 0 };

/** Advances the streak by one UTC day. Call once per user per settled day. */
export function applyDay(state: StreakState, mined: boolean): StreakState {
  if (mined) {
    const consecutive = state.consecutive + 1;
    const earned = consecutive % GRACE_EVERY === 0 && state.graceBanked < MAX_GRACE ? 1 : 0;
    return { streakDays: state.streakDays + 1, graceBanked: state.graceBanked + earned, consecutive };
  }
  if (state.graceBanked > 0) {
    return { ...state, graceBanked: state.graceBanked - 1 };
  }
  return { streakDays: Math.floor(state.streakDays / 2), graceBanked: 0, consecutive: 0 };
}
