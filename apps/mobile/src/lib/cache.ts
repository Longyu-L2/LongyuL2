/**
 * What the API last said, kept by path, so a screen opens with the figures it had and refreshes
 * them behind what is already on the page. (No React Native imports, so this runs under plain
 * Node tests; resources.ts binds it to the API and to React.)
 */

export interface Entry<T = unknown> {
  /** The last answer; undefined until there is one. */
  data: T | undefined;
  /** Why the last try failed; null after an answer. */
  error: unknown;
  loading: boolean;
  /** When `data` arrived, on the cache's clock (ms). */
  at: number;
}

const EMPTY: Entry = Object.freeze({ data: undefined, error: null, loading: false, at: 0 });

export interface Cache {
  /** The entry as it stands. The same object is returned until the entry changes. */
  get<T>(key: string): Entry<T>;
  subscribe(key: string, listener: () => void): () => void;
  /**
   * Fetches `key`, unless an answer under `fresh` ms old is held. `force` always asks again, after
   * any request already on its way, so what it brings back is newer than the call.
   */
  load(key: string, force?: boolean): Promise<void>;
  /** Forgets everything, and drops the answers still on their way: the account has changed. */
  clear(): void;
}

export function createCache(fetcher: (key: string) => Promise<unknown>, options: {
  fresh?: number;
  now?: () => number;
  /** Called with every answer that is kept. */
  onData?: (key: string, data: unknown) => void;
} = {}): Cache {
  const fresh = options.fresh ?? 5000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const flights = new Map<string, Promise<void>>();
  const listeners = new Map<string, Set<() => void>>();
  let generation = 0;

  const get = <T>(key: string) => (entries.get(key) ?? EMPTY) as Entry<T>;
  const tell = (key: string) => listeners.get(key)?.forEach((fn) => fn());
  const put = (key: string, entry: Entry) => {
    entries.set(key, entry);
    tell(key);
  };

  function load(key: string, force = false): Promise<void> {
    const flying = flights.get(key);
    if (flying) return force ? flying.then(() => load(key, true)) : flying;
    const held = get(key);
    if (!force && held.data !== undefined && now() - held.at < fresh) return Promise.resolve();
    const born = generation;
    put(key, { ...held, loading: true });
    const flight: Promise<void> = fetcher(key)
      .then(
        (data) => {
          if (born !== generation) return;
          put(key, { data, error: null, loading: false, at: now() });
          options.onData?.(key, data);
        },
        (error: unknown) => {
          if (born === generation) put(key, { ...get(key), error, loading: false });
        },
      )
      .finally(() => {
        if (flights.get(key) === flight) flights.delete(key);
      });
    flights.set(key, flight);
    return flight;
  }

  return {
    get,
    load,
    subscribe(key, listener) {
      const set = listeners.get(key) ?? new Set();
      listeners.set(key, set);
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    clear() {
      generation++;
      flights.clear();
      const keys = [...entries.keys()];
      entries.clear();
      keys.forEach(tell);
    },
  };
}
