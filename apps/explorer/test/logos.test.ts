/** Token logos: from the explorer's own address, never a broken image. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { createPgliteDb, migrate } from "../src/db.ts";
import { monogramSvg } from "../src/logos.ts";
import { FakeChain } from "./fake-chain.ts";

const LONG = "0xc6d2b2483ec93c15109fce43d21ac05919031655";
const MADE = "0x00000000000000000000000000000000000a11ce";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function serve(fetchLogo: typeof fetch, api = "https://api.longyu.network") {
  const db = await createPgliteDb();
  await migrate(db);
  const config = ConfigSchema.parse({ RPC_URL: "http://node.invalid", CHAIN_ID: "668800", NODE_ENV: "test", OFFICIAL_TOKENS: LONG, TOKEN_LOGO_API: api, RUN_INDEXER: "false" });
  const app = await buildApp({ db, rpc: new FakeChain(), config, fetchLogo });
  return { get: (url: string) => app.inject({ method: "GET", url }), close: async () => { await app.close(); await db.close(); } };
}

test("monograms: letters and digits only, never markup from the symbol", () => {
  const m = monogramSvg('<script>"x"</script>').body.toString();
  assert.ok(!m.includes("<script") && !m.includes('"x"'));
  assert.match(m, />SC<\/text>/);
  assert.match(monogramSvg(null).body.toString(), />\?<\/text>/);
});

test("logo route: LONG's mark, BNB's logo, a creator's logo from the API, else a monogram", async () => {
  const asked: string[] = [];
  const s = await serve(async (url) => {
    asked.push(String(url));
    return String(url).includes(MADE)
      ? new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })
      : new Response("<svg onload=alert(1)>", { status: 200, headers: { "content-type": "image/svg+xml" } });
  });
  try {
    const long = await s.get(`/logo/${LONG}`);
    assert.equal(long.statusCode, 302);
    assert.match(String(long.headers.location), /^\/static\/mark\.svg/);
    assert.match(String((await s.get("/logo/0x4200000000000000000000000000000000000006")).headers.location), /^\/static\/bnb\.png/);

    const made = await s.get(`/logo/${MADE}`);
    assert.equal(made.headers["content-type"], "image/png");
    assert.ok(made.rawPayload.equals(PNG));
    assert.match(String(made.headers["content-security-policy"]), /default-src 'none'/);
    // Asked once, then kept.
    await s.get(`/logo/${MADE.toUpperCase().replace("0X", "0x")}`);
    assert.equal(asked.filter((u) => u.includes(MADE)).length, 1);

    // An SVG from the API is not taken: the monogram stands in.
    const other = await s.get("/logo/0x0000000000000000000000000000000000000bad");
    assert.match(String(other.headers["content-type"]), /^image\/svg\+xml/);
    assert.ok(!other.body.includes("onload"));
    assert.equal((await s.get("/logo/not-an-address")).statusCode, 404);
  } finally {
    await s.close();
  }
});

test("logo route: the API out of reach still gives a monogram", async () => {
  const s = await serve(async () => { throw new Error("down"); });
  try {
    const r = await s.get(`/logo/${MADE}`);
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers["content-type"]), /^image\/svg\+xml/);
  } finally {
    await s.close();
  }
});
