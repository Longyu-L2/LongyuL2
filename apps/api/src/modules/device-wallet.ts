import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAddress, isAddress, type Hex } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { authenticate, clientAddress, consumeChallenge, createChallenge, currentDay, loadUser, setTier, type Deps } from "../context.ts";
import type { Queryable } from "../db/index.ts";
import { ANDROID_KEY_TOKEN_PREFIX } from "../services/android-attestation.ts";
import type { AttestOutcome } from "../services/attestation.ts";
import { badRequest, conflict, forbidden, tooMany, uuid } from "../lib/util.ts";
import { AppVerifier, LoginToken, redeemTicket, webMiningOff } from "./auth.ts";

const WALLET_CHANGE_COOLDOWN = 7n * 86_400n;
/** Failed attestations per device before a 24-hour lock (checked before calling Google or Apple). */
export const ATTESTATION_FAILURE_LOCK = 10;
/** Push tokens kept per user; registering another drops the oldest. */
export const MAX_PUSH_TOKENS = 5;

/**
 * Plausible attestation token: base64 or base64url, within size bounds. Saves pointless vendor calls.
 * An Android key attestation is such a token behind its "akey:" prefix (certificates joined by ".").
 */
export const tokenLooksValid = (t: string): boolean =>
  /^dev:[0-9a-f]+$/.test(t) ||
  /^[A-Za-z0-9+/=_.-]{100,20000}$/.test(t.startsWith(ANDROID_KEY_TOKEN_PREFIX) ? t.slice(ANDROID_KEY_TOKEN_PREFIX.length) : t);

export interface DeviceRow {
  id: string;
  /** "web" is a browser (WEB_MINING): it has no hardware to check and passes a human check instead. */
  platform: "ios" | "android" | "web";
  attested_at: bigint | null;
  attestation_key_id: string | null;
  attestation_public_key: string | null;
  attestation_sign_count: bigint;
  attestation_failures: number;
  attestation_locked_until: bigint;
}

export async function loadDevice(q: Queryable, userId: string, deviceId: string): Promise<DeviceRow> {
  const d = (await q.query<DeviceRow>("SELECT * FROM devices WHERE id = $1 AND user_id = $2", [deviceId, userId])).rows[0];
  if (!d) throw badRequest("device_unknown");
  return d;
}

export function assertDeviceNotLocked(deps: Deps, d: DeviceRow): void {
  if (d.attestation_locked_until > deps.clock.now()) throw tooMany("device_locked", "Too many failed device checks. Try again tomorrow.");
}

/** A browser's device stops working the moment web mining is switched off. */
export function assertWebMiningOn(deps: Deps, d: DeviceRow): void {
  if (d.platform === "web" && !deps.config.WEB_MINING) throw webMiningOff();
}

/** Records a failed attestation in its own committed statement, locking the device after too many. */
export async function recordAttestationFailure(deps: Deps, deviceId: string): Promise<void> {
  await deps.db.query(
    `UPDATE devices SET attestation_failures = attestation_failures + 1,
       attestation_locked_until = CASE WHEN attestation_failures + 1 >= $2 THEN $3 ELSE attestation_locked_until END
     WHERE id = $1`,
    [deviceId, ATTESTATION_FAILURE_LOCK, deps.clock.now() + 86_400n],
  );
}

export function registerDeviceAndWallet(app: FastifyInstance, deps: Deps): void {
  // ------------------------------------------------------------ attestation

  app.post("/v1/device/challenge", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const auth = await authenticate(deps, req);
    const device = await loadDevice(deps.db, auth.userId, auth.deviceId);
    assertWebMiningOn(deps, device);
    assertDeviceNotLocked(deps, device);
    // humanCheck: whether a browser must pass the human check before /v1/device/attest.
    return { ...(await createChallenge(deps.db, deps, auth.userId, "attest")), humanCheck: !deps.config.HUMAN_CHECK_OFF };
  });

  app.post("/v1/device/attest", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const auth = await authenticate(deps, req);
    const body = z
      .object({ challengeId: z.uuid(), token: z.string().min(4).max(20_000), keyId: z.string().max(200).optional() })
      .parse(req.body);
    const device = await loadDevice(deps.db, auth.userId, auth.deviceId);
    assertWebMiningOn(deps, device);
    assertDeviceNotLocked(deps, device);
    // The challenge is spent in its own committed statement, so a failure below cannot revive it.
    const challenge = await consumeChallenge(deps.db, deps, auth.userId, "attest", { id: body.challengeId });
    // The vendor call happens outside any transaction, so it never holds a database connection.
    let result: AttestOutcome;
    if (device.platform === "web" && deps.config.HUMAN_CHECK_OFF) {
      // The human check is switched off: a signed-in browser is accepted as it is.
      result = { ok: true };
    } else if (device.platform === "web") {
      // A browser has no hardware to check: `token` is a human check's token, and no key is kept.
      result = (await deps.captcha.verify(body.token, clientAddress(deps, req))) ? { ok: true } : { ok: false, reason: "human check failed" };
    } else {
      result = tokenLooksValid(body.token)
        ? await deps.attestation.attest({ platform: device.platform, token: body.token, nonce: challenge.nonce, keyId: body.keyId })
        : { ok: false, reason: "malformed token" };
    }
    if (!result.ok) {
      await recordAttestationFailure(deps, auth.deviceId);
      return { attested: false, reason: result.reason };
    }
    return deps.db.tx(async (q) => {
      await q.query(
        `UPDATE devices SET attested_at = $1, attestation_key_id = $2, attestation_public_key = $3,
         attestation_sign_count = $4, attestation_failures = 0 WHERE id = $5`,
        [deps.clock.now(), result.keyId ?? null, result.publicKey ?? null, result.signCount ?? 0n, auth.deviceId],
      );
      const user = await loadUser(q, auth.userId);
      if (user.tier === 0 && !user.banned) await setTier(q, deps, auth.userId, 1, device.platform === "web" ? "web_checked" : "device_attested");
      return { attested: true };
    });
  });

  // ------------------------------------------------------------------ wallet

  app.post("/v1/wallet/challenge", async (req) => {
    const auth = await authenticate(deps, req);
    const c = await createChallenge(deps.db, deps, auth.userId, "siwe");
    return { nonce: c.nonce, domain: deps.config.SIWE_DOMAIN, chainId: Number(deps.config.CHAIN_ID), expiresAt: c.expiresAt };
  });

  /**
   * Links a wallet with a Sign-In with Ethereum message. Changing an existing wallet also needs a
   * fresh sign-in with X (a ticket from a "wallet-change" flow this user started, for the same X
   * account), waits out a 7-day cooldown and takes effect at the next settlement. Every change is
   * kept in wallet_changes, and the account's devices get a push notice.
   */
  app.post("/v1/wallet/link", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const auth = await authenticate(deps, req);
    const body = z
      .object({
        message: z.string().max(2000),
        signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
        reauthTicket: LoginToken.optional(),
        appVerifier: AppVerifier.optional(),
      })
      .parse(req.body);
    const parsed = parseSiweMessage(body.message);
    if (!parsed.address || !parsed.nonce || !isAddress(parsed.address)) throw badRequest("siwe_invalid");
    const address = getAddress(parsed.address);
    const now = new Date(Number(deps.clock.now()) * 1000);
    if (
      !validateSiweMessage({ message: parsed, domain: deps.config.SIWE_DOMAIN, address, time: now }) ||
      BigInt(parsed.chainId ?? 0) !== deps.config.CHAIN_ID
    ) {
      throw badRequest("siwe_invalid");
    }
    if (!(await deps.chain.verifySignature(address, body.message, body.signature as Hex))) throw forbidden("signature_invalid");

    const result = await deps.db.tx(async (q) => {
      const user = await loadUser(q, auth.userId);
      if (user.banned) return { error: forbidden("account_restricted") };
      await consumeChallenge(q, deps, auth.userId, "siwe", { nonce: parsed.nonce });
      const current = (await q.query<{ address: string; change_available_at: bigint }>(
        "SELECT address, change_available_at FROM wallets WHERE user_id = $1 FOR UPDATE",
        [auth.userId],
      )).rows[0];
      if (current?.address === address) return { address, changed: false };
      const taken = await q.query(
        `SELECT 1 FROM wallets WHERE address = $1
         UNION SELECT 1 FROM wallet_changes WHERE from_address = $1 OR to_address = $1
         UNION SELECT 1 FROM ledger_accounts WHERE address = $1`,
        [address],
      );
      if (taken.rows.length > 0) return { error: conflict("wallet_in_use", "This wallet is already used by LONGYU") };
      const t = deps.clock.now();
      if (!current) {
        await q.query("INSERT INTO wallets (user_id, address, linked_at, change_available_at) VALUES ($1,$2,$3,$4)", [
          auth.userId, address, t, t + WALLET_CHANGE_COOLDOWN,
        ]);
        return { address, changed: false };
      }
      if (t < current.change_available_at) {
        return { error: forbidden("wallet_change_cooldown", `Wallet can change after ${current.change_available_at}`) };
      }
      // A stolen session alone cannot move the wallet: the person signs in with X again.
      if (!body.reauthTicket || !body.appVerifier) {
        return { error: forbidden("reauth_required", "Changing your wallet needs a fresh sign-in with X") };
      }
      const account = await redeemTicket(q, deps, {
        ticket: body.reauthTicket, appVerifier: body.appVerifier, purpose: "wallet-change", userId: auth.userId,
      });
      // Commit the failed check (the ticket stays used) and report it.
      if (!account || account.id !== user.x_id) return { error: forbidden("reauth_invalid") };
      await q.query(
        "INSERT INTO wallet_changes (id, user_id, from_address, to_address, effective_day, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [uuid(), auth.userId, current.address, address, currentDay(deps), t],
      );
      await q.query("UPDATE wallets SET address = $1, linked_at = $2, change_available_at = $3 WHERE user_id = $4", [
        address, t, t + WALLET_CHANGE_COOLDOWN, auth.userId,
      ]);
      return { address, changed: true };
    });
    if ("error" in result && result.error) throw result.error;
    if (result.changed) {
      // Every device of the account hears about it: a change the owner did not make must not pass unnoticed.
      const tokens = (await deps.db.query<{ token: string }>("SELECT token FROM push_tokens WHERE user_id = $1", [auth.userId])).rows;
      await deps.push
        .send(tokens.map((t) => ({ to: t.token, title: "Rewards wallet changed", body: "Your LONGYU rewards wallet was changed. If this was not you, contact support now." })))
        .catch(() => undefined);
    }
    return { address: result.address, changed: result.changed };
  });

  app.post("/v1/push/register", async (req) => {
    const auth = await authenticate(deps, req);
    const { token } = z.object({ token: z.string().regex(/^ExponentPushToken\[[A-Za-z0-9_-]+\]$/) }).parse(req.body);
    await deps.db.tx(async (q) => {
      // One registration at a time per user, so the count below is exact.
      await q.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [auth.userId]);
      await q.query(
        `INSERT INTO push_tokens (user_id, token, created_at) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, token) DO UPDATE SET created_at = EXCLUDED.created_at`,
        [auth.userId, token, deps.clock.now()],
      );
      // A user keeps the newest few: the oldest go first. Ties (same second) fall on the token text.
      await q.query(
        `DELETE FROM push_tokens WHERE user_id = $1 AND token NOT IN
           (SELECT token FROM push_tokens WHERE user_id = $1 ORDER BY created_at DESC, token DESC LIMIT $2)`,
        [auth.userId, MAX_PUSH_TOKENS],
      );
    });
    return { ok: true };
  });
}
