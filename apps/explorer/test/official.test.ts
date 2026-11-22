/** LONGYU's own tokens are marked official, and other tokens that pass for them carry a warning. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { siteOf } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import type { TokenRow } from "../src/queries.ts";
import { passesForLongyu, readsAs, searchPage, standing, tokenPage, tokensPage } from "../src/web/pages.ts";

const LONG = "0xc6D2B2483EC93C15109FCe43d21Ac05919031655";
const site = (official = LONG) => siteOf(ConfigSchema.parse({ RPC_URL: "http://node.invalid", CHAIN_ID: "668800", OFFICIAL_TOKENS: official }));
const row = (address: string, name: string | null, symbol: string | null): TokenRow =>
  ({ address: address.toLowerCase(), kind: "erc20", name, symbol, decimals: 18, first_block: 1n, holders: 1n, transfers: 1n });
const FAKE = "0x00000000000000000000000000000000000071c0";
const page = (t: TokenRow) => String(tokenPage(site(), t, { supply: 0n, tab: "transfers", page: 1, transfers: [], holders: [] }));

test("names that pass for LONG or LONGYU, in any case, spacing or look-alike letters", () => {
  assert.equal(readsAs("L0ng Yu"), "LONGYU");
  assert.equal(readsAs("ＬＯＮＧ"), "LONG");
  assert.equal(readsAs("LОNG"), "LONG"); // Cyrillic О
  for (const [name, symbol] of [["Long", "X"], ["X", "long"], ["X", "$LONG"], ["Wrapped Long", "wLONG"], ["Longyu Coin", "LYC"], ["X", "L0NG"], ["long yu", "Z"], ["X", "tLONG"]] as [string, string][]) {
    assert.ok(passesForLongyu({ name, symbol }), `${name} / ${symbol}`);
  }
  for (const [name, symbol] of [["Longevity", "LGV"], ["Long Meme", "LMEME"], ["Belong", "BLG"], [null, null]] as [string | null, string | null][]) {
    assert.ok(!passesForLongyu({ name, symbol }), `${name} / ${symbol}`);
  }
});

test("the official token is marked; an imitation gets a warning naming the real address; others get nothing", () => {
  assert.equal(standing(site(), row(LONG, "LONGYU", "LONG")), "official");
  assert.equal(standing(site(), row(FAKE, "LONGYU", "LONG")), "imitation");
  assert.equal(standing(site(), row(FAKE, "Tether", "USDT")), null);
  // Without OFFICIAL_TOKENS nothing is marked.
  assert.equal(standing(site(""), row(FAKE, "LONGYU", "LONG")), null);

  const real = page(row(LONG, "LONGYU", "LONG"));
  assert.ok(real.includes("Official LONGYU token"));
  assert.ok(!real.includes("Not LONGYU's token"));

  const fake = page(row(FAKE, "LONGYU", "LONG"));
  assert.ok(fake.includes("Not LONGYU&#39;s token") || fake.includes("Not LONGYU's token"));
  assert.ok(fake.includes(LONG.toLowerCase()));
  assert.ok(!fake.includes("Official LONGYU token"));

  assert.ok(!page(row(FAKE, "Tether", "USDT")).includes("LONGYU"));

  const list = String(tokensPage(site(), [row(LONG, "LONGYU", "LONG"), row(FAKE, "Long Yu", "LONG"), row("0x" + "1".repeat(40), "Tether", "USDT")], 1));
  assert.equal(list.split(">Official<").length - 1, 1);
  assert.equal(list.split(">Not official<").length - 1, 1);
  const found = String(searchPage("long", [row(LONG, "LONGYU", "LONG"), row(FAKE, "LONG", "LONG")], site()));
  assert.equal(found.split(">Official<").length - 1, 1);
  assert.equal(found.split(">Not official<").length - 1, 1);
});

test("OFFICIAL_TOKENS takes addresses only", () => {
  assert.throws(() => ConfigSchema.parse({ RPC_URL: "http://node.invalid", CHAIN_ID: "668800", OFFICIAL_TOKENS: "LONG" }));
  assert.deepEqual(site(` ${LONG} , `).official, [LONG.toLowerCase()]);
});

test("address pages: LONG's is marked before it is a listed token; an imitation's warns", async () => {
  const { addressPage } = await import("../src/web/pages.ts");
  const base = { balance: 0n, isContract: true, txCount: 0n, creation: null, tab: "txs" as const, page: 1, txs: [], transfers: [], holdings: [] };
  const real = String(addressPage(site(), LONG.toLowerCase(), { ...base, token: null }));
  assert.ok(real.includes("Official LONGYU token"));
  const fake = String(addressPage(site(), FAKE, { ...base, token: row(FAKE, "LONG", "LONG") }));
  assert.ok(fake.includes("did not create it"));
  assert.ok(!fake.includes("Official LONGYU token"));
  assert.ok(!String(addressPage(site(), FAKE, { ...base, token: row(FAKE, "Tether", "USDT") })).includes("did not create it"));
});

test("OFFICIAL_NOTE shows on the official token's pages and ends every imitation warning", async () => {
  const { addressPage } = await import("../src/web/pages.ts");
  const NOTE = "Official LONG is in its mining phase and not tradable yet.";
  const noted = siteOf(ConfigSchema.parse({ RPC_URL: "http://node.invalid", CHAIN_ID: "668800", OFFICIAL_TOKENS: LONG, OFFICIAL_NOTE: NOTE }));
  const tp = (t: TokenRow) => String(tokenPage(noted, t, { supply: 0n, tab: "transfers", page: 1, transfers: [], holders: [] }));
  const base = { balance: 0n, isContract: true, txCount: 0n, creation: null, tab: "txs" as const, page: 1, txs: [], transfers: [], holdings: [] };
  assert.ok(tp(row(LONG, "LONGYU", "LONG")).includes(NOTE));
  assert.ok(tp(row(FAKE, "LONG", "LONG")).includes(NOTE));
  assert.ok(!tp(row(FAKE, "Tether", "USDT")).includes(NOTE));
  assert.ok(String(addressPage(noted, LONG.toLowerCase(), { ...base, token: null })).includes(NOTE));
  assert.ok(String(addressPage(noted, FAKE, { ...base, token: row(FAKE, "LONG", "LONG") })).includes(NOTE));
  assert.ok(!page(row(LONG, "LONGYU", "LONG")).includes(NOTE));
});

test("a token made with LONGYU Launch says so; others and imitations do not", () => {
  const tp = (t: TokenRow, launched: boolean) => String(tokenPage(site(), t, { supply: 0n, launched, tab: "transfers", page: 1, transfers: [], holders: [] }));
  assert.ok(tp(row(FAKE, "Pearl", "PEARL"), true).includes("Made with LONGYU Launch"));
  assert.ok(!tp(row(FAKE, "Pearl", "PEARL"), false).includes("Made with LONGYU Launch"));
  assert.ok(!tp(row(FAKE, "LONG", "LONG"), true).includes("Made with LONGYU Launch"));
});
