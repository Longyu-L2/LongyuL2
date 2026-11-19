/**
 * Two rules app-state.tsx keeps about the API's answers: one that was asked for under another
 * account is dropped, and one that has to arrive once is asked for until it has. No native imports,
 * so the unit tests run it.
 */

export interface Turn {
  /** The account signed in or out. */
  next(): void;
  /** A check to keep across a request: whether the account is still the one it was when this was called. */
  holds(): () => boolean;
}

/** Counts the times the signed-in account has changed, for an answer that arrives after it did. */
export function accountTurn(): Turn {
  let turn = 0;
  return {
    next() {
      turn++;
    },
    holds() {
      const asked = turn;
      return () => asked === turn;
    },
  };
}

/**
 * A call that runs `load` until it has worked once. It does nothing while a try is on its way and
 * nothing after one has worked; a try that failed leaves the next call to try again.
 */
export function untilLoaded(load: () => Promise<void>): () => void {
  let state: "idle" | "loading" | "loaded" = "idle";
  return () => {
    if (state !== "idle") return;
    state = "loading";
    load().then(
      () => {
        state = "loaded";
      },
      () => {
        state = "idle";
      },
    );
  };
}
