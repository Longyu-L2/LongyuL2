import { test } from "node:test";
import assert from "node:assert/strict";
import { boostPercent, capacityClass, compactNumber, fill, formatDuration, formatToken, formatTokenFixed, multiplier, sessionProgress, shortAddress, tierKey, tierName } from "./format.ts";

test("formatToken", () => {
  assert.equal(formatToken("24000000000000000000"), "24");
  assert.equal(formatToken("12345600000000000000"), "12.3456");
  assert.equal(formatToken("1234567000000000000000000"), "1,234,567");
  assert.equal(formatToken("1"), "0.0001");
  assert.equal(formatToken("0"), "0");
  assert.equal(formatToken(28_800_000_000_000_000_000n, 2), "28.8");
});

test("formatToken with no decimals", () => {
  assert.equal(formatToken("500000000000000000", 0), "0");
  assert.equal(formatToken("1", 0), "0");
  assert.equal(formatToken("0", 0), "0");
  assert.equal(formatToken("1999999999999999999", 0), "1");
  assert.equal(formatToken("318442915500000000000000000", 0), "318,442,915");
});

test("formatDuration and sessionProgress", () => {
  assert.equal(formatDuration(86_399), "23h 59m");
  assert.equal(formatDuration(300), "5m");
  assert.equal(formatDuration(-5), "0m");
  assert.equal(sessionProgress(0, 43_200), 0.5);
  assert.equal(sessionProgress(0, 100_000), 1);
  assert.equal(sessionProgress(10, 0), 0);
});

test("shortAddress and tierName", () => {
  assert.equal(shortAddress("0x1234567890abcdef1234567890abcdef12345678"), "0x1234…5678");
  assert.equal(tierName(2), "Verified");
  assert.equal(tierName(9), "Unknown");
});

test("tier keys and boost formatting", () => {
  assert.equal(tierKey(2), "tierVerified");
  assert.equal(tierKey(9), "tierRestricted");
  assert.equal(multiplier(0), "1.00×");
  assert.equal(multiplier(2500), "1.25×");
  assert.equal(multiplier(10_000), "2.00×");
  assert.equal(boostPercent(5000), "+50%");
});

test("formatTokenFixed", () => {
  assert.equal(formatTokenFixed("1500000000000000000"), "1.5000");
  assert.equal(formatTokenFixed("0"), "0.0000");
  assert.equal(formatTokenFixed(""), "0.0000");
  assert.equal(formatTokenFixed("1234567899999999999999", 2), "1,234.56");
  assert.equal(formatTokenFixed("999999999999999999", 4), "0.9999");
  assert.equal(formatTokenFixed(42n * 10n ** 18n, 0), "42");
  assert.equal(formatTokenFixed(-(10n ** 17n), 3), "-0.100");
});

test("fill", () => {
  assert.equal(fill("Good evening, {name}", { name: "meilin" }), "Good evening, meilin");
  assert.equal(fill("Good evening, {name}", {}), "Good evening");
  assert.equal(fill("晚上好，{name}", { name: "" }), "晚上好");
  assert.equal(fill("{x} mining power for {n} days", { x: "1.50×", n: 30 }), "1.50× mining power for 30 days");
  assert.equal(fill("剩余 {n} 天", { n: 0 }), "剩余 0 天");
});

test("compactNumber", () => {
  assert.equal(compactNumber("318,442,915"), "318.4M");
  assert.equal(compactNumber("48213"), "48.2K");
  assert.equal(compactNumber("2000000"), "2M");
  assert.equal(compactNumber("950"), "950");
});

test("capacityClass", () => {
  assert.equal(capacityClass("c3-30"), "C3");
  assert.equal(capacityClass("c5-90"), "C5");
  assert.equal(capacityClass("pro"), "PRO");
});
