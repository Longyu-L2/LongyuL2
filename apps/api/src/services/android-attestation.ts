/**
 * Android hardware key attestation, for an app distributed outside Google Play.
 *
 * The app generates a key in the Android Keystore with the server's nonce as the attestation
 * challenge, and sends the certificate chain. The chain proves, from the device's secure hardware:
 * - it ends at one of Google's attestation root keys, and no certificate in it is revoked;
 * - the key was generated in a Trusted Execution Environment or StrongBox, with our nonce;
 * - the requesting app is our package, signed with our signing key;
 * - the device is locked, with verified boot (no unlocked bootloader or modified OS).
 * Reference: developer.android.com/privacy-and-security/security-key-attestation
 */
import { X509Certificate, createHash } from "node:crypto";

/** Google's attestation roots: the RSA root (several certificates, one key) and the EC root used from 1 February 2026. */
const GOOGLE_ROOTS = [
  `-----BEGIN CERTIFICATE-----
MIIFHDCCAwSgAwIBAgIJAPHBcqaZ6vUdMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV
BAUTEGY5MjAwOWU4NTNiNmIwNDUwHhcNMjIwMzIwMTgwNzQ4WhcNNDIwMzE1MTgw
NzQ4WjAbMRkwFwYDVQQFExBmOTIwMDllODUzYjZiMDQ1MIICIjANBgkqhkiG9w0B
AQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xUFmOr75gvMsd/dTEDDJdS
Sxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5jlRfdnJLmN0pTy/4lj4/7
tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y//0rb+T+W8a9nsNL/ggj
nar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73XpXyTqRxB/M0n1n/W9nGq
C4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYImQQcHtGl/m00QLVWutHQ
oVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB+TxywElgS70vE0XmLD+O
JtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7quvmag8jfPioyKvxnK/Eg
sTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgpZrt3i5MIlCaY504LzSRi
igHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7gLiMm0jhO2B6tUXHI/+M
RPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82ixPvZtXQpUpuL12ab+9E
aDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+NpUFgNPN9PvQi8WEg5Um
AGMCAwEAAaNjMGEwHQYDVR0OBBYEFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMB8GA1Ud
IwQYMBaAFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMA8GA1UdEwEB/wQFMAMBAf8wDgYD
VR0PAQH/BAQDAgIEMA0GCSqGSIb3DQEBCwUAA4ICAQB8cMqTllHc8U+qCrOlg3H7
174lmaCsbo/bJ0C17JEgMLb4kvrqsXZs01U3mB/qABg/1t5Pd5AORHARs1hhqGIC
W/nKMav574f9rZN4PC2ZlufGXb7sIdJpGiO9ctRhiLuYuly10JccUZGEHpHSYM2G
tkgYbZba6lsCPYAAP83cyDV+1aOkTf1RCp/lM0PKvmxYN10RYsK631jrleGdcdkx
oSK//mSQbgcWnmAEZrzHoF1/0gso1HZgIn0YLzVhLSA/iXCX4QT2h3J5z3znluKG
1nv8NQdxei2DIIhASWfu804CA96cQKTTlaae2fweqXjdN1/v2nqOhngNyz1361mF
mr4XmaKH/ItTwOe72NI9ZcwS1lVaCvsIkTDCEXdm9rCNPAY10iTunIHFXRh+7KPz
lHGewCq/8TOohBRn0/NNfh7uRslOSZ/xKbN9tMBtw37Z8d2vvnXq/YWdsm1+JLVw
n6yYD/yacNJBlwpddla8eaVMjsF6nBnIgQOf9zKSe06nSTqvgwUHosgOECZJZ1Eu
zbH4yswbt02tKtKEFhx+v+OTge/06V+jGsqTWLsfrOCNLuA8H++z+pUENmpqnnHo
vaI47gC+TNpkgYGkkBT6B/m/U01BuOBBTzhIlMEZq9qkDWuM2cA5kW5V3FJUcfHn
w1IdYIg2Wxg7yHcQZemFQg==
-----END CERTIFICATE-----`,
  `-----BEGIN CERTIFICATE-----
MIICIjCCAaigAwIBAgIRAISp0Cl7DrWK5/8OgN52BgUwCgYIKoZIzj0EAwMwUjEc
MBoGA1UEAwwTS2V5IEF0dGVzdGF0aW9uIENBMTEQMA4GA1UECwwHQW5kcm9pZDET
MBEGA1UECgwKR29vZ2xlIExMQzELMAkGA1UEBhMCVVMwHhcNMjUwNzE3MjIzMjE4
WhcNMzUwNzE1MjIzMjE4WjBSMRwwGgYDVQQDDBNLZXkgQXR0ZXN0YXRpb24gQ0Ex
MRAwDgYDVQQLDAdBbmRyb2lkMRMwEQYDVQQKDApHb29nbGUgTExDMQswCQYDVQQG
EwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABCPaI3FO3z5bBQo8cuiEas4HjqCt
G/mLFfRT0MsIssPBEEU5Cfbt6sH5yOAxqEi5QagpU1yX4HwnGb7OtBYpDTB57uH5
Eczm34A5FNijV3s0/f0UPl7zbJcTx6xwqMIRq6NCMEAwDwYDVR0TAQH/BAUwAwEB
/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFFIyuyz7RkOb3NaBqQ5lZuA0QepA
MAoGCCqGSM49BAMDA2gAMGUCMETfjPO/HwqReR2CS7p0ZWoD/LHs6hDi422opifH
EUaYLxwGlT9SLdjkVpz0UUOR5wIxAIoGyxGKRHVTpqpGRFiJtQEOOTp/+s1GcxeY
uR2zh/80lQyu9vAFCj6E4AXc+osmRg==
-----END CERTIFICATE-----`,
];

const spkiHash = (cert: X509Certificate) =>
  createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("hex");
export const GOOGLE_ROOT_KEYS = new Set(GOOGLE_ROOTS.map((pem) => spkiHash(new X509Certificate(pem))));

// ------------------------------------------------------------------- DER

interface Tlv {
  cls: number;
  constructed: boolean;
  tag: number;
  value: Buffer;
  end: number;
}

class DerError extends Error {}

/** Reads one DER element, strictly: definite lengths only, minimal length encoding, no truncation. */
function readTlv(buf: Buffer, pos: number): Tlv {
  if (pos >= buf.length) throw new DerError("truncated");
  const b0 = buf[pos]!;
  let p = pos + 1;
  let tag = b0 & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    let b: number;
    let n = 0;
    do {
      if (p >= buf.length || ++n > 4) throw new DerError("bad tag");
      b = buf[p++]!;
      tag = tag * 128 + (b & 0x7f);
    } while (b & 0x80);
  }
  if (p >= buf.length) throw new DerError("truncated");
  let len = buf[p++]!;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new DerError("bad length");
    len = 0;
    for (let i = 0; i < n; i++) {
      if (p >= buf.length) throw new DerError("truncated");
      len = len * 256 + buf[p++]!;
    }
    if (len < 0x80) throw new DerError("non-minimal length");
  }
  const end = p + len;
  if (end > buf.length) throw new DerError("truncated value");
  return { cls: b0 >> 6, constructed: (b0 & 0x20) !== 0, tag, value: buf.subarray(p, end), end };
}

function children(value: Buffer): Tlv[] {
  const out: Tlv[] = [];
  for (let p = 0; p < value.length; ) {
    const t = readTlv(value, p);
    out.push(t);
    p = t.end;
  }
  return out;
}

const UNIVERSAL = 0;
const CONTEXT = 2;
const expect = (t: Tlv | undefined, cls: number, tag: number, what: string): Tlv => {
  if (!t || t.cls !== cls || t.tag !== tag) throw new DerError(`expected ${what}`);
  return t;
};
const seq = (t: Tlv | undefined, what: string) => {
  const s = expect(t, UNIVERSAL, 16, what);
  if (!s.constructed) throw new DerError(`expected ${what}`);
  return children(s.value);
};
function int(t: Tlv | undefined, what: string, tag = 2): number {
  const v = expect(t, UNIVERSAL, tag, what).value;
  if (v.length === 0 || v.length > 6) throw new DerError(`bad ${what}`);
  if (v[0]! & 0x80) throw new DerError(`negative ${what}`);
  return v.reduce((n, b) => n * 256 + b, 0);
}
const enumerated = (t: Tlv | undefined, what: string) => int(t, what, 10);
const octets = (t: Tlv | undefined, what: string) => expect(t, UNIVERSAL, 4, what).value;
function bool(t: Tlv | undefined, what: string): boolean {
  const v = expect(t, UNIVERSAL, 1, what).value;
  if (v.length !== 1 || (v[0] !== 0x00 && v[0] !== 0xff)) throw new DerError(`bad ${what}`);
  return v[0] === 0xff;
}

/** Context-tagged entries of a KeyMint AuthorizationList, which DER requires in ascending tag order. */
function authorizationList(t: Tlv | undefined, what: string): Map<number, Tlv> {
  const out = new Map<number, Tlv>();
  let last = -1;
  for (const e of seq(t, what)) {
    if (e.cls !== CONTEXT || !e.constructed) throw new DerError(`bad entry in ${what}`);
    if (e.tag <= last) throw new DerError(`${what} tags not in ascending order`);
    last = e.tag;
    const inner = children(e.value);
    if (inner.length !== 1) throw new DerError(`bad entry in ${what}`);
    out.set(e.tag, inner[0]!);
  }
  return out;
}

/** The value of an X.509 v3 extension, or null. */
function extension(cert: X509Certificate, oid: Buffer): Buffer | null {
  const tbs = seq(seq(readTlv(cert.raw, 0), "certificate")[0], "tbsCertificate");
  const exts = tbs.find((t) => t.cls === CONTEXT && t.tag === 3);
  if (!exts) return null;
  for (const ext of seq(children(exts.value)[0], "extensions")) {
    const parts = seq(ext, "extension");
    const id = expect(parts[0], UNIVERSAL, 6, "extension id").value;
    if (id.equals(oid)) return octets(parts[parts.length - 1], "extension value");
  }
  return null;
}

/** 1.3.6.1.4.1.11129.2.1.17, the Android key description. */
const KEY_DESCRIPTION_OID = Buffer.from([0x2b, 0x06, 0x01, 0x04, 0x01, 0xd6, 0x79, 0x02, 0x01, 0x11]);
const TAG = { origin: 702, rootOfTrust: 704, attestationApplicationId: 709 } as const;
const SECURITY_LEVEL = ["software", "tee", "strongbox"] as const;
const BOOT_STATE = ["verified", "self-signed", "unverified", "failed"] as const;

export interface KeyDescription {
  attestationVersion: number;
  securityLevel: (typeof SECURITY_LEVEL)[number] | "unknown";
  keyMintSecurityLevel: (typeof SECURITY_LEVEL)[number] | "unknown";
  challenge: Buffer;
  packages: string[];
  signatureDigests: string[];
  origin: number | null;
  deviceLocked: boolean | null;
  bootState: (typeof BOOT_STATE)[number] | "unknown" | null;
}

export function parseKeyDescription(der: Buffer): KeyDescription {
  const kd = seq(readTlv(der, 0), "key description");
  if (kd.length < 8) throw new DerError("short key description");
  const sw = authorizationList(kd[6], "softwareEnforced");
  const hw = authorizationList(kd[7], "hardwareEnforced");

  let packages: string[] = [];
  let signatureDigests: string[] = [];
  const appIdTlv = sw.get(TAG.attestationApplicationId) ?? hw.get(TAG.attestationApplicationId);
  if (appIdTlv) {
    const appId = seq(readTlv(octets(appIdTlv, "attestation application id"), 0), "attestation application id");
    const infos = expect(appId[0], UNIVERSAL, 17, "package infos");
    packages = children(infos.value).map((p) => octets(seq(p, "package info")[0], "package name").toString("utf8"));
    const sigs = expect(appId[1], UNIVERSAL, 17, "signature digests");
    signatureDigests = children(sigs.value).map((d) => octets(d, "signature digest").toString("hex"));
  }

  let deviceLocked: boolean | null = null;
  let bootState: KeyDescription["bootState"] = null;
  const rot = hw.get(TAG.rootOfTrust);
  if (rot) {
    const r = seq(rot, "root of trust");
    octets(r[0], "verified boot key");
    deviceLocked = bool(r[1], "device locked");
    bootState = BOOT_STATE[enumerated(r[2], "verified boot state")] ?? "unknown";
  }
  const level = (n: number) => SECURITY_LEVEL[n] ?? "unknown";
  return {
    attestationVersion: int(kd[0], "attestation version"),
    securityLevel: level(enumerated(kd[1], "attestation security level")),
    keyMintSecurityLevel: level(enumerated(kd[3], "keymint security level")),
    challenge: octets(kd[4], "attestation challenge"),
    packages,
    signatureDigests,
    origin: hw.has(TAG.origin) ? int(hw.get(TAG.origin), "origin") : null,
    deviceLocked,
    bootState,
  };
}

// ------------------------------------------------------------ revocation

export interface RevocationList {
  /** Lower-case hex serials without leading zeros. */
  revoked(): Promise<Set<string>>;
}

/** Google's status list, cached; a stale copy is used for up to two days if Google is unreachable. */
export function googleRevocationList(fetchImpl: typeof fetch = fetch, nowMs: () => number = Date.now): RevocationList {
  let cache: { at: number; serials: Set<string> } | null = null;
  return {
    async revoked() {
      if (cache && nowMs() - cache.at < 3_600_000) return cache.serials;
      try {
        const res = await fetchImpl("https://android.googleapis.com/attestation/status", { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`status list: HTTP ${res.status}`);
        const body = (await res.json()) as { entries?: Record<string, unknown> };
        if (!body.entries || typeof body.entries !== "object") throw new Error("status list: no entries");
        cache = { at: nowMs(), serials: new Set(Object.keys(body.entries).map(normalSerial)) };
      } catch (e) {
        if (!cache || nowMs() - cache.at > 48 * 3_600_000) throw e;
      }
      return cache.serials;
    },
  };
}

const normalSerial = (hex: string) => hex.toLowerCase().replace(/^0+(?=.)/, "");

// ---------------------------------------------------------- verification

export interface AndroidKeyAttestationOptions {
  packageName: string;
  /** SHA-256 digests (hex) of the app's signing certificates; one must be present. */
  signingCertDigests: string[];
  revocation: RevocationList;
  /** Extra trusted root keys (SPKI SHA-256 hex), for tests only. */
  extraRootKeys?: string[];
  now?: () => Date;
}

export type KeyAttestationResult = { ok: true; securityLevel: string; bootState: string | null } | { ok: false; reason: string };

/** Token format sent by the app: "akey:" followed by the chain's base64 DER certificates, leaf first, joined by ".". */
export const ANDROID_KEY_TOKEN_PREFIX = "akey:";

export function androidKeyAttestation(opts: AndroidKeyAttestationOptions) {
  const roots = new Set([...GOOGLE_ROOT_KEYS, ...(opts.extraRootKeys ?? [])]);
  const digests = new Set(opts.signingCertDigests.map((d) => d.toLowerCase().replace(/[^0-9a-f]/g, "")));
  return {
    async verify(token: string, nonce: string): Promise<KeyAttestationResult> {
      if (!token.startsWith(ANDROID_KEY_TOKEN_PREFIX)) return { ok: false, reason: "not a key attestation" };
      const parts = token.slice(ANDROID_KEY_TOKEN_PREFIX.length).split(".");
      if (parts.length < 2 || parts.length > 10) return { ok: false, reason: "bad chain length" };
      let certs: X509Certificate[];
      try {
        certs = parts.map((b64) => {
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length > 12_000) throw new Error("bad certificate encoding");
          return new X509Certificate(Buffer.from(b64, "base64"));
        });
      } catch {
        return { ok: false, reason: "unreadable certificate" };
      }
      const now = (opts.now?.() ?? new Date()).getTime();

      // 1. Every certificate signed by the next; the last is a self-signed Google root key. Trust rests on
      // the signatures: some devices encode issuer names differently from their parent's subject.
      for (let i = 0; i < certs.length; i++) {
        const issuer = certs[Math.min(i + 1, certs.length - 1)]!;
        if (!certs[i]!.verify(issuer.publicKey)) return { ok: false, reason: `certificate ${i} not signed by its issuer` };
      }
      if (!roots.has(spkiHash(certs[certs.length - 1]!))) return { ok: false, reason: "not a Google attestation root" };
      // Intermediates must be in date; the leaf's dates come from the key and the root is trusted by key.
      for (let i = 1; i < certs.length - 1; i++) {
        const c = certs[i]!;
        if (now < Date.parse(c.validFrom) || now > Date.parse(c.validTo)) return { ok: false, reason: `certificate ${i} out of date` };
      }

      // 2. Nothing in the chain revoked.
      let revoked: Set<string>;
      try {
        revoked = await opts.revocation.revoked();
      } catch {
        return { ok: false, reason: "revocation list unavailable" };
      }
      for (const c of certs) if (revoked.has(normalSerial(c.serialNumber))) return { ok: false, reason: "certificate revoked" };

      // 3. Only the leaf describes a key: no app-made attestation keys signing other certificates.
      let kd: KeyDescription;
      try {
        for (let i = 1; i < certs.length; i++) {
          if (extension(certs[i]!, KEY_DESCRIPTION_OID)) return { ok: false, reason: "key description above the leaf" };
        }
        const ext = extension(certs[0]!, KEY_DESCRIPTION_OID);
        if (!ext) return { ok: false, reason: "no key description" };
        kd = parseKeyDescription(ext);
      } catch (e) {
        return { ok: false, reason: `malformed attestation: ${e instanceof DerError ? e.message : "unparseable"}` };
      }

      // 4. What the hardware says about the key, the app and the device.
      if (kd.securityLevel !== "tee" && kd.securityLevel !== "strongbox") return { ok: false, reason: `key not in secure hardware (${kd.securityLevel})` };
      if (!kd.challenge.equals(Buffer.from(nonce, "utf8"))) return { ok: false, reason: "challenge mismatch" };
      if (kd.origin !== null && kd.origin !== 0) return { ok: false, reason: "key not generated on the device" };
      if (!kd.packages.includes(opts.packageName)) return { ok: false, reason: "wrong app package" };
      if (!kd.signatureDigests.some((d) => digests.has(d))) return { ok: false, reason: "app not signed with the LONGYU key" };
      if (kd.deviceLocked !== true) return { ok: false, reason: "device bootloader unlocked" };
      if (kd.bootState !== "verified") return { ok: false, reason: `boot not verified (${kd.bootState ?? "missing"})` };
      return { ok: true, securityLevel: kd.securityLevel, bootState: kd.bootState };
    },
  };
}
