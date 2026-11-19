import { test } from "node:test";
import assert from "node:assert/strict";
import { clockOffset, nextCheck, RECHECK_MS, RECHECKS, steadyOffset } from "./server-clock.ts";

// The server's clock in these tests: second 2000.
const NOW = 2_000_000;

test("the offset is the server's time in an answer against the device's when it arrived", () => {
  // A device five minutes ahead of the server, and one two minutes behind.
  assert.equal(clockOffset("1000", 1_300_000), -300_000);
  assert.equal(clockOffset("1000", 880_000), 120_000);
  assert.equal(clockOffset("1000", 1_000_250), -250);
  for (const at of [undefined, "", "now", "-5", "1e3", "12.5"]) assert.equal(clockOffset(at, 1_000_000), null, String(at));
});

test("a device clock that is off does not move the server's time as the device reads it", () => {
  for (const wrongBy of [-900_000, -1500, 0, 1500, 900_000]) {
    const device = NOW + wrongBy;
    const offset = steadyOffset(null, clockOffset("2000", device));
    assert.equal(device + offset!, NOW);
    // A session that ends at second 2600 is ten minutes away, whatever the device's clock says.
    assert.equal(nextCheck({ session: { endsAt: "2600" }, canStart: true, nextAllowedAt: null }, device + offset!, 0).wait, 601_000);
  }
});

test("of two estimates the larger is kept, so the time never steps back for a slow answer", () => {
  assert.equal(steadyOffset(null, null), null);
  assert.equal(steadyOffset(null, -400), -400);
  assert.equal(steadyOffset(-400, null), -400);
  // The second answer took longer to arrive: its estimate is further short of the truth.
  assert.equal(steadyOffset(-400, -1900), -400);
  assert.equal(steadyOffset(-1900, -400), -400);
  assert.equal(steadyOffset(120_000, 119_200), 120_000);
  // The device's clock was set forward by a minute, or back by one.
  assert.equal(steadyOffset(-400, -60_400), -60_400);
  assert.equal(steadyOffset(-400, 59_600), 59_600);
});

test("the status is asked for a second after the session ends or the next may start, whichever is first", () => {
  const resting = { session: { endsAt: "2900" }, canStart: false, nextAllowedAt: "2300" };
  assert.deepEqual(nextCheck(resting, NOW, 0), { wait: 301_000, overdue: false });
  // Once a session may start, only the running one's end is left to wait for.
  assert.deepEqual(nextCheck({ ...resting, canStart: true, nextAllowedAt: null }, NOW, 0), { wait: 901_000, overdue: false });
  assert.deepEqual(nextCheck({ session: null, canStart: true, nextAllowedAt: null }, NOW, 0), { wait: null, overdue: false });
  assert.deepEqual(nextCheck({ session: { endsAt: "1900" }, canStart: true, nextAllowedAt: null }, NOW, 0), { wait: null, overdue: false });
  assert.deepEqual(nextCheck({ session: { endsAt: "soon" }, canStart: false, nextAllowedAt: "later" }, NOW, 0), { wait: null, overdue: false });
});

test("an answer that still refuses a start whose time has passed is asked for again, a few times", () => {
  const early = { session: { endsAt: "2900" }, canStart: false, nextAllowedAt: "2000" };
  assert.equal(RECHECK_MS, 10_000);
  for (let tries = 0; tries < RECHECKS; tries++) assert.deepEqual(nextCheck(early, NOW, tries), { wait: RECHECK_MS, overdue: true });
  // After that only the session's end is waited for.
  assert.deepEqual(nextCheck(early, NOW, RECHECKS), { wait: 901_000, overdue: true });
  assert.deepEqual(nextCheck({ ...early, session: null }, NOW, RECHECKS), { wait: null, overdue: true });
  // A session ending sooner than the next try is not kept waiting.
  assert.deepEqual(nextCheck({ ...early, session: { endsAt: "2004" } }, NOW, 0), { wait: 5000, overdue: true });
  // Long past, as on a device whose clock is far ahead and has no answer to correct it by.
  assert.deepEqual(nextCheck({ ...early, nextAllowedAt: "1100" }, NOW, 2), { wait: RECHECK_MS, overdue: true });
  assert.equal(nextCheck({ ...early, nextAllowedAt: "2001" }, NOW, 0).overdue, false);
});
