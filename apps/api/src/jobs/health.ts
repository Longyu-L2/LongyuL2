/**
 * Operational health: one list of checks, each ok / warn / critical, for the admin console and for
 * uptime monitors (the endpoint answers 503 when anything is critical). Contract events
 * are watched separately by OpenZeppelin Monitor (ops/monitor).
 */
import { parseEther } from "viem";
import { dailyBudget } from "@longyu/reward-engine";
import { currentDay, type Deps } from "../context.ts";
import { toBig } from "../lib/util.ts";
import { paymentConfig } from "../services/payments.ts";
import { JOBS } from "./runner.ts";
import { SETTLE_GRACE_SECONDS } from "./settlement.ts";

export type Level = "ok" | "warn" | "critical";
export interface Check {
  name: string;
  status: Level;
  detail: string;
}
export interface Health {
  status: Level;
  checkedAt: bigint;
  checks: Check[];
}

const RANK: Record<Level, number> = { ok: 0, warn: 1, critical: 2 };
const worst = (levels: Level[]): Level => levels.reduce<Level>((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");
const level = (critical: boolean, warn: boolean): Level => (critical ? "critical" : warn ? "warn" : "ok");
const mins = (seconds: bigint) => `${seconds / 60n} min`;
const fmt = (wei: bigint) => {
  const whole = wei / 10n ** 18n;
  const frac = ((wei % 10n ** 18n) * 1000n) / 10n ** 18n;
  return `${whole}.${frac.toString().padStart(3, "0")}`;
};

/** Jobs the health check expects, with how stale their last success may get. */
function expectedJobs(deps: Deps) {
  return JOBS.filter((j) => j.name !== "payments" || paymentConfig(deps.config)).map((j) => ({
    name: j.name,
    warnAfter: BigInt(Math.max(5 * 60, Math.ceil((3 * j.everyMs) / 1000))),
    criticalAfter: BigInt(Math.max(30 * 60, Math.ceil((10 * j.everyMs) / 1000))),
  }));
}

export async function computeHealth(deps: Deps): Promise<Health> {
  const now = deps.clock.now();
  const checks: Check[] = [];
  const add = (name: string, status: Level, detail: string): void => {
    checks.push({ name, status, detail });
  };
  const guard = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      add(name, "critical", `check failed: ${(e as Error).message.slice(0, 200)}`);
    }
  };

  await guard("database", async () => {
    const t = Date.now();
    await deps.db.query("SELECT 1");
    const ms = Date.now() - t;
    add("database", level(false, ms > 500), `query in ${ms} ms`);
  });

  await guard("chain", async () => {
    const c = await deps.chain.healthSnapshot();
    const age = now - c.blockTime;
    add("chain", level(age > 600n, age > 120n), `block ${c.block}, ${age} s old`);
    add("distributor", c.paused ? "warn" : "ok", c.paused ? "paused by the guardian: claims and root activation are stopped" : "running");
    const minGas = parseEther(deps.config.ALERT_MIN_GAS_BALANCE);
    for (const [name, bal] of [["publisher gas", c.publisherBalance], ["relayer gas", c.relayerBalance]] as const) {
      if (bal === null) add(name, "warn", "signer not configured");
      else add(name, level(bal < minGas / 5n, bal < minGas), `${fmt(bal)} (warn below ${fmt(minGas)})`);
    }
    if (c.vaultBalance !== null) {
      const perDay = dailyBudget(deps.schedule, currentDay(deps));
      const days = perDay === 0n ? null : c.vaultBalance / perDay;
      add("vault runway", days === null ? "ok" : level(days < 2n, days < 14n), days === null ? "emission finished" : `${days} days at today's budget`);
    } else {
      add("vault runway", "critical", "no vault set on the distributor");
    }
    if (deps.config.FAUCET_ADDRESS) {
      const drips = c.faucetBalance === null ? 0n : c.faucetBalance / deps.config.FAUCET_DRIP_WEI;
      add("faucet", level(drips < 10n, drips < 100n), `${drips} drips left`);
    }
  });

  const l1 = deps.l1;
  if (l1) {
    await guard("l1 gas", async () => {
      const min = parseEther(deps.config.L1_MIN_GAS_BALANCE);
      for (const a of await l1.balances()) {
        add(`${a.name} gas`, level(a.balance < min / 5n, a.balance < min), `${fmt(a.balance)} on the L1 (warn below ${fmt(min)})`);
      }
    });
  }

  {
    const c = deps.config;
    const android = c.ANDROID_SIGNING_CERT_SHA256 ? "hardware key attestation" : c.GOOGLE_SERVICE_ACCOUNT_JSON ? "Play Integrity" : null;
    const ios = c.APPLE_TEAM_ID ? "App Attest" : null;
    // Without a configured check no real phone can attest; that only matters in production.
    add("device checks", android || ios || c.NODE_ENV !== "production" ? "ok" : "warn",
      [`Android: ${android ?? "not configured"}`, `iOS: ${ios ?? "not configured"}`].join("; ") + (c.ALLOW_DEV_ATTESTATION ? "; development tokens allowed" : ""));
  }

  await guard("settlement", async () => {
    const meta = (await deps.db.query<{ last_settled_day: bigint | null }>("SELECT last_settled_day FROM ledger_meta WHERE id = 1")).rows[0];
    const start = deps.schedule.startTime;
    // The newest day whose settlement is due: its end plus the grace period has passed.
    const elapsed = now - start - SETTLE_GRACE_SECONDS;
    const dueDay = elapsed < 86_400n ? -1n : elapsed / 86_400n - 1n;
    const last = meta?.last_settled_day ?? -1n;
    if (dueDay < 0n) return add("settlement", "ok", "no day due yet");
    const behind = dueDay - last;
    const overdueBy = now - (start + (dueDay + 1n) * 86_400n + SETTLE_GRACE_SECONDS);
    add("settlement", behind <= 0n ? "ok" : level(overdueBy > 3600n || behind > 1n, true),
      behind <= 0n ? `settled through day ${last}` : `${behind} day(s) behind; day ${last + 1n} due ${mins(overdueBy)} ago`);
    const latest = (await deps.db.query<{ day: bigint; stats: { alerts?: string[] } }>(
      "SELECT day, stats FROM settlements ORDER BY day DESC LIMIT 1",
    )).rows[0];
    const alerts = latest?.stats?.alerts ?? [];
    add("settlement alerts", alerts.length ? "warn" : "ok", alerts.length ? `day ${latest!.day}: ${alerts.slice(0, 3).join("; ")}` : "none");
  });

  await guard("publishing", async () => {
    const stuck = (await deps.db.query<{ day: bigint; created_at: bigint }>(
      "SELECT day, created_at FROM settlements WHERE status = 'computed' ORDER BY day LIMIT 1",
    )).rows[0];
    const vetoed = (await deps.db.query<{ day: bigint }>("SELECT day FROM settlements WHERE status = 'vetoed' AND created_at > $1 ORDER BY day DESC LIMIT 1", [now - 3n * 86_400n])).rows[0];
    if (!stuck) add("publishing", "ok", "every computed root is posted");
    else {
      const age = now - stuck.created_at;
      add("publishing", level(age > 3n * 3600n, age > 3600n), `day ${stuck.day} computed ${mins(age)} ago, not posted yet`);
    }
    if (vetoed) add("vetoes", "warn", `day ${vetoed.day} was vetoed in the last 3 days`);
  });

  // The publisher key signs outside this API (the signer service or KMS). A root on-chain that this
  // API did not compute means the key signed for someone else: the guardian vetoes it while it is pending.
  await guard("posted roots", async () => {
    const { active, pending } = await deps.chain.readRoots();
    const foreign: string[] = [];
    for (const [label, r] of [["pending", pending], ["active", active]] as const) {
      if (!r) continue;
      const ours = (await deps.db.query<{ root: string | null; total_entitled: string; data_hash: string }>(
        "SELECT root, total_entitled::text, data_hash FROM settlements WHERE day = $1",
        [r.day],
      )).rows[0];
      const same = ours?.root?.toLowerCase() === r.root.toLowerCase() && toBig(ours.total_entitled) === r.totalEntitled
        && ours.data_hash.toLowerCase() === r.dataHash.toLowerCase();
      if (!same) foreign.push(`the ${label} root for day ${r.day} is not the one computed here`);
    }
    if (foreign.length === 0) add("posted roots", "ok", pending || active ? "the roots on-chain are the ones computed here" : "no root posted yet");
    else add("posted roots", "critical", `${foreign.join("; ")}: ${pending && foreign[0]!.includes("pending") ? "veto it, " : ""}pause the distributor and stop the signer`);
  });

  await guard("queues", async () => {
    const q = (await deps.db.query<{
      claims: bigint; oldest_claim: bigint | null; sent: bigint; oldest_sent: bigint | null;
      faucet: bigint; oldest_faucet: bigint | null; faucet_failed: bigint; flags: bigint; bans: bigint; appeals: bigint;
    }>(
      `SELECT (SELECT count(*) FROM claims WHERE status = 'queued')::bigint AS claims,
              (SELECT min(created_at) FROM claims WHERE status = 'queued') AS oldest_claim,
              (SELECT count(*) FROM claims WHERE status = 'sent')::bigint AS sent,
              (SELECT min(updated_at) FROM claims WHERE status = 'sent') AS oldest_sent,
              (SELECT count(*) FROM faucet_requests WHERE status = 'queued')::bigint AS faucet,
              (SELECT min(created_at) FROM faucet_requests WHERE status = 'queued') AS oldest_faucet,
              (SELECT count(*) FROM faucet_requests WHERE status = 'failed' AND created_at > $1)::bigint AS faucet_failed,
              (SELECT count(*) FROM flags WHERE status = 'open')::bigint AS flags,
              (SELECT count(*) FROM admin_actions WHERE status = 'pending')::bigint AS bans,
              (SELECT count(*) FROM appeals WHERE status = 'open')::bigint AS appeals`,
      [now - 86_400n],
    )).rows[0]!;
    const claimAge = q.oldest_claim === null ? 0n : now - toBig(q.oldest_claim);
    // Claims wait for the next active root by design; only an old queue while a root is active is a problem.
    const { active } = await deps.chain.readRoots();
    add("claim queue", active ? level(claimAge > 3600n, claimAge > 600n) : "ok", `${q.claims} queued${q.claims ? `, oldest ${mins(claimAge)}` : ""}`);
    // A sent claim is closed within minutes, by its receipt or by the relayer's recovery; one that stays is stuck.
    const sentAge = q.oldest_sent === null ? 0n : now - toBig(q.oldest_sent);
    add("claims in flight", level(sentAge > 7200n, sentAge > 1800n), `${q.sent} sent, not confirmed${q.sent ? `, oldest ${mins(sentAge)}` : ""}`);
    const faucetAge = q.oldest_faucet === null ? 0n : now - toBig(q.oldest_faucet);
    add("faucet queue", level(faucetAge > 3600n, faucetAge > 1800n), `${q.faucet} queued${q.faucet ? `, oldest ${mins(faucetAge)}` : ""}`);
    add("faucet failures", level(q.faucet_failed >= 20n, q.faucet_failed > 0n), `${q.faucet_failed} failed in the last day`);
    add("moderation", "ok", `${q.flags} open flags, ${q.bans} pending bans, ${q.appeals} open appeals`);
  });

  await guard("x sign-ins", async () => {
    const used = BigInt((await deps.db.query<{ exchanges: number }>("SELECT exchanges FROM x_signin_days WHERE day = $1", [now / 86_400n])).rows[0]?.exchanges ?? 0);
    const limit = BigInt(deps.config.X_DAILY_SIGNIN_LIMIT);
    add("x sign-ins", level(used >= limit, used * 5n >= limit * 4n), `${used} of ${limit} today${used >= limit ? ": sign-in is refused until 00:00 UTC (X_DAILY_SIGNIN_LIMIT)" : ""}`);
  });

  await guard("jobs", async () => {
    const rows = new Map((await deps.db.query<{ name: string; last_success: bigint | null; last_error: string | null; failures: number }>(
      "SELECT name, last_success, last_error, failures FROM job_runs",
    )).rows.map((r) => [r.name, r]));
    for (const j of expectedJobs(deps)) {
      const r = rows.get(j.name);
      if (!r || r.last_success === null) {
        add(`job ${j.name}`, r?.failures ? "critical" : "warn", r?.last_error ? `never succeeded: ${r.last_error}` : "has not run yet");
        continue;
      }
      const age = now - toBig(r.last_success);
      const status = level(age > j.criticalAfter || r.failures >= 5, age > j.warnAfter || r.failures > 0);
      add(`job ${j.name}`, status, `last success ${age} s ago${r.failures ? `; ${r.failures} failure(s) since: ${r.last_error}` : ""}`);
    }
  });

  const pay = paymentConfig(deps.config);
  if (pay) {
    await guard("payments", async () => {
      const q = (await deps.db.query<{ review: bigint; unmatched: bigint }>(
        `SELECT (SELECT count(*) FROM orders WHERE status = 'review')::bigint AS review,
                (SELECT count(*) FROM payments WHERE outcome IN ('unknown_order', 'not_open') AND refund_tx IS NULL)::bigint AS unmatched`,
      )).rows[0]!;
      add("payments review", q.review || q.unmatched ? "warn" : "ok", `${q.review} orders in review, ${q.unmatched} unmatched payments to refund`);
      const wrong = (await deps.db.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM payments WHERE outcome = 'wrong_treasury'")).rows[0]!.n;
      if (wrong > 0n) add("payment treasury", "critical", `${wrong} payment(s) made while the router's treasury was not ${pay.treasury}`);
      const cur = (await deps.db.query<{ last_block: bigint; treasury: string | null }>(
        "SELECT last_block, treasury FROM payment_cursor WHERE router = $1",
        [pay.router],
      )).rows[0];
      if (cur?.treasury && cur.treasury.toLowerCase() !== pay.treasury.toLowerCase()) {
        add("router treasury", "critical", `the router forwards to ${cur.treasury}, expected ${pay.treasury}: pause it unless planned`);
      }
      if (deps.payments) {
        const safe = await deps.payments.safeBlock();
        const lag = safe - (cur?.last_block ?? pay.startBlock - 1n);
        add("payment watcher", level(lag > 20_000n, lag > 2_000n), `${lag} final blocks not read yet`);
      }
    });
  }

  return { status: worst(checks.map((c) => c.status)), checkedAt: now, checks };
}
