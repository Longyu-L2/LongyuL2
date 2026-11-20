import test from "node:test";
import assert from "node:assert/strict";
import { claimPollDelay, liveBalances, newer, openClaim, shares, unlockOf, type Claim, type Reading } from "./rewards.ts";

const E18 = 10n ** 18n;
const T0 = 1_800_000_000_000;

const reading = (over: Partial<Reading["balances"]> = {}, receivedAt = T0): Reading => ({
  receivedAt,
  balances: { earned: String(60n * E18), claimed: String(10n * E18), claimable: String(20n * E18), pending: String(30n * E18), at: "1000", ...over },
});

test("without a running session the figures are the API's", () => {
  for (const r of [reading(), reading({ accrual: null }), reading({ at: undefined, accrual: { perHour: String(E18), until: "5000" } })]) {
    const live = liveBalances(r, T0 + 3_600_000);
    assert.deepEqual(live, { earned: 60n * E18, claimed: 10n * E18, claimable: 20n * E18, pending: 30n * E18, accruing: false });
  }
});

test("a running session adds to pending and to the total, a second at a time", () => {
  const r = reading({ accrual: { perHour: String(36n * E18), until: String(1000 + 7200) } });
  assert.equal(liveBalances(r, T0).pending, 30n * E18);
  assert.equal(liveBalances(r, T0).accruing, true);
  const after = liveBalances(r, T0 + 1000);
  assert.equal(after.pending, 30n * E18 + E18 / 100n);
  assert.equal(after.earned, after.claimed + after.claimable + after.pending);
  assert.equal(liveBalances(r, T0 + 1_800_000).pending, 48n * E18);
  // Claimed and claimable move only when the API says so.
  assert.equal(after.claimed, 10n * E18);
  assert.equal(after.claimable, 20n * E18);
});

test("counting stops when the session ends, and never runs backwards", () => {
  const r = reading({ accrual: { perHour: String(36n * E18), until: String(1000 + 3600) } });
  const end = liveBalances(r, T0 + 3_600_000);
  assert.equal(end.pending, 66n * E18);
  assert.equal(end.accruing, false);
  assert.deepEqual(liveBalances(r, T0 + 90_000_000), end);
  // A device clock set back after the answer arrived.
  assert.equal(liveBalances(r, T0 - 60_000).pending, 30n * E18);
  // An answer read after its session ended adds nothing.
  const late = reading({ at: "9000", accrual: { perHour: String(36n * E18), until: "4600" } });
  assert.deepEqual([liveBalances(late, T0 + 60_000).pending, liveBalances(late, T0 + 60_000).accruing], [30n * E18, false]);
});

test("figures that are missing or malformed count as nothing", () => {
  const live = liveBalances({ receivedAt: T0, balances: { earned: "x", claimed: "", claimable: "-5", pending: "7", at: "1", accrual: { perHour: "1e9", until: "100" } } }, T0 + 5000);
  assert.deepEqual(live, { earned: 7n, claimed: 0n, claimable: 0n, pending: 7n, accruing: true });
  const broken = liveBalances({ receivedAt: T0, balances: { earned: "0", claimed: "0", claimable: "0", pending: "7", at: "now", accrual: { perHour: "5", until: "soon" } } }, T0 + 5000);
  assert.deepEqual([broken.pending, broken.accruing], [7n, false]);
});

test("the later reading wins, whichever arrives last", () => {
  const first = reading({ at: "1000" });
  const second = reading({ at: "1005" }, T0 + 5000);
  assert.equal(newer(null, first), first);
  assert.equal(newer(first, second), second);
  assert.equal(newer(second, first), second);
  // Read in the same second: the one that arrived last.
  const twin = reading({ at: "1005" }, T0 + 5200);
  assert.equal(newer(second, twin), twin);
});

test("a new reading of the same session never takes the figures back", () => {
  // 36 a hour is a hundredth a second. The session runs until second 8200.
  const accrual = { perHour: String(36n * E18), until: "8200" };
  const first = reading({ accrual, at: "1000" });
  // Five seconds on, the device shows 30.05. The answer that arrives then was read at second 1004: 30.04.
  const second = reading({ accrual, at: "1004", pending: String(30n * E18 + (4n * E18) / 100n) }, T0 + 5000);
  const shown = liveBalances(first, T0 + 5000);
  assert.equal(shown.pending, 30n * E18 + (5n * E18) / 100n);
  const kept = newer(first, second);
  assert.deepEqual(kept.balances, second.balances);
  assert.equal(kept.receivedAt, second.receivedAt);

  // The figure waits where it was, then counts on from the new reading once that has caught up.
  const after = liveBalances(kept, T0 + 5000);
  assert.deepEqual([after.pending, after.earned, after.accruing], [shown.pending, shown.earned, true]);
  assert.equal(after.earned, after.claimed + after.claimable + after.pending);
  assert.equal(liveBalances(kept, T0 + 5500).pending, shown.pending);
  assert.equal(liveBalances(kept, T0 + 6000).pending, shown.pending);
  assert.equal(liveBalances(kept, T0 + 7000).pending, 30n * E18 + (6n * E18) / 100n);
  let last = shown.earned;
  for (let ms = 5000; ms <= 12_000; ms += 250) {
    const now = liveBalances(kept, T0 + ms).earned;
    assert.ok(now >= last, `at ${ms} ms`);
    last = now;
  }

  // It still stops when the session does, at the figure the API's own reading leads to.
  const end = liveBalances(kept, T0 + 90_000_000);
  assert.deepEqual([end.pending, end.accruing], [30n * E18 + 72n * E18, false]);

  // A third reading behind the second keeps what the first one showed.
  const third = reading({ accrual, at: "1004", pending: String(30n * E18 + (4n * E18) / 100n) }, T0 + 5400);
  assert.equal(liveBalances(newer(kept, third), T0 + 5400).pending, shown.pending);
});

test("a reading that is level or ahead is taken as it is", () => {
  const accrual = { perHour: String(36n * E18), until: "8200" };
  const first = reading({ accrual, at: "1000" });
  const level = reading({ accrual, at: "1005", pending: String(30n * E18 + (5n * E18) / 100n) }, T0 + 5000);
  assert.equal(newer(first, level), level);
  const ahead = reading({ accrual, at: "1006", pending: String(30n * E18 + (6n * E18) / 100n) }, T0 + 5000);
  assert.equal(newer(first, ahead), ahead);
});

test("a figure the API took down shows as the API has it", () => {
  const accrual = { perHour: String(36n * E18), until: "8200" };
  const first = reading({ accrual, at: "1000" });
  const lower = String(29n * E18);
  // A settlement moved pending into claimable and fixed the amount below the estimate.
  const settled = reading({ accrual, at: "1004", claimable: String(21n * E18), pending: lower }, T0 + 5000);
  // A claim was paid out.
  const claimed = reading({ accrual, at: "1004", claimed: String(30n * E18), claimable: "0", pending: lower }, T0 + 5000);
  // The session ended, or another one started.
  const ended = reading({ accrual: null, at: "1004", pending: lower }, T0 + 5000);
  const another = reading({ accrual: { ...accrual, until: "94600" }, at: "1004", pending: lower }, T0 + 5000);
  for (const next of [settled, claimed, ended, another]) {
    assert.equal(newer(first, next), next);
    assert.equal(liveBalances(newer(first, next), T0 + 5000).pending, 29n * E18);
  }
  // Nothing is held over from a reading that was not counting.
  assert.equal(newer(reading({ accrual: null, at: "1000", pending: String(40n * E18) }), settled), settled);
});

test("the bar's parts add up to the whole", () => {
  assert.deepEqual(shares(liveBalances(reading(), T0)), { claimed: 0.1666, claimable: 0.3333, pending: 0.5 });
  assert.deepEqual(shares({ earned: 0n, claimed: 0n, claimable: 0n, pending: 0n }), { claimed: 0, claimable: 0, pending: 0 });
  const all = shares({ earned: 5n, claimed: 0n, claimable: 0n, pending: 5n });
  assert.deepEqual(all, { claimed: 0, claimable: 0, pending: 1 });
});

// The device's own calendar decides the day, so these build their times from local dates.
const local = (day: number, hour: number, minute = 0, second = 0) => new Date(2026, 10, day, hour, minute, second).getTime();
const unlock = (ms: number, exact = true) => reading({ unlock: { at: String(ms / 1000), exact } }).balances;

test("the unlock time is worded by the device's calendar and never shown before the rewards open", () => {
  // 17:46:39 is shown as 17:47: at 17:46 the claim would still be closed.
  const today = unlockOf(unlock(local(20, 17, 46, 39)), local(20, 13, 30));
  assert.deepEqual(today, { day: "today", at: new Date(local(20, 17, 47)), exact: true });
  assert.equal(unlockOf(unlock(local(20, 17, 46)), local(20, 13, 30))!.at.getTime(), local(20, 17, 46));
  // A second before, it is still ahead; from the moment itself it is due.
  assert.equal(unlockOf(unlock(local(20, 17, 46, 39)), local(20, 17, 46, 38))!.day, "today");
  assert.equal(unlockOf(unlock(local(20, 17, 46, 39)), local(20, 17, 46, 39))!.day, "due");
  assert.equal(unlockOf(unlock(local(20, 17, 46, 39)), local(21, 9))!.day, "due");

  assert.deepEqual(unlockOf(unlock(local(21, 17, 47), false), local(20, 18)), { day: "tomorrow", at: new Date(local(21, 17, 47)), exact: false });
  // A minute past midnight is tomorrow, however soon it is; the last minute of the day rounds up into tomorrow.
  assert.equal(unlockOf(unlock(local(21, 0, 1)), local(20, 23, 59))!.day, "tomorrow");
  assert.deepEqual(unlockOf(unlock(local(20, 23, 59, 30)), local(20, 23, 0)), { day: "tomorrow", at: new Date(local(21, 0)), exact: true });
  assert.equal(unlockOf(unlock(local(21, 0, 1)), local(21, 0, 0, 30))!.day, "today");
  assert.equal(unlockOf(unlock(local(23, 17, 46)), local(20, 18))!.day, "later");
});

test("no unlock time is made up from an answer that carries none, or a broken one", () => {
  const now = local(20, 13);
  assert.equal(unlockOf(reading().balances, now), null);
  assert.equal(unlockOf(reading({ unlock: null }).balances, now), null);
  for (const at of ["", "soon", "-5", "1e12", "17:46", String(now / 1000 + 11 * 86_400)]) {
    assert.equal(unlockOf(reading({ unlock: { at, exact: true } }).balances, now), null, at);
  }
  assert.equal(unlockOf(reading({ unlock: { at: 1795176999 as unknown as string, exact: true } }).balances, now), null);
  // Anything but true is the scheduled kind: the wording never claims more than the answer said.
  assert.equal(unlockOf(reading({ unlock: { at: String(local(20, 17) / 1000), exact: "yes" as unknown as boolean } }).balances, now)!.exact, false);
});

test("the open claim is the one queued or sent", () => {
  const row = (id: string, status: Claim["status"]): Claim => ({ id, status, tx_hash: null, created_at: "1000" });
  assert.equal(openClaim(null), null);
  assert.equal(openClaim([]), null);
  assert.equal(openClaim([row("a", "confirmed"), row("b", "failed"), row("c", "skipped")]), null);
  assert.equal(openClaim([row("a", "queued"), row("b", "confirmed")])?.id, "a");
  assert.equal(openClaim([row("a", "failed"), row("b", "sent")])?.id, "b");
});

test("an open claim is asked about every few seconds, then less often", () => {
  assert.equal(claimPollDelay(0), 2500);
  assert.equal(claimPollDelay(59_999), 2500);
  assert.equal(claimPollDelay(60_000), 10_000);
  assert.equal(claimPollDelay(599_999), 10_000);
  assert.equal(claimPollDelay(600_000), 30_000);
  assert.equal(claimPollDelay(86_400_000), 30_000);
});
