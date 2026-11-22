/** Logos of tokens made with LONGYU Launch: only the creator's signature sets one, and only a real image is taken. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { imageInfo, logoMessage, logoProblem } from "../src/modules/token-logos.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

const LAUNCHER = "0x0F6f17ABD46463F2B431104e1895bBE6AA91d7BF";
const TOKEN = getAddress("0x00000000000000000000000000000000000a11ce");

/** A valid PNG of the given size (one grey row repeated). */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type, "latin1"); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w, 0x80)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** A JPEG header with a start-of-frame of the given size (enough for the size check). */
function jpeg(w: number, h: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

async function upload(env: TestEnv, token: string, image: Buffer, sign: (m: string) => Promise<string>) {
  const sha = createHash("sha256").update(image).digest("hex");
  const signature = await sign(logoMessage(getAddress(token), env.deps.config.CHAIN_ID, sha));
  const res = await env.app.inject({ method: "POST", url: `/v1/tokens/${token}/logo`, payload: { image: image.toString("base64"), signature } });
  return { status: res.statusCode, json: res.json() as Record<string, string> };
}

test("image checks: PNG, JPEG and WebP by their headers, 64 to 1024 pixels, at most 256 KB; nothing else", () => {
  assert.deepEqual(imageInfo(png(128, 96)), { type: "image/png", width: 128, height: 96 });
  assert.deepEqual(imageInfo(jpeg(300, 200)), { type: "image/jpeg", width: 300, height: 200 });
  const webp = Buffer.alloc(30); webp.write("RIFF", 0, "latin1"); webp.write("WEBP", 8, "latin1"); webp.write("VP8X", 12, "latin1"); webp.writeUIntLE(255, 24, 3); webp.writeUIntLE(127, 27, 3);
  assert.deepEqual(imageInfo(webp), { type: "image/webp", width: 256, height: 128 });
  assert.equal(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(imageInfo(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")), null);
  assert.equal(logoProblem(png(256, 256)), null);
  assert.match(logoProblem(png(32, 256))!, /64 to 1024/);
  assert.match(logoProblem(jpeg(2000, 2000))!, /64 to 1024/);
  assert.match(logoProblem(Buffer.alloc(0))!, /256 KB/);
  assert.match(logoProblem(Buffer.concat([png(64, 64), Buffer.alloc(256 * 1024)]))!, /256 KB/);
});

test("logos: the creator sets and replaces one; anyone reads it; nobody else can set it", async () => {
  const env = await makeEnv({ env: { TOKEN_LAUNCHER: LAUNCHER } });
  try {
    const creator = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());
    assert.equal((await env.app.inject({ method: "GET", url: `/v1/tokens/${TOKEN}/logo` })).statusCode, 404);

    // Not made with the launcher: refused, however it is signed.
    const notMade = await upload(env, TOKEN, png(128, 128), (message) => creator.signMessage({ message }));
    assert.equal(notMade.status, 403);
    assert.equal(notMade.json.error, "not_launched");

    env.chain.launched.set(TOKEN.toLowerCase(), creator.address);
    const wrong = await upload(env, TOKEN, png(128, 128), (message) => stranger.signMessage({ message }));
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.error, "not_creator");

    // A signature for another image does not carry over.
    const image = png(128, 128);
    const other = png(200, 200);
    const sig = await creator.signMessage({ message: logoMessage(TOKEN, env.deps.config.CHAIN_ID, createHash("sha256").update(other).digest("hex")) });
    const swapped = await env.app.inject({ method: "POST", url: `/v1/tokens/${TOKEN}/logo`, payload: { image: image.toString("base64"), signature: sig } });
    assert.equal(swapped.statusCode, 403);

    const bad = await upload(env, TOKEN, Buffer.from("<svg/>"), (message) => creator.signMessage({ message }));
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, "logo_invalid");

    const ok = await upload(env, TOKEN, image, (message) => creator.signMessage({ message }));
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.match(ok.json.url!, new RegExp(`/v1/tokens/${TOKEN}/logo\\?v=[0-9a-f]{12}$`));
    // Any spelling of the address finds it.
    const got = await env.app.inject({ method: "GET", url: `/v1/tokens/${TOKEN.toLowerCase()}/logo` });
    assert.equal(got.statusCode, 200);
    assert.equal(got.headers["content-type"], "image/png");
    assert.equal(got.headers["x-content-type-options"], "nosniff");
    assert.match(String(got.headers["content-security-policy"]), /default-src 'none'/);
    assert.ok(got.rawPayload.equals(image));

    const replaced = await upload(env, TOKEN, jpeg(400, 400), (message) => creator.signMessage({ message }));
    assert.equal(replaced.status, 200);
    assert.equal((await env.app.inject({ method: "GET", url: `/v1/tokens/${TOKEN}/logo` })).headers["content-type"], "image/jpeg");

    assert.equal((await env.app.inject({ method: "GET", url: "/v1/tokens/not-an-address/logo" })).statusCode, 400);
  } finally {
    await env.close();
  }
});

test("logos: without TOKEN_LAUNCHER no upload is taken", async () => {
  const env = await makeEnv();
  try {
    const creator = privateKeyToAccount(generatePrivateKey());
    env.chain.launched.set(TOKEN.toLowerCase(), creator.address);
    const r = await upload(env, TOKEN, png(128, 128), (message) => creator.signMessage({ message }));
    assert.equal(r.status, 404);
    assert.equal(r.json.error, "logos_unavailable");
  } finally {
    await env.close();
  }
});
