import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertCountryAllowed, authenticate, clientIp, issueAccessToken, loadUser, type Deps } from "../context.ts";
import type { Queryable } from "../db/index.ts";
import { pkceChallenge, XNotBilled, type XAccount } from "../services/external.ts";
import { HttpError, badRequest, forbidden, humanCode, randomToken, sha256Hex, unauthorized, uuid } from "../lib/util.ts";

const REFRESH_TTL = 30n * 86_400n;
/** How long the person has to approve the sign-in at X. */
const LOGIN_TTL = 600n;
/** How long the app has to redeem the ticket the callback hands it. */
const TICKET_TTL = 300n;
const DAY = 86_400n;
/** One X account completes a sign-in of one kind at most this often. */
export const X_ACCOUNT_COOLOFF = 30n;
/**
 * The most sign-ins one client (an IPv4 address or an IPv6 /64, as the rate limiter counts) sends
 * to X in one UTC day, so that no single client can use up X_DAILY_SIGNIN_LIMIT for everyone.
 * Many phones can share one IPv4 address behind a mobile carrier, so it is not set tight.
 */
export const X_CLIENT_DAILY_SIGNINS = 100;
/** Device attestation older than this must be renewed (also enforced at session start). */
export const ATTESTATION_MAX_AGE = 30n * DAY;

/** A state or a ticket: 32 random bytes in base64url, as randomToken() makes them. */
export const LoginToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** The app's secret for one sign-in, in PKCE's alphabet and length (RFC 7636). */
export const AppVerifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
/** base64url SHA-256 of the app's verifier. */
const AppChallenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export type LoginPurpose = "sign-in" | "wallet-change";
/** What started a sign-in: the phone app, or the web app in a browser (WEB_MINING). */
export type LoginClient = "app" | "web";

export const webMiningOff = () => forbidden("web_mining_unavailable", "Mining in a browser is switched off. Use the LONGYU MINE app.");

/**
 * Spends the ticket a sign-in callback handed to the app and returns the X account behind it, or
 * null. The ticket must be unused and unexpired, come from a flow with this purpose (and, for a
 * wallet change, started by this user), and be presented with the verifier whose hash the app sent
 * when it started the flow. The first presentation uses the ticket up whether or not it passes, so
 * the caller must commit even when the result is null.
 */
export async function redeemTicket(
  q: Queryable,
  deps: Deps,
  p: { ticket: string; appVerifier: string; purpose: LoginPurpose; userId?: string },
): Promise<(XAccount & { client: LoginClient }) | null> {
  const now = deps.clock.now();
  const login = (await q.query<{
    purpose: string; user_id: string | null; app_challenge: string; x_id: string | null; x_username: string | null; x_avatar: string | null; ticket_expires_at: bigint | null;
    client: LoginClient;
  }>(
    `UPDATE x_logins SET ticket_used_at = $2 WHERE ticket_hash = $1 AND ticket_used_at IS NULL
     RETURNING purpose, user_id, app_challenge, x_id, x_username, x_avatar, ticket_expires_at, client`,
    [sha256Hex(p.ticket), now],
  )).rows[0];
  if (!login || login.x_id === null || login.x_username === null || login.ticket_expires_at === null) return null;
  if (login.ticket_expires_at < now) return null;
  if (login.purpose !== p.purpose || login.user_id !== (p.userId ?? null)) return null;
  const expected = Buffer.from(login.app_challenge);
  const got = Buffer.from(pkceChallenge(p.appVerifier));
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return { id: login.x_id, username: login.x_username, avatar: login.x_avatar, client: login.client };
}

async function issueRefresh(q: Queryable, deps: Deps, userId: string, deviceId: string, family: string) {
  const token = randomToken();
  await q.query(
    "INSERT INTO refresh_tokens (id, user_id, device_id, family, token_hash, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [uuid(), userId, deviceId, family, sha256Hex(token), deps.clock.now() + REFRESH_TTL, deps.clock.now()],
  );
  return token;
}

export function registerAuth(app: FastifyInstance, deps: Deps): void {
  /**
   * Starts a sign-in with X (or, for a signed-in user, the fresh sign-in a wallet change needs) and
   * returns the X page to open. The app keeps a random verifier and sends only its hash; the ticket
   * the callback later hands out is useless without that verifier.
   */
  app.post("/v1/auth/x/start", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const body = z
      .object({ appChallenge: AppChallenge, purpose: z.enum(["sign-in", "wallet-change"]), client: z.enum(["app", "web"]).default("app") })
      .parse(req.body);
    assertCountryAllowed(deps, req);
    if (body.client === "web" && !deps.config.WEB_MINING) throw webMiningOff();
    let userId: string | null = null;
    if (body.purpose === "wallet-change") {
      const auth = await authenticate(deps, req);
      const user = await loadUser(deps.db, auth.userId);
      if (user.banned) throw forbidden("account_restricted");
      // Refused here, before anyone is sent to X, when the link would refuse the change anyway.
      const wallet = (await deps.db.query<{ change_available_at: bigint }>(
        "SELECT change_available_at FROM wallets WHERE user_id = $1",
        [user.id],
      )).rows[0];
      if (wallet && deps.clock.now() < wallet.change_available_at) {
        throw forbidden("wallet_change_cooldown", `Wallet can change after ${wallet.change_available_at}`);
      }
      userId = user.id;
    }
    const state = randomToken();
    const verifier = randomToken();
    let authorizeUrl: string;
    try {
      authorizeUrl = deps.x.authorizeUrl({ state, codeChallenge: pkceChallenge(verifier) });
    } catch {
      throw new HttpError(503, "sign_in_unavailable");
    }
    const now = deps.clock.now();
    await deps.db.query(
      `INSERT INTO x_logins (id, state_hash, purpose, user_id, app_challenge, x_verifier, expires_at, created_at, client)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuid(), sha256Hex(state), body.purpose, userId, body.appChallenge, verifier, now + LOGIN_TTL, now, body.client],
    );
    return { authorizeUrl };
  });

  /**
   * Where X sends the browser back. Answers with a redirect into the app carrying a one-time ticket,
   * or a fixed error code; the redirect target is APP_AUTH_REDIRECT and nothing from the request is
   * copied into it. A sign-in started by the web app returns to WEB_AUTH_REDIRECT instead, with the
   * result after a "#": a browser keeps that part to itself, so the ticket reaches no server's log.
   * A state that is unknown, expired or already used gets a plain page instead.
   *
   * Error codes: denied (the person said no at X), failed (X did not confirm the account), paused
   * (the day's ceiling on sign-ins is reached), too_many (this client reached its own ceiling for
   * the day), too_soon (this X account signed in a moment ago).
   */
  app.get("/v1/auth/x/callback", { exposeHeadRoute: false, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const state = typeof query.state === "string" ? query.state : "";
    const now = deps.clock.now();
    // The state is spent in its own committed statement before X is called: it works once.
    const login = LoginToken.safeParse(state).success
      ? (await deps.db.query<{ id: string; x_verifier: string; client: LoginClient }>(
          `UPDATE x_logins SET consumed_at = $2 WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at >= $2
           RETURNING id, x_verifier, client`,
          [sha256Hex(state), now],
        )).rows[0]
      : undefined;
    // Web mining switched off while the person was at X: there is no page to return them to.
    const web = login?.client === "web" && deps.config.WEB_MINING ? deps.config.WEB_AUTH_REDIRECT : undefined;
    if (!login || (login.client === "web" && !web)) {
      return reply.code(400).type("text/plain; charset=utf-8").send("This sign-in link is no longer valid. Go back to the app and try again.");
    }
    const back = (result: `ticket=${string}` | "error=denied" | "error=failed" | "error=paused" | "error=too_many" | "error=too_soon") =>
      reply.redirect(web ? `${web}#${result}` : `${deps.config.APP_AUTH_REDIRECT}?${result}`, 302);
    const code = typeof query.code === "string" ? query.code : "";
    if (query.error !== undefined || code.length === 0 || code.length > 2000) {
      return back(query.error === "access_denied" ? "error=denied" : "error=failed");
    }
    // X bills each read of an account, so a day has a ceiling, and one client a small ceiling of
    // its own: otherwise a single client could use up the day and nobody else could sign in. Both
    // places are taken before X is called: sign-ins arriving together cannot pass either.
    const day = now / DAY;
    const client = clientIp(deps, req);
    const own = (await deps.db.query(
      `INSERT INTO x_signin_clients (day, client, exchanges) VALUES ($1, $2, 1)
       ON CONFLICT (day, client) DO UPDATE SET exchanges = x_signin_clients.exchanges + 1 WHERE x_signin_clients.exchanges < $3 RETURNING exchanges`,
      [day, client, X_CLIENT_DAILY_SIGNINS],
    )).rows[0];
    if (!own) {
      req.log.warn("X sign-in refused: this client reached its own ceiling for the day");
      return back("error=too_many");
    }
    const giveBackOwn = () =>
      deps.db.query("UPDATE x_signin_clients SET exchanges = exchanges - 1 WHERE day = $1 AND client = $2 AND exchanges > 0", [day, client]);
    const limit = deps.config.X_DAILY_SIGNIN_LIMIT;
    const place = (await deps.db.query(
      `INSERT INTO x_signin_days (day, exchanges) VALUES ($1, 1)
       ON CONFLICT (day) DO UPDATE SET exchanges = x_signin_days.exchanges + 1 WHERE x_signin_days.exchanges < $2 RETURNING exchanges`,
      [day, limit],
    )).rows[0];
    if (!place) {
      // Nothing was sent to X, so it does not count against the client either.
      await giveBackOwn();
      req.log.error({ limit }, "X sign-in refused: X_DAILY_SIGNIN_LIMIT reached, nobody can sign in until 00:00 UTC");
      return back("error=paused");
    }
    let account: XAccount;
    try {
      // The one call to X for this sign-in, outside any transaction.
      account = await deps.x.exchange({ code, codeVerifier: login.x_verifier });
    } catch (e) {
      // Stopped before the billed read (a bad or reused code): both places are given back.
      if (e instanceof XNotBilled) {
        await deps.db.query("UPDATE x_signin_days SET exchanges = exchanges - 1 WHERE day = $1 AND exchanges > 0", [day]);
        await giveBackOwn();
      }
      req.log.warn({ reason: (e as Error).message }, "X sign-in failed");
      return back("error=failed");
    }
    const ticket = randomToken();
    // No ticket when this X account completed a sign-in of the same kind a moment ago.
    const stored = (await deps.db.query<{ id: string }>(
      `UPDATE x_logins SET x_id = $1, x_username = $2, ticket_hash = $3, ticket_expires_at = $4, x_avatar = $7
       WHERE id = $5 AND NOT EXISTS (
         SELECT 1 FROM x_logins o WHERE o.x_id = $1 AND o.id <> $5 AND o.purpose = x_logins.purpose AND o.consumed_at > $6)
       RETURNING id`,
      [account.id, account.username, sha256Hex(ticket), now + TICKET_TTL, login.id, now - X_ACCOUNT_COOLOFF, account.avatar],
    )).rows[0];
    if (!stored) return back("error=too_soon");
    return back(`ticket=${ticket}`);
  });

  /** Redeems a sign-in ticket: finds or creates the account for that X id and opens a session on this device. */
  app.post("/v1/auth/x/finish", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const body = z
      .object({
        ticket: LoginToken,
        appVerifier: AppVerifier,
        installId: z.string().min(8).max(128),
        platform: z.enum(["ios", "android", "web"]),
        referralCode: z.string().max(16).optional(),
      })
      .parse(req.body);
    const country = assertCountryAllowed(deps, req);
    const client: LoginClient = body.platform === "web" ? "web" : "app";
    if (client === "web" && !deps.config.WEB_MINING) throw webMiningOff();
    const now = deps.clock.now();

    const result = await deps.db.tx(async (q) => {
      const account = await redeemTicket(q, deps, { ticket: body.ticket, appVerifier: body.appVerifier, purpose: "sign-in" });
      // A ticket opens a session only for the client that started the sign-in: a web ticket never
      // makes a phone's device, and a phone's ticket never makes a browser's.
      if (!account || account.client !== client) return { error: "ticket_invalid" };

      let user = (await q.query<{ id: string }>("SELECT id FROM users WHERE x_id = $1", [account.id])).rows[0];
      let created = false;
      if (!user) {
        let referredBy: string | null = null;
        if (body.referralCode) {
          const ref = await q.query<{ id: string }>("SELECT id FROM users WHERE referral_code = $1", [
            body.referralCode.toUpperCase(),
          ]);
          referredBy = ref.rows[0]?.id ?? null;
        }
        // Two first sign-ins of one X account at the same moment: the second finds the first's row.
        user = (await q.query<{ id: string }>(
          `INSERT INTO users (id, x_id, x_username, avatar_url, handle, tier, referral_code, referred_by, country, created_at)
           VALUES ($1,$2,$3,$9,$4,0,$5,$6,$7,$8) ON CONFLICT (x_id) DO NOTHING RETURNING id`,
          [uuid(), account.id, account.username, `miner_${humanCode(8).toLowerCase()}`, humanCode(8), referredBy, country, now, account.avatar],
        )).rows[0];
        if (user) {
          await q.query("INSERT INTO streaks (user_id) VALUES ($1)", [user.id]);
          created = true;
        } else {
          user = (await q.query<{ id: string }>("SELECT id FROM users WHERE x_id = $1", [account.id])).rows[0]!;
        }
      }
      // The username and the picture can change at X; the id cannot.
      if (!created) await q.query("UPDATE users SET x_username = $1, avatar_url = $2 WHERE id = $3", [account.username, account.avatar, user.id]);
      const dev = await q.query<{ id: string }>(
        `INSERT INTO devices (id, user_id, platform, install_id, created_at, last_seen_at) VALUES ($1,$2,$3,$4,$5,$5)
         ON CONFLICT (user_id, install_id) DO UPDATE SET last_seen_at = $5 RETURNING id`,
        [uuid(), user.id, body.platform, body.installId, now],
      );
      const deviceId = dev.rows[0]!.id;
      const refreshToken = await issueRefresh(q, deps, user.id, deviceId, uuid());
      return { userId: user.id, deviceId, created, refreshToken };
    });
    // The transaction commits either way, so a ticket that failed a check stays used.
    if (result.error) throw forbidden(result.error);
    const { userId, deviceId, created, refreshToken } = result as { userId: string; deviceId: string; created: boolean; refreshToken: string };
    const accessToken = await issueAccessToken(deps, { userId, deviceId });
    return { accessToken, refreshToken, newUser: created };
  });

  app.post("/v1/auth/refresh", async (req) => {
    const { refreshToken } = z.object({ refreshToken: z.string().min(20) }).parse(req.body);
    const now = deps.clock.now();
    const out = await deps.db.tx(async (q) => {
      const { rows } = await q.query<{
        id: string; user_id: string; device_id: string; family: string; expires_at: bigint; used_at: bigint | null; revoked: boolean;
      }>("SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE", [sha256Hex(refreshToken)]);
      const t = rows[0];
      if (!t || t.revoked || t.expires_at < now) return null;
      if (t.used_at !== null) {
        // A refresh token was used twice: assume theft and end the whole session family.
        await q.query("UPDATE refresh_tokens SET revoked = TRUE WHERE family = $1", [t.family]);
        return "reuse" as const;
      }
      await q.query("UPDATE refresh_tokens SET used_at = $1 WHERE id = $2", [now, t.id]);
      // Issued inside the same transaction, so a concurrent reuse revokes it too.
      const next = await issueRefresh(q, deps, t.user_id, t.device_id, t.family);
      return { userId: t.user_id, deviceId: t.device_id, refreshToken: next };
    });
    if (out === "reuse") throw unauthorized("refresh_reused");
    if (!out) throw unauthorized("refresh_invalid");
    return {
      accessToken: await issueAccessToken(deps, { userId: out.userId, deviceId: out.deviceId }),
      refreshToken: out.refreshToken,
    };
  });

  app.post("/v1/auth/logout", async (req) => {
    const { refreshToken } = z.object({ refreshToken: z.string().min(20) }).parse(req.body);
    await deps.db.query(
      "UPDATE refresh_tokens SET revoked = TRUE WHERE family = (SELECT family FROM refresh_tokens WHERE token_hash = $1)",
      [sha256Hex(refreshToken)],
    );
    return { ok: true };
  });

  app.get("/v1/me", async (req) => {
    const auth = await authenticate(deps, req);
    const [user, wallet, device, activity] = await Promise.all([
      loadUser(deps.db, auth.userId),
      deps.db.query<{ address: string; change_available_at: bigint }>(
        "SELECT address, change_available_at FROM wallets WHERE user_id = $1",
        [auth.userId],
      ),
      deps.db.query<{ attested_at: bigint | null; platform: string }>(
        "SELECT attested_at, platform FROM devices WHERE id = $1",
        [auth.deviceId],
      ),
      deps.db.query<{ mining_days: bigint; invites: bigint }>(
        `SELECT (SELECT count(*) FROM mining_sessions WHERE user_id = $1)::bigint AS mining_days,
                (SELECT count(*) FROM users WHERE referred_by = $1)::bigint AS invites`,
        [auth.userId],
      ),
    ]);
    if (!device.rows[0]) throw badRequest("device_unknown");
    const attestedAt = device.rows[0].attested_at;
    const attestationExpiresAt = attestedAt === null ? null : attestedAt + ATTESTATION_MAX_AGE;
    return {
      id: user.id,
      xUsername: user.x_username,
      avatarUrl: user.avatar_url,
      handle: user.handle,
      tier: user.tier,
      referralCode: user.referral_code,
      banned: user.banned,
      createdAt: user.created_at,
      miningDays: activity.rows[0]?.mining_days ?? 0n,
      invites: activity.rows[0]?.invites ?? 0n,
      wallet: wallet.rows[0]?.address ?? null,
      walletChangeAvailableAt: wallet.rows[0]?.change_available_at ?? null,
      // False once the attestation is older than 30 days: the app then re-attests.
      deviceAttested: attestationExpiresAt !== null && attestationExpiresAt > deps.clock.now(),
      attestationExpiresAt,
    };
  });
}
