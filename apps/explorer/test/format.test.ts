import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGasPrice, formatNumber, formatUnits, percent, short, timeAgo, utc } from "../src/web/format.ts";

test("formatUnits", () => {
  const E18 = 10n ** 18n;
  assert.equal(formatUnits(1234n * E18 + 567_890_000_000_000_000n, 18), "1,234.56789");
  assert.equal(formatUnits(0n, 18), "0");
  assert.equal(formatUnits(1n, 18), "<0.000001");
  assert.equal(formatUnits(-5n * E18, 18), "-5");
  assert.equal(formatUnits("1000000", 6), "1");
  assert.equal(formatUnits(12345n, null), "12,345");
  assert.equal(formatUnits(42n, 0), "42");
});

test("gas price, numbers, time, hashes, percentages", () => {
  assert.equal(formatGasPrice("1"), "1 wei");
  assert.equal(formatGasPrice(1_500_000_000n), "1.5 gwei");
  assert.equal(formatGasPrice(5_621_000n), "0.0056 gwei");
  assert.equal(formatGasPrice(99_999n), "99,999 wei");
  assert.equal(formatGasPrice(null), "–");
  assert.equal(formatNumber(1234567n), "1,234,567");
  assert.equal(timeAgo(100, 105), "5 s ago");
  assert.equal(timeAgo(0, 7200), "2 h ago");
  assert.equal(timeAgo(0, 3 * 86_400), "3 d ago");
  assert.equal(utc(0), "1970-01-01 00:00:00 UTC");
  assert.equal(short(`0x${"ab".repeat(32)}`, 6, 4), "0xabab…abab");
  assert.equal(percent(1n, 3n), "33.33%");
  assert.equal(percent(0n, 0n), "0%");
  assert.equal(percent(5n, 5n), "100.00%");
});
