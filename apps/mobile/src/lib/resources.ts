/**
 * The API's answers as the screens read them: each path is fetched once, shared by every screen
 * that shows it, kept while the app is open and refreshed when a screen comes to the front.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { api } from "./core";
import { createCache, type Entry } from "./cache";
import { claimPollDelay, liveBalances, newer, openClaim, unlockOf, type Balances, type Claim, type Live, type Reading, type Unlock } from "./rewards";
import { clockOffset, steadyOffset } from "./server-clock";

// The account's balances come with two answers (mining status and rewards); the later one counts.
let reading: Reading | null = null;
// How far the server's clock is ahead of the device's, in ms, as the time in those answers shows it.
let offset: number | null = null;
const watchers = new Set<() => void>();

function setReading(next: Reading | null, clock: number | null = offset) {
  if (next === reading && clock === offset) return;
  reading = next;
  offset = clock;
  watchers.forEach((fn) => fn());
}

// A claim on its way to the wallet: when it was first seen, and the timer of the next look at it.
let following: { since: number; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * While a claim is on its way the rewards are read again every few seconds, so the balances, the claim
 * button and the activity list follow it to its end on whatever screen is open. Each answer sets the
 * next look, or ends them; a look that fails leaves the one after it standing.
 */
function follow(open: boolean): void {
  if (following) clearTimeout(following.timer);
  if (!open) {
    following = null;
    return;
  }
  const since = following?.since ?? Date.now();
  const timer = setTimeout(() => {
    follow(true);
    // A hidden tab or a backgrounded app waits; the screen reads again when it comes back.
    if (AppState.currentState === "active") void cache.load("/v1/rewards", true);
  }, claimPollDelay(Date.now() - since));
  following = { since, timer };
}

const cache = createCache((path) => api<unknown>("GET", path), {
  onData(path, data) {
    if (path === "/v1/rewards") follow(openClaim((data as { claims?: Claim[] }).claims) !== null);
    const balances = path === "/v1/rewards" ? (data as Balances) : path === "/v1/mining/status" ? (data as { balances?: Balances | null }).balances : null;
    if (!balances) return;
    const receivedAt = Date.now();
    setReading(newer(reading, { balances, receivedAt }), steadyOffset(offset, clockOffset(balances.at, receivedAt)));
  },
});

/** Starts loading what the first screens show, before any of them is on the page. */
export function prefetch(paths: readonly string[]): void {
  for (const path of paths) void cache.load(path);
}

/** Asks for `path` again, whatever is held. */
export const refresh = (path: string): Promise<void> => cache.load(path, true);

/** A claim was just asked for: reads the rewards now, and keeps reading until it has landed. */
export function followClaim(): Promise<void> {
  follow(true);
  return cache.load("/v1/rewards", true);
}

/** Forgets every answer: the account signed out. */
export function clearResources(): void {
  follow(false);
  cache.clear();
  setReading(null);
}

/**
 * The last answer for `path`. It is loaded when the screen comes to the front and when the app
 * (or its browser tab) does, unless what is held is a few seconds old.
 */
export function useResource<T>(path: string): Entry<T> & { refresh: () => Promise<void> } {
  const subscribe = useCallback((listener: () => void) => cache.subscribe(path, listener), [path]);
  const snapshot = useCallback(() => cache.get<T>(path), [path]);
  const entry = useSyncExternalStore(subscribe, snapshot, snapshot);
  useFocusEffect(useCallback(() => {
    void cache.load(path);
    const sub = AppState.addEventListener("change", (s) => s === "active" && void cache.load(path));
    return () => sub.remove();
  }, [path]));
  const again = useCallback(() => cache.load(path, true), [path]);
  return { ...entry, refresh: again };
}

const watch = (listener: () => void) => {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
};
const held = () => reading;

/**
 * The account's balances now: null until the API has answered. While a session is running the
 * figures move once a second, so this belongs in the small component that prints a number.
 */
export function useLiveBalances(): Live | null {
  const r = useSyncExternalStore(watch, held, held);
  const [now, setNow] = useState(() => Date.now());
  const live = r ? liveBalances(r, Math.max(now, r.receivedAt)) : null;
  const accruing = Boolean(live?.accruing);
  useEffect(() => {
    if (!accruing) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [r, accruing]);
  return live;
}

/**
 * When pending rewards can next be claimed: null when the API gave no time. The answer is worked out
 * again at midnight and at the moment itself, and then the rewards are read again, so the claim
 * button wakes without the screen being reopened.
 */
export function useUnlock(): Unlock | null {
  const r = useSyncExternalStore(watch, held, held);
  const [turn, setTurn] = useState(0);
  const unlock = r ? unlockOf(r.balances, Date.now() + (offset ?? 0)) : null;
  const due = unlock ? Number(r!.balances.unlock!.at) * 1000 : null;
  useEffect(() => {
    if (due === null) return;
    const now = Date.now() + (offset ?? 0);
    if (due <= now) {
      // Everyone waiting on the same settlement asks a few seconds apart.
      const id = setTimeout(() => void cache.load("/v1/rewards", true), 1500 + Math.random() * 4000);
      return () => clearTimeout(id);
    }
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const id = setTimeout(() => setTurn((n) => n + 1), Math.min(due, midnight.getTime()) - now + 50);
    return () => clearTimeout(id);
  }, [due, turn]);
  return unlock;
}

const ahead = () => offset ?? 0;

/**
 * How far the server's clock is ahead of the device's, in ms: 0 until an answer has shown it. A
 * screen adds it to the device's time before it compares that with a time the server gave.
 */
export function useClockOffset(): number {
  return useSyncExternalStore(watch, ahead, ahead);
}
