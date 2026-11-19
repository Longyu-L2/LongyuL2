/**
 * Device attestation: proves requests come from a genuine, unmodified LONGYU app on a real device.
 * - iOS: Apple App Attest. The device's key is attested once; later requests carry assertions.
 * - Android: hardware key attestation ("akey:" tokens, see android-attestation.ts), which works for an
 *   APK installed outside Google Play; or Google Play Integrity tokens, for a Play Store build.
 * - Development: "dev:<nonce>" tokens, only when explicitly allowed outside production.
 */
import { importPKCS8, SignJWT } from "jose";
import { verifyAssertion, verifyAttestation } from "node-app-attest";
import { ANDROID_KEY_TOKEN_PREFIX, type androidKeyAttestation } from "./android-attestation.ts";

export type Platform = "ios" | "android";

export interface DeviceKey {
  keyId: string | null;
  publicKey: string | null;
  signCount: bigint;
}

export type AttestOutcome = { ok: true; keyId?: string; publicKey?: string; signCount?: bigint } | { ok: false; reason: string };

export interface AttestationVerifier {
  /** One-time registration of a device. */
  attest(input: { platform: Platform; token: string; nonce: string; keyId?: string }): Promise<AttestOutcome>;
  /** Per-request proof (session start). `device` holds what `attest` returned earlier. */
  assert(input: { platform: Platform; token: string; nonce: string; device: DeviceKey }): Promise<AttestOutcome>;
}

export const devAttestation: AttestationVerifier = {
  async attest({ token, nonce }) {
    return token === `dev:${nonce}` ? { ok: true, keyId: "dev", publicKey: "dev", signCount: 0n } : { ok: false, reason: "bad dev token" };
  },
  async assert({ token, nonce }) {
    return token === `dev:${nonce}` ? { ok: true } : { ok: false, reason: "bad dev token" };
  },
};

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export class PlayIntegrity {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly packageName: string,
    private readonly serviceAccount: ServiceAccount,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    const tokenUri = this.serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token";
    const key = await importPKCS8(this.serviceAccount.private_key, "RS256");
    const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/playintegrity" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(this.serviceAccount.client_email)
      .setAudience(tokenUri)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);
    const res = await this.fetchImpl(tokenUri, {
      signal: AbortSignal.timeout(10_000),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  /** Decodes and checks a token whose request hash (or nonce) must equal `nonce`. */
  async check(token: string, nonce: string): Promise<AttestOutcome> {
    const res = await this.fetchImpl(
      `https://playintegrity.googleapis.com/v1/${this.packageName}:decodeIntegrityToken`,
      {
        signal: AbortSignal.timeout(10_000),
        method: "POST",
        headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
        body: JSON.stringify({ integrity_token: token }),
      },
    );
    if (!res.ok) return { ok: false, reason: `decode failed: ${res.status}` };
    const body = (await res.json()) as {
      tokenPayloadExternal?: {
        requestDetails?: { requestPackageName?: string; requestHash?: string; nonce?: string; timestampMillis?: string };
        appIntegrity?: { appRecognitionVerdict?: string };
        deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
      };
    };
    const p = body.tokenPayloadExternal;
    if (!p) return { ok: false, reason: "empty payload" };
    const d = p.requestDetails ?? {};
    if (d.requestPackageName !== this.packageName) return { ok: false, reason: "wrong package" };
    if (d.requestHash !== nonce && d.nonce !== nonce) return { ok: false, reason: "nonce mismatch" };
    const age = Date.now() - Number(d.timestampMillis ?? 0);
    if (!(age >= -60_000 && age < 5 * 60_000)) return { ok: false, reason: "stale token" };
    if (p.appIntegrity?.appRecognitionVerdict !== "PLAY_RECOGNIZED") return { ok: false, reason: "app not recognized" };
    if (!p.deviceIntegrity?.deviceRecognitionVerdict?.includes("MEETS_DEVICE_INTEGRITY")) {
      return { ok: false, reason: "device integrity not met" };
    }
    return { ok: true };
  }
}

export interface AppAttestOptions {
  teamId: string;
  bundleId: string;
  allowDevelopment: boolean;
}

export function createAttestation(opts: {
  allowDev: boolean;
  playIntegrity?: PlayIntegrity;
  androidKey?: ReturnType<typeof androidKeyAttestation>;
  appAttest?: AppAttestOptions;
}): AttestationVerifier {
  /** Android: a fresh hardware-attested key per challenge, or a Play Integrity token. */
  const android = async (token: string, nonce: string): Promise<AttestOutcome> => {
    if (token.startsWith(ANDROID_KEY_TOKEN_PREFIX)) {
      if (!opts.androidKey) return { ok: false, reason: "Android key attestation not configured" };
      const r = await opts.androidKey.verify(token, nonce);
      return r.ok ? { ok: true } : r;
    }
    if (!opts.playIntegrity) return { ok: false, reason: "Play Integrity not configured" };
    return opts.playIntegrity.check(token, nonce);
  };
  return {
    async attest(input) {
      if (opts.allowDev && input.token.startsWith("dev:")) return devAttestation.attest(input);
      if (input.platform === "android") return android(input.token, input.nonce);
      if (!opts.appAttest) return { ok: false, reason: "App Attest not configured" };
      if (!input.keyId) return { ok: false, reason: "missing key id" };
      try {
        const { keyId, publicKey } = verifyAttestation({
          attestation: Buffer.from(input.token, "base64"),
          challenge: input.nonce,
          keyId: input.keyId,
          bundleIdentifier: opts.appAttest.bundleId,
          teamIdentifier: opts.appAttest.teamId,
          allowDevelopmentEnvironment: opts.appAttest.allowDevelopment,
        });
        return { ok: true, keyId, publicKey, signCount: 0n };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
    async assert(input) {
      if (opts.allowDev && input.token.startsWith("dev:")) return devAttestation.assert(input);
      if (input.platform === "android") return android(input.token, input.nonce);
      if (!opts.appAttest || !input.device.publicKey) return { ok: false, reason: "device not attested" };
      try {
        const { signCount } = verifyAssertion({
          assertion: Buffer.from(input.token, "base64"),
          payload: input.nonce,
          publicKey: input.device.publicKey,
          bundleIdentifier: opts.appAttest.bundleId,
          teamIdentifier: opts.appAttest.teamId,
          signCount: Number(input.device.signCount),
        });
        return { ok: true, signCount: BigInt(signCount) };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
  };
}
