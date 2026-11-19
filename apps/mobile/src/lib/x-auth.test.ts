import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { AUTH_REDIRECT, embeddedBrowser, hex, isAuthReturn, readAuthReturn, readWebReturn, returnErrorCode, toBase64Url } from "./x-auth.ts";
import { errorKey } from "./errors.ts";
import { redirectSystemPath } from "../app/+native-intent.ts";

const TICKET = randomBytes(32).toString("base64url");

test("the return link uses the app's own scheme", () => {
  const app = JSON.parse(readFileSync("app.json", "utf8")) as { expo: { scheme: string } };
  assert.equal(AUTH_REDIRECT, `${app.expo.scheme}://auth`);
});

test("a ticket is taken only from the exact return link", () => {
  assert.deepEqual(readAuthReturn(`longyumine://auth?ticket=${TICKET}`), { ticket: TICKET });
  assert.deepEqual(readAuthReturn(`longyumine://auth?ticket=${"-_".repeat(21)}A`), { ticket: `${"-_".repeat(21)}A` });
  const failed = [
    "",
    "longyumine://auth",
    "longyumine://auth?",
    "longyumine://auth?ticket=",
    `longyumine://auth?ticket=${TICKET.slice(1)}`,
    `longyumine://auth?ticket=${TICKET}A`,
    `longyumine://auth?ticket=${TICKET.slice(1)}%`,
    `longyumine://auth?ticket=${TICKET.slice(1)}+`,
    `longyumine://auth?ticket=${TICKET}&ticket=${TICKET}`,
    `longyumine://auth?ticket=${TICKET}&error=denied`,
    `longyumine://auth?error=denied&ticket=${TICKET}`,
    `longyumine://auth?ticket=${TICKET}#x`,
    `longyumine://auth?ticket=${TICKET}\n`,
    `longyumine://auth?x=1&ticket=${TICKET}`,
    `longyumine://auth/?ticket=${TICKET}`,
    `longyumine://authx?ticket=${TICKET}`,
    `longyumine://auth.evil.example?ticket=${TICKET}`,
    `longyumine://other?ticket=${TICKET}`,
    `LONGYUMINE://auth?ticket=${TICKET}`,
    `https://auth?ticket=${TICKET}`,
    ` longyumine://auth?ticket=${TICKET}`,
    "longyumine://auth?error=failed",
    "longyumine://auth?error=access_denied",
    "longyumine://auth?error=denied&x=1",
    "longyumine://auth?error=too_soon&x=1",
    "longyumine://auth?error=TOO_SOON",
    "longyumine://auth?error=",
  ];
  for (const url of failed) assert.deepEqual(readAuthReturn(url), { error: "failed" }, JSON.stringify(url));
  for (const error of ["denied", "too_soon", "paused", "too_many"]) assert.deepEqual(readAuthReturn(`longyumine://auth?error=${error}`), { error });
});

test("each reason the API gives for a sign-in without a ticket has wording of its own", () => {
  const wording = { denied: "xDenied", failed: "xFailed", too_soon: "xTooSoon", paused: "xPaused", too_many: "xTooMany" } as const;
  for (const [error, key] of Object.entries(wording)) {
    const back = readWebReturn(`#error=${error}`);
    assert.ok(back && "error" in back);
    assert.equal(back.error, error);
    assert.equal(errorKey(returnErrorCode(back.error)), key);
  }
});

test("a browser inside another app is told from a browser of its own", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8";
  const own = [
    `${iphone} Version/26.0 Mobile/15E148 Safari/604.1`,
    `${iphone} CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1`,
    `${iphone} FxiOS/143.0 Mobile/15E148 Safari/605.1.15`,
    `${iphone} EdgiOS/141.0.3537.57 Version/18.0 Mobile/15E148 Safari/604.1`,
    `${android}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36`,
    `${android}) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36`,
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
    "",
  ];
  for (const agent of own) assert.equal(embeddedBrowser(agent), false, agent);
  const embedded = [
    `${iphone} Mobile/15E148`,
    `${iphone} Mobile/15E148 Twitter for iPhone/11.20`,
    `${iphone} Mobile/15E148 Instagram 400.0.0.20.80 (iPhone16,1; iOS 18_6; en_US; en; scale=3.00; 1179x2556; 780000000)`,
    `${iphone} Mobile/15E148 [FBAN/FBIOS;FBAV/530.0.0.50.70;FBBV/800000000;FBDV/iPhone16,1]`,
    `${iphone} Mobile/15E148 Safari/604.1 Telegram-iOS/12.0`,
    `${iphone} Mobile/15E148 MicroMessenger/8.0.60(0x18003c2f) NetType/WIFI Language/en`,
    `${iphone} Mobile/15E148 Safari/604.1 Line/15.14.0`,
    `${android}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36`,
    `${android}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 TwitterAndroid`,
    `${android}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/530.0.0.50.70;]`,
  ];
  for (const agent of embedded) assert.equal(embeddedBrowser(agent), true, agent);
});

test("the return link never reaches the router, and other links are left alone", () => {
  for (const link of [`longyumine://auth?ticket=${TICKET}`, "longyumine://auth", "longyumine://auth?error=denied", "longyumine://auth/", "longyumine:///auth?x", "/auth?ticket=1", "auth", "auth#x"]) {
    assert.equal(isAuthReturn(link), true, link);
    assert.equal(redirectSystemPath({ path: link, initial: false }), null, link);
    assert.equal(redirectSystemPath({ path: link, initial: true }), "/", link);
  }
  for (const link of ["longyumine://", "longyumine://mine", "longyumine://authority", "longyumine://boost?auth", "/setup", "/mine/auth", "", "https://example.com/auth"]) {
    assert.equal(isAuthReturn(link), false, link);
    assert.equal(redirectSystemPath({ path: link, initial: false }), link);
    assert.equal(redirectSystemPath({ path: link, initial: true }), link);
  }
});

test("the web return is read from what follows the #, and only in the exact forms the API sends", () => {
  assert.deepEqual(readWebReturn(`#ticket=${TICKET}`), { ticket: TICKET });
  for (const error of ["denied", "failed", "too_soon", "paused", "too_many"]) assert.deepEqual(readWebReturn(`#error=${error}`), { error });
  // An address without a sign-in return is not one that failed.
  for (const hash of ["", "#", "#mine", "#/ticket=x", "?ticket=" + TICKET, "ticket=" + TICKET, "# ticket=" + TICKET, "#Ticket=" + TICKET]) {
    assert.equal(readWebReturn(hash), null, JSON.stringify(hash));
  }
  const failed = [
    "#ticket=", `#ticket=${TICKET.slice(1)}`, `#ticket=${TICKET}A`, `#ticket=${TICKET}&x=1`, `#ticket=${TICKET}#`, `#ticket=${TICKET} `,
    `#ticket=${TICKET.slice(1)}+`, `#ticket=${TICKET}&ticket=${TICKET}`, "#error=", "#error=other", "#error=denied&x=1", "#error=too_soon ", "#error=too_soon&error=denied", "#error=Paused", `#error=denied&ticket=${TICKET}`,
  ];
  for (const hash of failed) assert.deepEqual(readWebReturn(hash), { error: "failed" }, JSON.stringify(hash));
});

test("the secret and its hash are in the forms the API accepts", () => {
  const bytes = randomBytes(32);
  const verifier = hex(bytes);
  assert.equal(verifier, bytes.toString("hex"));
  assert.match(verifier, /^[A-Za-z0-9._~-]{43,128}$/);
  assert.equal(hex(new Uint8Array([0, 1, 15, 16, 255])), "00010f10ff");
  for (let i = 0; i < 200; i++) {
    const v = hex(randomBytes(32));
    const challenge = toBase64Url(createHash("sha256").update(v).digest("base64"));
    assert.equal(challenge, createHash("sha256").update(v).digest("base64url"));
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  }
  assert.equal(toBase64Url("+/+/ab=="), "-_-_ab");
});
