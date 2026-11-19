import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import {
  ANDROID_KEY_TOKEN_PREFIX, GOOGLE_ROOT_KEYS, androidKeyAttestation, googleRevocationList, parseKeyDescription, type RevocationList,
} from "../src/services/android-attestation.ts";

// ------------------------------------------------------- Google's samples

const DIR = new URL("./fixtures/android-key-attestation/", import.meta.url);
interface Sample {
  name: string;
  b64: string[];
  certs: X509Certificate[];
  meta: {
    attestationSecurityLevel: string;
    attestationChallenge: string;
    softwareEnforced: { creationDateTime?: string; attestationApplicationId?: { packages: { name: string }[]; signatures: string[] } };
    hardwareEnforced: { origin?: string; rootOfTrust?: { deviceLocked: boolean; verifiedBootState: string } };
  } | null;
}
function load(name: string): Sample {
  const pem = readFileSync(new URL(`${name}.pem`, DIR), "utf8");
  const b64 = [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((m) => m[1]!.replace(/\s+/g, ""));
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(new URL(`${name}.json`, DIR), "utf8").replace(/(^|\s)\/\/.*$/gm, ""));
  } catch {
    // invalid samples have no description
  }
  return { name, b64, certs: b64.map((b) => new X509Certificate(Buffer.from(b, "base64"))), meta };
}
const samples = readdirSync(DIR).filter((f) => f.endsWith(".pem")).map((f) => load(f.replace(/\.pem$/, "")));
const sample = (name: string) => samples.find((s) => s.name === name)!;
const token = (b64: string[]) => ANDROID_KEY_TOKEN_PREFIX + b64.join(".");
const noRevocations: RevocationList = { revoked: async () => new Set() };
/** When the chain was made: its creation time, or just after its intermediates became valid. */
const madeAt = (s: Sample) => s.meta?.softwareEnforced.creationDateTime
  ? new Date(Number(s.meta.softwareEnforced.creationDateTime))
  : new Date(Math.max(...s.certs.slice(1, -1).map((c) => Date.parse(c.validFrom))) + 86_400_000);
function verifierFor(s: Sample, over: Partial<Parameters<typeof androidKeyAttestation>[0]> = {}) {
  const app = s.meta!.softwareEnforced.attestationApplicationId!;
  return androidKeyAttestation({
    packageName: app.packages[0]!.name,
    signingCertDigests: app.signatures.map((d) => Buffer.from(d, "base64").toString("hex")),
    revocation: noRevocations,
    now: () => madeAt(s),
    ...over,
  });
}
const nonceOf = (s: Sample) => Buffer.from(s.meta!.attestationChallenge, "base64").toString("utf8");

test("Google's two root keys are the RSA root and the 2026 EC root", () => {
  assert.deepEqual([...GOOGLE_ROOT_KEYS].sort(), [
    "3ee44512a1af2beb39c889490c60ea3f82e43f5d5a5532f5ab9419f676cd07ec",
    "feb2ea7551ee316ed4bb443c8293b884dbfdea40b603ee3e4f4a897e4580fbae",
  ]);
});

test("real chains from locked devices with verified boot are accepted, on both roots", async () => {
  for (const name of ["caiman_sdk36_TEE_EC_RKP", "tegu_sdk36_TEE_EC_2026_ROOT", "tegu_sdk36_SB_EC_2026_ROOT", "frankel_sdk37_TEE_EC_2026"]) {
    const s = sample(name);
    const r = await verifierFor(s).verify(token(s.b64), nonceOf(s));
    assert.ok(r.ok, `${name}: ${JSON.stringify(r)}`);
    assert.equal(r.ok && r.securityLevel, s.meta!.attestationSecurityLevel === "STRONG_BOX" ? "strongbox" : "tee");
  }
});

test("the parsed key description matches Google's own description of each chain", () => {
  for (const s of samples.filter((x) => x.meta)) {
    const kd = parseKeyDescription(keyDescriptionDer(s.certs[0]!));
    const m = s.meta!;
    assert.ok(kd.challenge.equals(Buffer.from(m.attestationChallenge, "base64")), s.name);
    assert.equal(kd.securityLevel, { TRUSTED_ENVIRONMENT: "tee", STRONG_BOX: "strongbox", SOFTWARE: "software" }[m.attestationSecurityLevel], s.name);
    const app = m.softwareEnforced.attestationApplicationId!;
    assert.deepEqual(kd.packages, app.packages.map((p) => p.name), s.name);
    assert.deepEqual(kd.signatureDigests, app.signatures.map((d) => Buffer.from(d, "base64").toString("hex")), s.name);
    assert.equal(kd.deviceLocked, m.hardwareEnforced.rootOfTrust!.deviceLocked, s.name);
    assert.equal(kd.bootState, m.hardwareEnforced.rootOfTrust!.verifiedBootState.toLowerCase().replace("_", "-"), s.name);
    assert.equal(kd.origin, m.hardwareEnforced.origin === "GENERATED" ? 0 : kd.origin, s.name);
  }
});

test("unlocked devices and Google's malformed samples are refused", async () => {
  for (const [name, when] of [["akita_sdk34_TEE_EC_NONE", undefined], ["walleye_sdk27_TEE_EC_NONE", new Date("2020-01-01")]] as const) {
    const s = sample(name);
    const r = await verifierFor(s, when ? { now: () => when } : {}).verify(token(s.b64), nonceOf(s));
    assert.deepEqual(r, { ok: false, reason: "device bootloader unlocked" }, name);
  }
  // That 2017 device's factory certificates expired on 24 May 2026: it can no longer attest at all.
  const old = sample("walleye_sdk27_TEE_EC_NONE");
  assert.deepEqual(await verifierFor(old, { now: () => new Date("2026-11-17") }).verify(token(old.b64), nonceOf(old)), { ok: false, reason: "certificate 1 out of date" });
  const lenient = androidKeyAttestation({ packageName: "x", signingCertDigests: [], revocation: noRevocations, now: () => new Date("2025-01-01") });
  for (const name of ["invalid_malformed_rot_device_locked", "invalid_tags_not_in_ascending_order"]) {
    const s = sample(name);
    const r = await lenient.verify(token(s.b64), "anything");
    assert.equal(r.ok, false, name);
  }
  // Parsing alone, independent of the chain checks.
  assert.throws(() => parseKeyDescription(keyDescriptionDer(sample("invalid_malformed_rot_device_locked").certs[0]!)), /device locked/);
});

test("tampering with the request or the chain is refused", async () => {
  const s = sample("tegu_sdk36_TEE_EC_2026_ROOT");
  const v = verifierFor(s);
  const nonce = nonceOf(s);
  const reason = async (t: string, n = nonce, verifier = v) => {
    const r = await verifier.verify(t, n);
    assert.equal(r.ok, false);
    return (r as { reason: string }).reason;
  };
  assert.equal(await reason(token(s.b64), `${nonce}x`), "challenge mismatch");
  assert.equal(await reason(token(s.b64), nonce, verifierFor(s, { packageName: "app.longyu.mine" })), "wrong app package");
  assert.equal(await reason(token(s.b64), nonce, verifierFor(s, { signingCertDigests: ["00".repeat(32)] })), "app not signed with the LONGYU key");
  assert.equal(await reason(token([...s.b64].reverse())), "certificate 0 not signed by its issuer");
  assert.equal(await reason(token(s.b64.slice(0, -1))), "certificate 3 not signed by its issuer");
  assert.equal(await reason(token(s.b64.slice(1))), "no key description");
  assert.equal(await reason(token([s.b64[0]!])), "bad chain length");
  assert.equal(await reason(`${token(s.b64)}.${s.b64[0]}`), "certificate 4 not signed by its issuer");
  assert.equal(await reason(token(s.b64), nonce, verifierFor(s, { now: () => new Date("2100-01-01") })), "certificate 1 out of date");
  assert.equal(await reason(s.b64.join(".")), "not a key attestation");
  assert.equal(await reason(token(["!!!", ...s.b64.slice(1)])), "unreadable certificate");
  // A flipped byte in the leaf's signed part breaks its signature.
  const leaf = Buffer.from(s.b64[0]!, "base64");
  const at = leaf.length - 120;
  leaf.writeUInt8(leaf.readUInt8(at) ^ 0x01, at);
  const flipped = await reason(token([leaf.toString("base64"), ...s.b64.slice(1)]));
  assert.ok(/not signed|unreadable|malformed/.test(flipped), flipped);
  // A revoked intermediate, in the list's lower-case hex form.
  const serial = s.certs[1]!.serialNumber.toLowerCase().replace(/^0+/, "");
  assert.equal(await reason(token(s.b64), nonce, verifierFor(s, { revocation: { revoked: async () => new Set([serial]) } })), "certificate revoked");
  assert.equal(await reason(token(s.b64), nonce, verifierFor(s, { revocation: { revoked: async () => { throw new Error("down"); } } })), "revocation list unavailable");
});

test("the revocation list is cached, survives an outage for two days, and normalises serials", async () => {
  let now = 1_000_000;
  let calls = 0;
  let up = true;
  const fetchImpl = (async () => {
    calls++;
    if (!up) throw new Error("network down");
    return new Response(JSON.stringify({ entries: { "00AbC1": { status: "REVOKED" }, "123": { status: "REVOKED" } } }), { status: 200 });
  }) as typeof fetch;
  const list = googleRevocationList(fetchImpl, () => now);
  assert.deepEqual([...(await list.revoked())].sort(), ["123", "abc1"]);
  await list.revoked();
  assert.equal(calls, 1, "cached for an hour");
  now += 2 * 3_600_000;
  up = false;
  assert.ok((await list.revoked()).has("abc1"), "stale copy during an outage");
  now += 47 * 3_600_000;
  await assert.rejects(list.revoked(), /network down/);
  const never = googleRevocationList((async () => { throw new Error("offline"); }) as typeof fetch);
  await assert.rejects(never.revoked(), /offline/);
});

// ------------------------------------------------------ synthetic chains

const der = {
  tlv(tag: number[], body: Buffer): Buffer {
    const n = body.length;
    const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
    return Buffer.concat([Buffer.from(tag), Buffer.from(len), body]);
  },
  seq: (...xs: Buffer[]) => der.tlv([0x30], Buffer.concat(xs)),
  set: (...xs: Buffer[]) => der.tlv([0x31], Buffer.concat(xs)),
  int(n: number): Buffer {
    const bytes: number[] = [];
    do { bytes.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0);
    if (bytes[0]! & 0x80) bytes.unshift(0);
    return der.tlv([0x02], Buffer.from(bytes));
  },
  enum: (n: number) => Buffer.from([0x0a, 0x01, n]),
  bool: (b: boolean) => Buffer.from([0x01, 0x01, b ? 0xff : 0x00]),
  octets: (b: Buffer) => der.tlv([0x04], b),
  oid: (bytes: number[]) => der.tlv([0x06], Buffer.from(bytes)),
  utf8: (s: string) => der.tlv([0x0c], Buffer.from(s, "utf8")),
  time: (d: Date) => der.tlv([0x17], Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z")),
  bits: (b: Buffer) => der.tlv([0x03], Buffer.concat([Buffer.from([0]), b])),
  /** [n] EXPLICIT, using the high-tag form above 30. */
  ctx(n: number, body: Buffer): Buffer {
    if (n < 31) return der.tlv([0xa0 | n], body);
    const t: number[] = [];
    for (let v = n; v > 0; v = Math.floor(v / 128)) t.unshift((v & 0x7f) | (t.length ? 0x80 : 0));
    return der.tlv([0xbf, ...t], body);
  },
};
const ECDSA_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const KEY_DESCRIPTION = [0x2b, 0x06, 0x01, 0x04, 0x01, 0xd6, 0x79, 0x02, 0x01, 0x11];
const name = (cn: string) => der.seq(der.set(der.seq(der.oid([0x55, 0x04, 0x03]), der.utf8(cn))));

function cert(o: { subject: string; issuer: string; key: KeyObject; signer: KeyObject; serial: number; extensions?: Buffer[]; ca?: boolean }): string {
  const exts = [...(o.extensions ?? [])];
  if (o.ca) exts.push(der.seq(der.oid([0x55, 0x1d, 0x13]), der.bool(true), der.octets(der.seq(der.bool(true)))));
  const tbs = der.seq(
    der.ctx(0, der.int(2)), der.int(o.serial), der.seq(der.oid(ECDSA_SHA256)), name(o.issuer),
    der.seq(der.time(new Date("2025-01-01")), der.time(new Date("2045-01-01"))), name(o.subject),
    o.key.export({ type: "spki", format: "der" }),
    ...(exts.length ? [der.ctx(3, der.seq(...exts))] : []),
  );
  return der.seq(tbs, der.seq(der.oid(ECDSA_SHA256)), der.bits(sign("sha256", tbs, o.signer))).toString("base64");
}

function keyDescription(o: { challenge: string; level?: number; pkg?: string; digest?: string; locked?: boolean; boot?: number; origin?: number; rootOfTrust?: boolean }): Buffer {
  const appId = der.seq(der.set(der.seq(der.octets(Buffer.from(o.pkg ?? "app.longyu.mine")), der.int(7))), der.set(der.octets(Buffer.from(o.digest ?? "ab".repeat(32), "hex"))));
  const hw = [der.ctx(702, der.int(o.origin ?? 0))];
  if (o.rootOfTrust !== false) hw.push(der.ctx(704, der.seq(der.octets(Buffer.alloc(32)), der.bool(o.locked ?? true), der.enum(o.boot ?? 0), der.octets(Buffer.alloc(32)))));
  const level = o.level ?? 1;
  return der.seq(der.int(300), der.enum(level), der.int(300), der.enum(level), der.octets(Buffer.from(o.challenge)), der.octets(Buffer.alloc(0)),
    der.seq(der.ctx(709, der.octets(appId))), der.seq(...hw));
}
const kdExtension = (kd: Buffer) => der.seq(der.oid(KEY_DESCRIPTION), der.octets(kd));

/** A root, a batch intermediate and a leaf: the shape of a real chain, under a test root. */
function chain(kd: Parameters<typeof keyDescription>[0]) {
  const k = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const root = k();
  const batch = k();
  const leaf = k();
  const b64 = [
    cert({ subject: "leaf", issuer: "batch", key: leaf.publicKey, signer: batch.privateKey, serial: 3, extensions: [kdExtension(keyDescription(kd))] }),
    cert({ subject: "batch", issuer: "root", key: batch.publicKey, signer: root.privateKey, serial: 2, ca: true }),
    cert({ subject: "root", issuer: "root", key: root.publicKey, signer: root.privateKey, serial: 1, ca: true }),
  ];
  const rootKey = createHash("sha256").update(root.publicKey.export({ type: "spki", format: "der" })).digest("hex");
  return { b64, rootKey, leaf };
}
const testVerifier = (rootKey: string, extra: Partial<Parameters<typeof androidKeyAttestation>[0]> = {}) =>
  androidKeyAttestation({ packageName: "app.longyu.mine", signingCertDigests: ["AB:".repeat(31) + "AB"], revocation: noRevocations, extraRootKeys: [rootKey], now: () => new Date("2026-11-17"), ...extra });

test("synthetic chains: only secure hardware, generated keys, locked devices and verified boot pass", async () => {
  const ok = chain({ challenge: "nonce-1" });
  assert.deepEqual(await testVerifier(ok.rootKey).verify(token(ok.b64), "nonce-1"), { ok: true, securityLevel: "tee", bootState: "verified" });
  // Without the test root the same chain is not trusted.
  const plain = androidKeyAttestation({ packageName: "app.longyu.mine", signingCertDigests: ["ab".repeat(32)], revocation: noRevocations });
  assert.deepEqual(await plain.verify(token(ok.b64), "nonce-1"), { ok: false, reason: "not a Google attestation root" });

  const cases: [Parameters<typeof keyDescription>[0], string][] = [
    [{ challenge: "n", level: 0 }, "key not in secure hardware (software)"],
    [{ challenge: "n", origin: 2 }, "key not generated on the device"],
    [{ challenge: "n", locked: false }, "device bootloader unlocked"],
    [{ challenge: "n", boot: 1 }, "boot not verified (self-signed)"],
    [{ challenge: "n", boot: 2 }, "boot not verified (unverified)"],
    [{ challenge: "n", rootOfTrust: false }, "device bootloader unlocked"],
    [{ challenge: "n", pkg: "com.attacker.app" }, "wrong app package"],
    [{ challenge: "n", digest: "cd".repeat(32) }, "app not signed with the LONGYU key"],
  ];
  for (const [kd, reason] of cases) {
    const c = chain(kd);
    assert.deepEqual(await testVerifier(c.rootKey).verify(token(c.b64), "n"), { ok: false, reason }, reason);
  }
});

test("an attested app key cannot sign a forged attestation below itself", async () => {
  // The attacker's genuine attested key (a real leaf) signs a fake certificate claiming a perfect device.
  const real = chain({ challenge: "nonce-2", locked: false, boot: 2 });
  const fake = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const forged = cert({ subject: "fake", issuer: "leaf", key: fake.publicKey, signer: real.leaf.privateKey, serial: 9, extensions: [kdExtension(keyDescription({ challenge: "nonce-2" }))] });
  const r = await testVerifier(real.rootKey).verify(token([forged, ...real.b64]), "nonce-2");
  assert.deepEqual(r, { ok: false, reason: "key description above the leaf" });
});

/** The key description extension's value, found the same way the verifier finds it. */
function keyDescriptionDer(c: X509Certificate): Buffer {
  const raw = c.raw;
  const oid = Buffer.from([0x06, 0x0a, ...KEY_DESCRIPTION]);
  const at = raw.indexOf(oid);
  assert.ok(at > 0, "extension present");
  // OID, then an optional critical flag, then the OCTET STRING holding the value.
  let p = at + oid.length;
  if (raw[p] === 0x01) p += 3;
  assert.equal(raw[p], 0x04);
  let len = raw[p + 1]!;
  let start = p + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + raw[p + 2 + i]!;
    start = p + 2 + n;
  }
  return raw.subarray(start, start + len);
}

test("the API's attestation router sends key-attestation tokens to the verifier", async () => {
  const { createAttestation } = await import("../src/services/attestation.ts");
  const c = chain({ challenge: "nonce-3" });
  const withKey = createAttestation({ allowDev: false, androidKey: testVerifier(c.rootKey) });
  const device = { keyId: null, publicKey: null, signCount: 0n };
  assert.deepEqual(await withKey.attest({ platform: "android", token: token(c.b64), nonce: "nonce-3" }), { ok: true });
  assert.deepEqual(await withKey.assert({ platform: "android", token: token(c.b64), nonce: "nonce-3", device }), { ok: true });
  assert.deepEqual(await withKey.attest({ platform: "android", token: token(c.b64), nonce: "other" }), { ok: false, reason: "challenge mismatch" });
  assert.deepEqual(await withKey.attest({ platform: "android", token: "play-integrity-token", nonce: "n" }), { ok: false, reason: "Play Integrity not configured" });
  assert.deepEqual(await withKey.attest({ platform: "android", token: "dev:n", nonce: "n" }), { ok: false, reason: "Play Integrity not configured" }, "no dev tokens unless allowed");
  const none = createAttestation({ allowDev: false });
  assert.deepEqual(await none.attest({ platform: "android", token: token(c.b64), nonce: "nonce-3" }), { ok: false, reason: "Android key attestation not configured" });
});
