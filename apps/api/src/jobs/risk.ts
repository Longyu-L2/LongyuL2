/**
 * Risk rules run on each closed day before settlement. "hold" flags keep a user's rewards out of
 * the day's root until an admin clears them; "watch" flags only feed reviews.
 */
import { getAddress } from "viem";
import type { Deps } from "../context.ts";
import { uuid } from "../lib/util.ts";

async function flag(deps: Deps, userId: string, kind: string, severity: "watch" | "hold", day: bigint, detail: object) {
  await deps.db.query(
    `INSERT INTO flags (id, user_id, kind, severity, detail, day, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, kind, day) DO NOTHING`,
    [uuid(), userId, kind, severity, JSON.stringify(detail), day, deps.clock.now()],
  );
}

export async function runRiskRules(deps: Deps, day: bigint): Promise<number> {
  let count = 0;

  // 1. One app install used by more than one account that mined that day. Only sessions of the day
  // count: an account that once signed in on the install, or mined from another device, is left out.
  const shared = await deps.db.query<{ user_id: string; install_id: string; users: bigint }>(
    `SELECT DISTINCT m.user_id, d.install_id, x.users FROM mining_sessions m
     JOIN devices d ON d.id = m.device_id
     JOIN (SELECT d2.install_id, count(DISTINCT m2.user_id)::bigint AS users FROM mining_sessions m2
           JOIN devices d2 ON d2.id = m2.device_id
           WHERE m2.credited_day = $1 GROUP BY d2.install_id HAVING count(DISTINCT m2.user_id) > 1) x ON x.install_id = d.install_id
     WHERE m.credited_day = $1`,
    [day],
  );
  for (const r of shared.rows) {
    // A flag an admin cleared for an install is not raised again for that install.
    const cleared = await deps.db.query(
      "SELECT 1 FROM flags WHERE user_id = $1 AND kind = 'shared_device' AND status = 'cleared' AND detail->>'installId' = $2 LIMIT 1",
      [r.user_id, r.install_id],
    );
    if (cleared.rows[0]) continue;
    await flag(deps, r.user_id, "shared_device", "hold", day, { installId: r.install_id, users: Number(r.users) });
    count++;
  }

  // 2. Many accounts mining from one network address.
  const clusters = await deps.db.query<{ user_id: string; ip: string; users: bigint }>(
    `SELECT m.user_id, m.ip, x.users FROM mining_sessions m
     JOIN (SELECT ip, count(DISTINCT user_id)::bigint AS users FROM mining_sessions WHERE credited_day = $1 AND ip IS NOT NULL
           GROUP BY ip HAVING count(DISTINCT user_id) > $2) x ON x.ip = m.ip
     WHERE m.credited_day = $1`,
    [day, deps.config.RISK_IP_CLUSTER_LIMIT],
  );
  for (const r of clusters.rows) {
    await flag(deps, r.user_id, "ip_cluster", "watch", day, { ip: r.ip, users: Number(r.users) });
    count++;
  }

  // 3. Repeated attestation failures on the device the account mined from that day. A device it
  // did not mine from (an old phone, say) does not hold the account.
  const failing = await deps.db.query<{ user_id: string; failures: number }>(
    `SELECT m.user_id, max(d.attestation_failures) AS failures FROM mining_sessions m
     JOIN devices d ON d.id = m.device_id
     WHERE m.credited_day = $1 AND d.attestation_failures >= $2
     GROUP BY m.user_id`,
    [day, deps.config.RISK_ATTESTATION_FAILURES],
  );
  for (const r of failing.rows) {
    await flag(deps, r.user_id, "attestation_failures", "hold", day, { failures: r.failures });
    count++;
  }

  // 4. Machine-regular start times: the same second of the day, session after session.
  const timing = await deps.db.query<{ user_id: string; sd: number; n: bigint }>(
    `SELECT user_id, stddev_samp((started_at % 86400)::float8) AS sd, count(*)::bigint AS n FROM (
       SELECT user_id, started_at, row_number() OVER (PARTITION BY user_id ORDER BY started_at DESC) AS rn
       FROM mining_sessions WHERE user_id IN (SELECT user_id FROM mining_sessions WHERE credited_day = $1)
     ) t WHERE rn <= 14 GROUP BY user_id HAVING count(*) >= 10`,
    [day],
  );
  for (const r of timing.rows) {
    if (r.sd !== null && r.sd < deps.config.RISK_TIMING_STDDEV_SECONDS) {
      await flag(deps, r.user_id, "regular_timing", "watch", day, { stddevSeconds: r.sd, sessions: Number(r.n) });
      count++;
    }
  }

  count += await walletSweep(deps, day);
  return count;
}

/** Every address each user has linked, now or before. */
const OWNERS = `SELECT user_id, address FROM wallets
                UNION SELECT user_id, from_address FROM wallet_changes
                UNION SELECT user_id, to_address FROM wallet_changes`;

/**
 * 5. Wallet sweep: many accounts sending rewards to one destination within the window, the
 * pattern of one person collecting a farm's output.
 * - An ordinary address (no code) puts the senders, and any account that owns the destination, on hold.
 * - A contract (a bridge, a DEX, a multisig) only raises watch flags, so a popular contract cannot
 *   freeze its users.
 * - Allowlisted addresses and LONGYU's own contracts are skipped.
 * - A flag an admin cleared for a destination is not raised again for that destination.
 */
async function walletSweep(deps: Deps, day: bigint): Promise<number> {
  const { SWEEP_MIN_ACCOUNTS: minAccounts, SWEEP_WINDOW_DAYS: windowDays } = deps.config;
  const dayEnd = deps.schedule.startTime + (day + 1n) * 86_400n;
  const since = dayEnd - BigInt(windowDays) * 86_400n;
  const skip = new Set(
    [...deps.config.SWEEP_ALLOWLIST.split(","), deps.config.DISTRIBUTOR_ADDRESS, deps.config.FAUCET_ADDRESS, deps.config.PAYMENT_ROUTER_ADDRESS, deps.config.TREASURY_ADDRESS]
      .map((a) => a?.trim())
      .filter((a): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a))
      .map((a) => getAddress(a)),
  );
  const destinations = (await deps.db.query<{ to_address: string; accounts: bigint; total: string }>(
    `SELECT t.to_address, count(DISTINCT o.user_id)::bigint AS accounts, sum(t.amount)::text AS total
     FROM wallet_transfers t JOIN (${OWNERS}) o ON o.address = t.from_address
     WHERE t.block_time >= $1 AND t.block_time < $2
     GROUP BY t.to_address HAVING count(DISTINCT o.user_id) >= $3`,
    [since, dayEnd, minAccounts],
  )).rows;
  let count = 0;
  for (const d of destinations) {
    const destination = getAddress(d.to_address);
    if (skip.has(destination)) continue;
    const contract = await deps.chain.isContract(destination);
    const severity = contract ? "watch" : "hold";
    const detail = { destination, accounts: Number(d.accounts), totalWei: d.total, windowDays, contract };
    const senders = (await deps.db.query<{ user_id: string }>(
      `SELECT DISTINCT o.user_id FROM wallet_transfers t JOIN (${OWNERS}) o ON o.address = t.from_address
       WHERE t.to_address = $1 AND t.block_time >= $2 AND t.block_time < $3`,
      [destination, since, dayEnd],
    )).rows.map((r) => ({ userId: r.user_id, role: "sender" }));
    const receivers = (await deps.db.query<{ user_id: string }>(`SELECT DISTINCT user_id FROM (${OWNERS}) o WHERE o.address = $1`, [destination]))
      .rows.map((r) => ({ userId: r.user_id, role: "receiver" }));
    const flagged = new Set<string>();
    for (const { userId, role } of [...receivers, ...senders]) {
      if (flagged.has(userId)) continue;
      flagged.add(userId);
      const cleared = await deps.db.query(
        "SELECT 1 FROM flags WHERE user_id = $1 AND kind = 'wallet_sweep' AND status = 'cleared' AND detail->>'destination' = $2 LIMIT 1",
        [userId, destination],
      );
      if (cleared.rows[0]) continue;
      await flag(deps, userId, "wallet_sweep", severity, day, { ...detail, role });
      count++;
    }
  }
  return count;
}
