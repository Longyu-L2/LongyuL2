import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { getAddress, isAddress } from "viem";
import { clientAddress, clientIp, assertCountryAllowed, authenticate, currentDay, setTier, type Deps } from "../context.ts";
import { nativeCurrency, type RewardToken } from "../services/chain.ts";
import { badRequest, conflict, forbidden, isUniqueViolation, notFound, safeEqualHex, sha256PlainHex, tooMany, unauthorized, uuid } from "../lib/util.ts";

const FAUCET_PER_IP_PER_DAY = 3n;

export function adminName(deps: Deps, req: FastifyRequest): string {
  const key = req.headers["x-admin-key"];
  if (typeof key !== "string" || key.length < 16) throw unauthorized("admin_key_required");
  const hash = sha256PlainHex(key);
  for (const entry of deps.config.ADMIN_KEYS.split(",").filter(Boolean)) {
    const [name, expected] = entry.split(":");
    if (name && expected && expected.length === hash.length && safeEqualHex(expected, hash)) return name;
  }
  throw unauthorized("admin_key_invalid");
}

/** Public, unauthenticated reads are cached for a minute so they cannot be used to load the database. */
const caches = new WeakMap<Deps, Map<string, { at: number; value: unknown }>>();
async function cached<T>(deps: Deps, key: string, fn: () => Promise<T>): Promise<T> {
  let c = caches.get(deps);
  if (!c) caches.set(deps, (c = new Map()));
  const hit = c.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value as T;
  const value = await fn();
  c.set(key, { at: Date.now(), value });
  return value;
}

export function registerPublicAndAdmin(app: FastifyInstance, deps: Deps): void {
  app.get("/health", async () => ({ ok: true }));

  // The reward token never changes (the distributor's asset is immutable), so one good read is kept.
  let rewardToken: Promise<RewardToken | null> | undefined;
  const readRewardToken = () => (rewardToken ??= deps.chain.rewardToken().catch((e) => { rewardToken = undefined; throw e; }));

  app.get("/v1/network", async () => ({
    chainId: deps.config.CHAIN_ID,
    chainName: deps.config.CHAIN_NAME,
    rpcUrl: deps.config.PUBLIC_RPC_URL ?? deps.config.RPC_URL,
    explorerUrl: deps.config.EXPLORER_URL,
    nativeCurrency: nativeCurrency(deps.config),
    // null: rewards are paid in the native token. Left out while the chain cannot be read.
    rewardToken: await readRewardToken().catch(() => undefined),
    distributor: deps.chain.distributor,
    faucet: deps.config.FAUCET_ADDRESS ?? null,
    // Whether an account can verify its identity now. Mining does not wait for it on testnet.
    verificationOpen: deps.config.ALLOW_DEV_VERIFICATION || Boolean(deps.config.VERIFICATION_WEBHOOK_SECRET),
  }));

  app.get("/v1/stats", async () => cached(deps, "stats", async () => {
    const latest = (await deps.db.query<{ day: bigint; root: string | null; total_entitled: string; stats: Record<string, unknown>; status: string }>(
      "SELECT day, root, total_entitled, stats, status FROM settlements ORDER BY day DESC LIMIT 1",
    )).rows[0];
    const users = (await deps.db.query<{ miners: bigint; verified: bigint }>(
      "SELECT count(*) FILTER (WHERE tier >= $1)::bigint AS miners, count(*) FILTER (WHERE tier >= 2)::bigint AS verified FROM users WHERE NOT banned",
      [deps.rewards.entitledFromTier],
    )).rows[0];
    const claimed = (await deps.db.query<{ s: string | null }>("SELECT sum(cumulative)::text AS s FROM claimed_onchain")).rows[0];
    return {
      day: currentDay(deps),
      miners: users?.miners ?? 0n,
      verifiedMiners: users?.verified ?? 0n,
      totalClaimed: claimed?.s ?? "0",
      latestSettlement: latest ?? null,
    };
  }));

  app.get("/v1/leaderboard", async () => cached(deps, "leaderboard", async () => {
    const { rows } = await deps.db.query<{ handle: string; streak_days: number; days30: bigint }>(
      `SELECT u.handle, s.streak_days,
              (SELECT count(*) FROM mining_sessions m WHERE m.user_id = u.id AND m.credited_day > $1 - 30)::bigint AS days30
       FROM users u JOIN streaks s ON s.user_id = u.id
       WHERE u.tier >= $2 AND NOT u.banned
       ORDER BY s.streak_days DESC, days30 DESC, u.handle ASC LIMIT 100`,
      [currentDay(deps), deps.rewards.entitledFromTier],
    );
    return { entries: rows.map((r, i) => ({ rank: i + 1, handle: r.handle, streakDays: r.streak_days, miningDays30: r.days30 })) };
  }));

  /** Published root files, so anyone can rebuild and check each day's tree. */
  app.get("/data/roots/:file", async (req, reply) => {
    const { file } = z.object({ file: z.string().regex(/^day-\d{1,7}-[0-9a-f]{16}\.json$/) }).parse(req.params);
    const body = await deps.files.get(`roots/${file}`);
    if (body === null) throw notFound();
    reply.header("content-type", "application/json; charset=utf-8").header("cache-control", "public, max-age=31536000, immutable");
    return body;
  });

  // ------------------------------------------------------------------ faucet

  app.post("/v1/faucet", { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (req) => {
    assertCountryAllowed(deps, req);
    const body = z.object({ address: z.string(), captchaToken: z.string().min(1).max(4000) }).parse(req.body);
    if (!isAddress(body.address)) throw badRequest("address_invalid");
    if (!deps.config.FAUCET_ADDRESS) throw forbidden("faucet_unavailable");
    const address = getAddress(body.address);
    if (!(await deps.captcha.verify(body.captchaToken, clientAddress(deps, req)))) throw forbidden("captcha_failed");
    const since = deps.clock.now() - 86_400n;
    const counts = (await deps.db.query<{ by_address: bigint; by_ip: bigint }>(
      `SELECT (SELECT count(*) FROM faucet_requests WHERE address = $1 AND created_at > $3)::bigint AS by_address,
              (SELECT count(*) FROM faucet_requests WHERE ip = $2 AND created_at > $3)::bigint AS by_ip`,
      [address, clientIp(deps, req), since],
    )).rows[0]!;
    if (counts.by_ip >= FAUCET_PER_IP_PER_DAY) throw tooMany("faucet_ip_limit", "Daily limit reached for this network");
    // The unique (address, day) index makes "one per address per day" atomic.
    const inserted = await deps.db.query(
      `INSERT INTO faucet_requests (id, address, ip, created_at, day, status) VALUES ($1,$2,$3,$4,$5,'queued')
       ON CONFLICT (address, day) DO NOTHING RETURNING id`,
      [uuid(), address, clientIp(deps, req), deps.clock.now(), deps.clock.now() / 86_400n],
    );
    if (!inserted.rows[0]) throw tooMany("faucet_address_limit", "One request per address per day");
    // Sent by the relayer job, the only place that uses the relayer key.
    return { status: "queued", amount: deps.config.FAUCET_DRIP_WEI };
  });

  // ----------------------------------------------------------------- appeals

  app.post("/v1/appeals", async (req) => {
    const auth = await authenticate(deps, req);
    const { message } = z.object({ message: z.string().trim().min(10).max(2000) }).parse(req.body);
    const open = await deps.db.query("SELECT 1 FROM appeals WHERE user_id = $1 AND status = 'open'", [auth.userId]);
    if (open.rows[0]) throw conflict("appeal_open", "You already have an open appeal");
    const id = uuid();
    try {
      await deps.db.query("INSERT INTO appeals (id, user_id, message, created_at) VALUES ($1,$2,$3,$4)", [
        id, auth.userId, message, deps.clock.now(),
      ]);
    } catch (e) {
      // Two requests at once: the unique index on open appeals lets one in.
      if (isUniqueViolation(e)) throw conflict("appeal_open", "You already have an open appeal");
      throw e;
    }
    return { id };
  });

  app.get("/v1/appeals", async (req) => {
    const auth = await authenticate(deps, req);
    const { rows } = await deps.db.query(
      "SELECT id, message, status, response, created_at FROM appeals WHERE user_id = $1 ORDER BY created_at DESC",
      [auth.userId],
    );
    return { appeals: rows };
  });

  // ------------------------------------------------------------------- admin

  app.get("/v1/admin/flags", async (req) => {
    adminName(deps, req);
    const { status } = z.object({ status: z.enum(["open", "cleared", "confirmed"]).default("open") }).parse(req.query);
    const { rows } = await deps.db.query(
      "SELECT f.*, u.handle FROM flags f JOIN users u ON u.id = f.user_id WHERE f.status = $1 ORDER BY f.created_at DESC LIMIT 500",
      [status],
    );
    return { flags: rows };
  });

  app.post("/v1/admin/flags/:id/resolve", async (req) => {
    const admin = adminName(deps, req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { action } = z.object({ action: z.enum(["clear", "confirm"]) }).parse(req.body);
    const res = await deps.db.query(
      "UPDATE flags SET status = $1, resolved_by = $2, resolved_at = $3 WHERE id = $4 AND status = 'open' RETURNING id",
      [action === "clear" ? "cleared" : "confirmed", admin, deps.clock.now(), id],
    );
    if (!res.rows[0]) throw notFound("flag_not_open");
    return { ok: true };
  });

  /** Bans need two different admins: one requests, another approves. */
  app.post("/v1/admin/bans", async (req) => {
    const admin = adminName(deps, req);
    const body = z.object({ userId: z.uuid(), reason: z.string().min(5).max(500) }).parse(req.body);
    const user = await deps.db.query("SELECT 1 FROM users WHERE id = $1", [body.userId]);
    if (!user.rows[0]) throw notFound("user_not_found");
    const id = uuid();
    await deps.db.query(
      "INSERT INTO admin_actions (id, kind, target_user, reason, requested_by, created_at) VALUES ($1,'ban',$2,$3,$4,$5)",
      [id, body.userId, body.reason, admin, deps.clock.now()],
    );
    return { id, status: "pending" };
  });

  app.post("/v1/admin/bans/:id/approve", async (req) => {
    const admin = adminName(deps, req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return deps.db.tx(async (q) => {
      const a = (await q.query<{ target_user: string; requested_by: string; status: string }>(
        "SELECT target_user, requested_by, status FROM admin_actions WHERE id = $1 FOR UPDATE",
        [id],
      )).rows[0];
      if (!a || a.status !== "pending") throw notFound("action_not_pending");
      if (a.requested_by === admin) throw forbidden("second_admin_required", "Another admin must approve");
      const now = deps.clock.now();
      await q.query("UPDATE admin_actions SET status = 'executed', approved_by = $1, executed_at = $2 WHERE id = $3", [admin, now, id]);
      await q.query("UPDATE users SET banned = TRUE, banned_day = $1 WHERE id = $2", [currentDay(deps), a.target_user]);
      await setTier(q, deps, a.target_user, 0, "banned");
      await q.query("UPDATE flags SET status = 'confirmed', resolved_by = $1, resolved_at = $2 WHERE user_id = $3 AND status = 'open'", [
        admin, now, a.target_user,
      ]);
      return { status: "executed" };
    });
  });

  app.get("/v1/admin/bans", async (req) => {
    adminName(deps, req);
    const { status } = z.object({ status: z.enum(["pending", "executed", "rejected"]).default("pending") }).parse(req.query);
    const { rows } = await deps.db.query(
      `SELECT a.id, a.target_user, u.handle, a.reason, a.requested_by, a.approved_by, a.status, a.created_at, a.executed_at
       FROM admin_actions a JOIN users u ON u.id = a.target_user
       WHERE a.kind = 'ban' AND a.status = $1 ORDER BY a.created_at DESC LIMIT 500`,
      [status],
    );
    return { bans: rows };
  });

  /** Any admin, including the one who asked, can turn down a pending ban. */
  app.post("/v1/admin/bans/:id/reject", async (req) => {
    const admin = adminName(deps, req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const res = await deps.db.query(
      "UPDATE admin_actions SET status = 'rejected', approved_by = $2, executed_at = $3 WHERE id = $1 AND kind = 'ban' AND status = 'pending' RETURNING id",
      [id, admin, deps.clock.now()],
    );
    if (!res.rows[0]) throw notFound("action_not_pending");
    return { status: "rejected" };
  });

  /** One account's record, for reviewing its flags, bans and appeals. */
  app.get("/v1/admin/users/:id", async (req) => {
    adminName(deps, req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const u = (await deps.db.query<Record<string, unknown>>(
      `SELECT u.id, u.handle, u.tier, u.banned, u.banned_day, u.country, u.created_at, w.address AS wallet,
              (SELECT count(*) FROM mining_sessions m WHERE m.user_id = u.id)::bigint AS mining_days,
              (SELECT max(credited_day) FROM mining_sessions m WHERE m.user_id = u.id) AS last_mined_day,
              (SELECT count(*) FROM devices d WHERE d.user_id = u.id)::bigint AS devices
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = $1`,
      [id],
    )).rows[0];
    if (!u) throw notFound("user_not_found");
    const flags = (await deps.db.query("SELECT id, kind, severity, detail, status, day, created_at, resolved_by FROM flags WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100", [id])).rows;
    const appeals = (await deps.db.query("SELECT id, message, status, response, created_at, resolved_by FROM appeals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50", [id])).rows;
    const walletChanges = (await deps.db.query("SELECT from_address, to_address, effective_day, created_at FROM wallet_changes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20", [id])).rows;
    return { user: u, flags, appeals, walletChanges };
  });

  app.get("/v1/admin/appeals", async (req) => {
    adminName(deps, req);
    const { rows } = await deps.db.query(
      "SELECT a.*, u.handle FROM appeals a JOIN users u ON u.id = a.user_id WHERE a.status = 'open' ORDER BY a.created_at",
    );
    return { appeals: rows };
  });

  app.post("/v1/admin/appeals/:id/resolve", async (req) => {
    const admin = adminName(deps, req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ decision: z.enum(["upheld", "denied"]), response: z.string().min(5).max(2000) }).parse(req.body);
    return deps.db.tx(async (q) => {
      const a = (await q.query<{ user_id: string }>(
        "UPDATE appeals SET status = $1, response = $2, resolved_by = $3 WHERE id = $4 AND status = 'open' RETURNING user_id",
        [body.decision, body.response, admin, id],
      )).rows[0];
      if (!a) throw notFound("appeal_not_open");
      if (body.decision === "upheld") {
        // Upheld appeals clear open holds; a ban needs a fresh review, so it is not lifted here.
        await q.query("UPDATE flags SET status = 'cleared', resolved_by = $1, resolved_at = $2 WHERE user_id = $3 AND status = 'open'", [
          admin, deps.clock.now(), a.user_id,
        ]);
      }
      return { ok: true };
    });
  });

  app.get("/v1/admin/settlements", async (req) => {
    adminName(deps, req);
    const { rows } = await deps.db.query(
      "SELECT day, root, total_entitled, data_hash, status, tx_hash, stats FROM settlements ORDER BY day DESC LIMIT 60",
    );
    return { settlements: rows };
  });

  app.get("/v1/admin/me", async (req) => ({ admin: adminName(deps, req) }));
}
