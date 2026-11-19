import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { AUTH_REDIRECT, hex, isAuthReturn, readAuthReturn, readWebReturn, toBase64Url } from "./x-auth.ts";
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
    "longyumine://auth?error=",
  ];
  for (const url of failed) assert.deepEqual(readAuthReturn(url), { error: "failed" }, JSON.stringify(url));
  assert.deepEqual(readAuthReturn("longyumine://auth?error=denied"), { error: "denied" });
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
  assert.deepEqual(readWebReturn("#error=denied"), { error: "denied" });
  assert.deepEqual(readWebReturn("#error=failed"), { error: "failed" });
  // An address without a sign-in return is not one that failed.
  for (const hash of ["", "#", "#mine", "#/ticket=x", "?ticket=" + TICKET, "ticket=" + TICKET, "# ticket=" + TICKET, "#Ticket=" + TICKET]) {
    assert.equal(readWebReturn(hash), null, JSON.stringify(hash));
  }
  const failed = [
    "#ticket=", `#ticket=${TICKET.slice(1)}`, `#ticket=${TICKET}A`, `#ticket=${TICKET}&x=1`, `#ticket=${TICKET}#`, `#ticket=${TICKET} `,
    `#ticket=${TICKET.slice(1)}+`, `#ticket=${TICKET}&ticket=${TICKET}`, "#error=", "#error=other", "#error=denied&x=1", `#error=denied&ticket=${TICKET}`,
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
