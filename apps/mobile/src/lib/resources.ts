/**
 * The API's answers as the screens read them: each path is fetched once, shared by every screen
 * that shows it, kept while the app is open and refreshed when a screen comes to the front.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { api } from "./core";
import { createCache, type Entry } from "./cache";
import { liveBalances, newer, type Balances, type Live, type Reading } from "./rewards";
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

const cache = createCache((path) => api<unknown>("GET", path), {
  onData(path, data) {
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

/** Forgets every answer: the account signed out. */
export function clearResources(): void {
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

const ahead = () => offset ?? 0;

/**
 * How far the server's clock is ahead of the device's, in ms: 0 until an answer has shown it. A
 * screen adds it to the device's time before it compares that with a time the server gave.
 */
export function useClockOffset(): number {
  return useSyncExternalStore(watch, ahead, ahead);
}
