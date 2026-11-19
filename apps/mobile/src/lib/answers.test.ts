import { test } from "node:test";
import assert from "node:assert/strict";
import { accountTurn, untilLoaded } from "./answers.ts";

test("an answer asked for under one account is not that of the next", async () => {
  const turn = accountTurn();
  const shown: string[] = [];
  // The account as app-state.tsx loads it: the answer counts only if nobody signed in or out meanwhile.
  const load = async (answer: Promise<string>) => {
    const same = turn.holds();
    const me = await answer;
    if (same()) shown.push(me);
  };

  let arrive!: (me: string) => void;
  const first = load(new Promise<string>((resolve) => (arrive = resolve)));
  // The first person signs out and another signs in before the answer is back.
  turn.next();
  turn.next();
  const second = load(Promise.resolve("second"));
  arrive("first");
  await Promise.all([first, second]);
  assert.deepEqual(shown, ["second"]);

  // With nobody signing in or out, every answer counts, in whatever order.
  await Promise.all([load(Promise.resolve("again")), load(Promise.resolve("and again"))]);
  assert.deepEqual(shown, ["second", "again", "and again"]);
});

test("a check holds only until the account changes, and each check is its own", () => {
  const turn = accountTurn();
  const before = turn.holds();
  assert.equal(before(), true);
  turn.next();
  const after = turn.holds();
  assert.deepEqual([before(), after()], [false, true]);
  turn.next();
  assert.deepEqual([before(), after(), turn.holds()()], [false, false, true]);
});

test("what failed to load is tried again at the next call, and never once it has loaded", async () => {
  let calls = 0;
  let settle: { resolve: () => void; reject: (e: Error) => void } | null = null;
  const load = untilLoaded(() => {
    calls++;
    return new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
  });
  const settled = () => new Promise((resolve) => setImmediate(resolve));

  load();
  load();
  // One try at a time.
  assert.equal(calls, 1);
  settle!.reject(new Error("offline"));
  await settled();
  assert.equal(calls, 1);

  load();
  assert.equal(calls, 2);
  settle!.reject(new Error("offline"));
  await settled();
  load();
  load();
  assert.equal(calls, 3);
  settle!.resolve();
  await settled();

  load();
  load();
  assert.equal(calls, 3);
});
