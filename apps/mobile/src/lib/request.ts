/**
 * One request to the API with a limit on how long it may take, so a connection that stalls ends as
 * an error the screen can show instead of a spinner that never stops. No native imports, so the
 * unit tests run it.
 */

export const REQUEST_TIMEOUT_MS = 20_000;

export interface Answer {
  status: number;
  ok: boolean;
  /** The body as JSON; undefined when it is not JSON. */
  json: unknown;
}

/**
 * Sends the request and reads its answer. The limit covers the body as well as the headers. When it
 * passes, the request is abandoned and the promise fails with what `timedOut` makes.
 */
export function request(url: string, init: RequestInit, timedOut: () => Error, ms = REQUEST_TIMEOUT_MS): Promise<Answer> {
  const control = new AbortController();
  return new Promise<Answer>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(timedOut());
      control.abort();
    }, ms);
    fetch(url, { ...init, signal: control.signal })
      .then(async (res) => ({ status: res.status, ok: res.ok, json: (await res.json().catch(() => undefined)) as unknown }))
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
