import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import {
  authenticate,
  consumeChallenge,
  createChallenge,
  currentDay,
  loadUser,
  setTier,
  type Deps,
} from "../context.ts";
import type { Queryable } from "../db/index.ts";
import { verifyWebhookSignature, type VerificationWebhook } from "../services/external.ts";
import { badRequest, forbidden, notFound, unauthorized, uuid } from "../lib/util.ts";

/**
 * Marks a verification approved and lifts the user to T2, unless the same person already
 * verified another account. In that case the new account is held for review instead.
 */
export async function completeVerification(
  q: Queryable,
  deps: Deps,
  verificationId: string,
  status: "approved" | "rejected",
  uniqueKey: string | undefined,
): Promise<"approved" | "rejected" | "duplicate"> {
  const v = (await q.query<{ user_id: string; status: string; provider: string }>(
    "SELECT user_id, status, provider FROM verifications WHERE id = $1 FOR UPDATE",
    [verificationId],
  )).rows[0];
  if (!v) throw notFound("verification_not_found");
  if (v.status !== "started") return v.status as never;
  const now = deps.clock.now();
  if (status === "rejected" || !uniqueKey) {
    await q.query("UPDATE verifications SET status = 'rejected', completed_at = $1 WHERE id = $2", [now, verificationId]);
    return "rejected";
  }
  const existing = (await q.query<{ user_id: string }>(
    "SELECT user_id FROM verifications WHERE unique_key = $1 AND status = 'approved'",
    [uniqueKey],
  )).rows;
  if (existing.some((r) => r.user_id === v.user_id)) {
    // The same person verifying the same account again: already done, not an error.
    await q.query("UPDATE verifications SET status = 'rejected', completed_at = $1 WHERE id = $2", [now, verificationId]);
    return "approved";
  }
  const dup = { rows: existing };
  if (dup.rows[0]) {
    await q.query("UPDATE verifications SET status = 'duplicate', unique_key = $1, completed_at = $2 WHERE id = $3", [
      uniqueKey, now, verificationId,
    ]);
    await q.query(
      `INSERT INTO flags (id, user_id, kind, severity, detail, day, created_at) VALUES ($1,$2,'duplicate_identity','hold',$3,$4,$5)
       ON CONFLICT DO NOTHING`,
      [uuid(), v.user_id, JSON.stringify({ otherUser: dup.rows[0].user_id }), currentDay(deps), now],
    );
    return "duplicate";
  }
  await q.query("UPDATE verifications SET status = 'approved', unique_key = $1, completed_at = $2 WHERE id = $3", [
    uniqueKey, now, verificationId,
  ]);
  const user = await loadUser(q, v.user_id);
  if (user.tier < 2 && !user.banned) await setTier(q, deps, v.user_id, 2, `verified:${v.provider}`);
  return "approved";
}

export function registerVerification(app: FastifyInstance, deps: Deps): void {
  /** Starts a liveness / face de-duplication check with the configured vendor. */
  app.post("/v1/verification/session", async (req) => {
    const auth = await authenticate(deps, req);
    const user = await loadUser(deps.db, auth.userId);
    if (user.banned) throw forbidden("account_restricted");
    if (user.tier < 1) throw forbidden("device_not_attested");
    if (user.tier >= 2) return { status: "already_verified" };
    const provider = deps.config.ALLOW_DEV_VERIFICATION ? "dev" : deps.config.VERIFICATION_WEBHOOK_SECRET ? "vendor" : null;
    if (!provider) throw forbidden("verification_unavailable", "Identity verification is not configured yet");
    const id = uuid();
    const reference = `lv_${id}`;
    await deps.db.query(
      "INSERT INTO verifications (id, user_id, provider, reference, status, created_at) VALUES ($1,$2,$3,$4,'started',$5)",
      [id, auth.userId, provider, reference, deps.clock.now()],
    );
    return { provider, reference };
  });

  /** Vendor callback, authenticated with an HMAC of the raw body. */
  app.post("/v1/verification/webhook", async (req) => {
    const secret = deps.config.VERIFICATION_WEBHOOK_SECRET;
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? "";
    if (!secret || !verifyWebhookSignature(secret, raw, req.headers["x-longyu-signature"] as string | undefined)) {
      throw unauthorized("bad_signature");
    }
    const body = z
      .object({ reference: z.string().max(100), status: z.enum(["approved", "rejected"]), uniqueKey: z.string().max(200).optional() })
      .parse(JSON.parse(raw)) satisfies VerificationWebhook;
    return deps.db.tx(async (q) => {
      const v = (await q.query<{ id: string }>("SELECT id FROM verifications WHERE reference = $1", [body.reference])).rows[0];
      if (!v) throw notFound("verification_not_found");
      return { result: await completeVerification(q, deps, v.id, body.status, body.uniqueKey && `vendor:${body.uniqueKey}`) };
    });
  });

  /** Development only: approve the caller's open verification with a chosen identity key. */
  app.post("/v1/verification/dev/approve", async (req) => {
    if (!deps.config.ALLOW_DEV_VERIFICATION) throw notFound();
    const auth = await authenticate(deps, req);
    const { uniqueKey } = z.object({ uniqueKey: z.string().min(1).max(100) }).parse(req.body);
    return deps.db.tx(async (q) => {
      const v = (await q.query<{ id: string }>(
        "SELECT id FROM verifications WHERE user_id = $1 AND status = 'started' ORDER BY created_at DESC LIMIT 1",
        [auth.userId],
      )).rows[0];
      if (!v) throw notFound("verification_not_found");
      return { result: await completeVerification(q, deps, v.id, "approved", `dev:${uniqueKey}`) };
    });
  });

  // ----------------------------------------------- Binance Account Bound Token

  app.post("/v1/verification/babt/challenge", async (req) => {
    const auth = await authenticate(deps, req);
    const c = await createChallenge(deps.db, deps, auth.userId, "babt");
    return { nonce: c.nonce, domain: deps.config.SIWE_DOMAIN, chainId: 56 };
  });

  /**
   * Free proof of personhood for Binance users: the user signs with the BSC address that holds a
   * BABT (Binance's soulbound KYC token). One BABT holder can verify one LONGYU account.
   */
  app.post("/v1/verification/babt", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const auth = await authenticate(deps, req);
    const body = z.object({ message: z.string().max(2000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(req.body);
    const parsed = parseSiweMessage(body.message);
    if (!parsed.address || !parsed.nonce || !isAddress(parsed.address) || parsed.chainId !== 56) throw badRequest("siwe_invalid");
    const address = getAddress(parsed.address);
    if (!validateSiweMessage({ message: parsed, domain: deps.config.SIWE_DOMAIN, address, time: new Date(Number(deps.clock.now()) * 1000) })) {
      throw badRequest("siwe_invalid");
    }
    if (!(await verifyMessage({ address, message: body.message, signature: body.signature as Hex }))) {
      throw forbidden("signature_invalid");
    }
    const user = await loadUser(deps.db, auth.userId);
    if (user.banned) throw forbidden("account_restricted");
    if (user.tier < 1) throw forbidden("device_not_attested");
    if (user.tier >= 2) return { result: "approved" };
    const balance = await deps.chain.babtBalance(address);
    if (balance === 0n) throw forbidden("no_babt", "This address does not hold a Binance Account Bound Token");
    return deps.db.tx(async (q) => {
      await consumeChallenge(q, deps, auth.userId, "babt", { nonce: parsed.nonce });
      const id = uuid();
      await q.query(
        "INSERT INTO verifications (id, user_id, provider, reference, status, created_at) VALUES ($1,$2,'babt',$3,'started',$4)",
        [id, auth.userId, `babt_${id}`, deps.clock.now()],
      );
      return { result: await completeVerification(q, deps, id, "approved", `babt:${address.toLowerCase()}`) };
    });
  });
}
