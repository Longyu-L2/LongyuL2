/** Jobs that talk to the chain: publish roots, relay claims, index events, send reminders. */
import { getAddress, type Hex } from "viem";
import type { RootInfo } from "../services/chain.ts";
import { hashJson, type Address } from "@longyu/reward-engine";
import type { Deps } from "../context.ts";
import { TxError, type DistributorEvent } from "../services/chain.ts";
import { toBig } from "../lib/util.ts";
import { clearRootCache } from "../modules/mining.ts";
import { rootFilePath } from "./settlement.ts";

const RELAY_BATCH = 100;
const INDEX_RANGE = 5_000n;
/** A relayer run holds its lease for 10 minutes: a claim marked sent longer ago belongs to no live run. */
export const SENT_STALE_SECONDS = 600n;
/** A claim transaction with no receipt after this long is taken as dropped, and its claims are sent again. */
export const SENT_DROPPED_SECONDS = 3600n;
/** Unsettled claim transactions looked up per run. */
const RECOVER_BATCH = 20;
/** A faucet drip is tried this many times before it is given up. */
export const FAUCET_MAX_ATTEMPTS = 5;
/** A drip's voucher is good for 10 minutes: this long after sending, an unconfirmed drip can no longer land. */
export const FAUCET_UNCONFIRMED_WAIT = 900n;

/**
 * Posts the newest computed settlement. Roots are cumulative, so if the publisher fell behind,
 * older computed days are superseded by the newest one.
 */
export async function publishNext(deps: Deps): Promise<bigint | null> {
  const computed = (await deps.db.query<{ day: bigint; root: Hex; total_entitled: string; data_hash: Hex; data_uri: string }>(
    "SELECT day, root, total_entitled::text, data_hash, data_uri FROM settlements WHERE status = 'computed' ORDER BY day DESC",
  )).rows;
  const newest = computed[0];
  if (!newest) return null;
  const { active, pending } = await deps.chain.readRoots();
  if (pending) return null; // wait for the previous root to clear its veto window
  if (active && active.day >= newest.day) {
    await deps.db.query("UPDATE settlements SET status = 'superseded' WHERE status = 'computed' AND day <= $1", [active.day]);
    return null;
  }
  // The URI goes on-chain for good: post only if the stored file is there and matches the hash.
  const path = rootFilePath(newest.day, newest.data_hash);
  const body = await deps.files.get(path);
  if (body === null || hashJson(body) !== newest.data_hash || deps.files.url(path) !== newest.data_uri) {
    throw new Error(`data file for day ${newest.day} is missing or does not match its hash; not posting`);
  }
  const txHash = await deps.chain.proposeRoot(newest.day, newest.root, toBig(newest.total_entitled), newest.data_hash, newest.data_uri);
  await deps.db.tx(async (q) => {
    await q.query("UPDATE settlements SET status = 'posted', tx_hash = $1, posted_at = $2 WHERE day = $3", [
      txHash, deps.clock.now(), newest.day,
    ]);
    await q.query("UPDATE settlements SET status = 'superseded' WHERE status = 'computed' AND day < $1", [newest.day]);
  });
  return newest.day;
}

/** True when `r` is the root computed here for its day: the same root, total and data hash. */
export async function isComputedHere(deps: Deps, r: RootInfo): Promise<boolean> {
  const ours = (await deps.db.query<{ root: string | null; total_entitled: string; data_hash: string }>(
    "SELECT root, total_entitled::text, data_hash FROM settlements WHERE day = $1",
    [r.day],
  )).rows[0];
  return !!ours && ours.root?.toLowerCase() === r.root.toLowerCase() && toBig(ours.total_entitled) === r.totalEntitled
    && ours.data_hash.toLowerCase() === r.dataHash.toLowerCase();
}

/**
 * The automatic watch. The publisher key signs outside this API, so a root on chain that was not
 * computed here means the key signed for someone else. The watch key, which holds only the guardian
 * role, then vetoes a waiting root and pauses the distributor; an active one can only be paused.
 * Only the admin can unpause. Returns what was found, or null when every root is ours.
 */
export async function watchRoots(deps: Deps): Promise<string | null> {
  const { active, pending } = await deps.chain.readRoots();
  const foreign: string[] = [];
  for (const [label, r] of [["waiting", pending], ["active", active]] as const) {
    if (r && !(await isComputedHere(deps, r))) foreign.push(`the ${label} root for day ${r.day}`);
  }
  if (foreign.length === 0) return null;
  const found = `${foreign.join(" and ")} ${foreign.length > 1 ? "were" : "was"} not computed here`;
  const { vetoed, paused } = await deps.chain.stopRoots();
  if (vetoed || paused) {
    const done = [vetoed && `vetoed it in ${vetoed}`, paused && `paused the distributor in ${paused}`].filter(Boolean).join(" and ");
    await deps.notifier.notify("Mining root stopped", `${found}. The watch ${done}. Replace the publisher key, then unpause with the admin key.`);
  }
  return found;
}

/** Closes the claims of one mined claimMany transaction from its events. Rows already closed are left alone. */
async function settleClaims(
  deps: Deps,
  txHash: Hex,
  events: DistributorEvent[],
  items: { id: string; account: string; cumulative: bigint }[],
): Promise<number> {
  const paid = new Set(events.filter((e) => e.kind === "claimed").map((e) => (e as { account: string }).account.toLowerCase()));
  for (const i of items) {
    const ok = paid.has(i.account.toLowerCase());
    await deps.db.query(
      "UPDATE claims SET status = $1, tx_hash = $2, error = $3, updated_at = $4 WHERE id = $5 AND status = 'sent'",
      [ok ? "confirmed" : "skipped", txHash, ok ? null : "skipped_by_contract", deps.clock.now(), i.id],
    );
    if (ok) await recordClaimed(deps, i.account, i.cumulative);
  }
  return paid.size;
}

/**
 * Picks up claims a run left in 'sent': the process stopped, or the transaction went out and was not
 * seen to confirm. Nothing here can pay twice: the contract pays the difference to a cumulative total.
 */
export async function recoverSentClaims(deps: Deps): Promise<void> {
  const now = deps.clock.now();
  const stale = now - SENT_STALE_SECONDS;
  // Never sent (no transaction hash). Paid in the meantime some other way: closed. Otherwise back in the queue.
  await deps.db.query(
    `UPDATE claims c SET status = 'confirmed', updated_at = $1
     WHERE c.status = 'sent' AND c.tx_hash IS NULL AND c.updated_at < $2
       AND EXISTS (SELECT 1 FROM claimed_onchain o WHERE o.address = c.address AND o.cumulative >= c.cumulative)`,
    [now, stale],
  );
  await deps.db.query(
    `UPDATE claims SET status = 'queued', error = 'requeued: marked sent, no transaction', updated_at = $1
     WHERE status = 'sent' AND tx_hash IS NULL AND updated_at < $2`,
    [now, stale],
  );
  // Sent, outcome not recorded: the receipt decides.
  const open = (await deps.db.query<{ tx_hash: Hex; since: bigint }>(
    `SELECT tx_hash, min(updated_at) AS since FROM claims
     WHERE status = 'sent' AND tx_hash IS NOT NULL AND updated_at < $1 GROUP BY tx_hash ORDER BY since LIMIT $2`,
    [stale, RECOVER_BATCH],
  )).rows;
  for (const tx of open) {
    const outcome = await deps.chain.sentTx(tx.tx_hash);
    if (outcome === null) {
      // Still no receipt. After an hour it is taken as dropped; should it land after all, the resend pays nothing extra.
      if (toBig(tx.since) < now - SENT_DROPPED_SECONDS) {
        await deps.db.query(
          "UPDATE claims SET status = 'queued', tx_hash = NULL, error = $1, updated_at = $2 WHERE status = 'sent' AND tx_hash = $3",
          [`requeued: transaction ${tx.tx_hash} not found`, now, tx.tx_hash],
        );
      }
      continue;
    }
    if (!outcome.success) {
      await deps.db.query("UPDATE claims SET status = 'failed', error = $1, updated_at = $2 WHERE status = 'sent' AND tx_hash = $3", [
        `transaction ${tx.tx_hash} reverted`, now, tx.tx_hash,
      ]);
      continue;
    }
    const rows = (await deps.db.query<{ id: string; address: string; cumulative: string }>(
      "SELECT id, address, cumulative::text FROM claims WHERE status = 'sent' AND tx_hash = $1",
      [tx.tx_hash],
    )).rows;
    await settleClaims(deps, tx.tx_hash, outcome.events, rows.map((r) => ({ id: r.id, account: r.address, cumulative: toBig(r.cumulative) })));
  }
}

/** Sends queued claims in one batch against the active root. Users pay no gas. */
export async function relayClaims(deps: Deps): Promise<number> {
  await recoverSentClaims(deps);
  const { active } = await deps.chain.readRoots();
  if (!active) return 0;
  const queued = (await deps.db.query<{ id: string; address: string }>(
    "SELECT id, address FROM claims WHERE status = 'queued' ORDER BY created_at LIMIT $1",
    [RELAY_BATCH],
  )).rows;
  if (queued.length === 0) return 0;

  const now = deps.clock.now();
  const items: { id: string; account: Address; cumulative: bigint; proof: Hex[] }[] = [];
  for (const c of queued) {
    const p = (await deps.db.query<{ cumulative: string; proof: Hex[] }>(
      "SELECT cumulative::text, proof FROM proofs WHERE day = $1 AND address = $2",
      [active.day, c.address],
    )).rows[0];
    const onchain = (await deps.db.query<{ cumulative: string }>("SELECT cumulative::text FROM claimed_onchain WHERE address = $1", [
      c.address,
    ])).rows[0];
    if (!p || toBig(p.cumulative) <= (onchain ? toBig(onchain.cumulative) : 0n)) {
      await deps.db.query("UPDATE claims SET status = 'skipped', error = 'nothing_to_claim', updated_at = $1 WHERE id = $2", [now, c.id]);
      continue;
    }
    items.push({ id: c.id, account: getAddress(c.address) as Address, cumulative: toBig(p.cumulative), proof: p.proof });
  }
  if (items.length === 0) return 0;
  for (const i of items) {
    await deps.db.query("UPDATE claims SET status = 'sent', day = $1, cumulative = $2::numeric, updated_at = $3 WHERE id = $4", [
      active.day, i.cumulative.toString(), now, i.id,
    ]);
  }
  const ids = items.map((i) => i.id);
  // The hash is stored the moment the transaction is out, so a run that dies while waiting leaves a trail.
  const noteSent = async (txHash: Hex): Promise<void> => {
    await deps.db.query("UPDATE claims SET tx_hash = $1, updated_at = $2 WHERE id = ANY($3::uuid[]) AND status = 'sent'", [
      txHash, deps.clock.now(), ids,
    ]);
  };
  try {
    const { txHash, events } = await deps.chain.claimMany(items, noteSent);
    return await settleClaims(deps, txHash, events, items);
  } catch (e) {
    const error = (e as Error).message.slice(0, 500);
    if (e instanceof TxError && e.kind === "unconfirmed") {
      // It is out and may still be mined: the claims stay open under its hash until a receipt settles them.
      await deps.db.query(
        "UPDATE claims SET tx_hash = $1, error = $2, updated_at = $3 WHERE id = ANY($4::uuid[]) AND status = 'sent'",
        [e.txHash, error, deps.clock.now(), ids],
      );
    } else {
      // Refused or reverted by the contract, or never sent: nothing was paid.
      await deps.db.query(
        "UPDATE claims SET status = 'failed', tx_hash = COALESCE($1, tx_hash), error = $2, updated_at = $3 WHERE id = ANY($4::uuid[]) AND status = 'sent'",
        [e instanceof TxError ? e.txHash ?? null : null, error, deps.clock.now(), ids],
      );
    }
    throw e;
  }
}

async function recordClaimed(deps: Deps, address: string, cumulative: bigint): Promise<void> {
  await deps.db.query(
    `INSERT INTO claimed_onchain (address, cumulative) VALUES ($1, $2::numeric)
     ON CONFLICT (address) DO UPDATE SET cumulative = GREATEST(claimed_onchain.cumulative, EXCLUDED.cumulative)`,
    [getAddress(address), cumulative.toString()],
  );
}

/** Follows distributor events: claims made by anyone (including direct claims), activations, vetoes. */
export async function indexEvents(deps: Deps, startBlock = 0n): Promise<number> {
  const cursor = (await deps.db.query<{ block: bigint }>("SELECT block FROM chain_cursor WHERE name = 'distributor'")).rows[0];
  const from = cursor ? cursor.block + 1n : startBlock;
  const latest = await deps.chain.latestBlock();
  if (from > latest) return 0;
  const to = latest - from > INDEX_RANGE ? from + INDEX_RANGE : latest;
  const events = await deps.chain.distributorEvents(from, to);
  for (const e of events) {
    if (e.kind === "claimed") {
      await recordClaimed(deps, e.account, e.cumulative);
      await deps.db.query(
        "UPDATE claims SET status = 'confirmed', tx_hash = $1, updated_at = $2 WHERE address = $3 AND status = 'sent'",
        [e.txHash, deps.clock.now(), getAddress(e.account)],
      );
    } else if (e.kind === "activated") {
      await deps.db.query("UPDATE settlements SET status = 'active' WHERE day = $1", [e.day]);
      clearRootCache();
    } else if (e.kind === "vetoed") {
      await deps.db.query("UPDATE settlements SET status = 'vetoed' WHERE day = $1", [e.day]);
    }
  }
  await deps.db.query(
    "INSERT INTO chain_cursor (name, block) VALUES ('distributor', $1) ON CONFLICT (name) DO UPDATE SET block = $1",
    [to],
  );
  // The contract promotes a matured root lazily, so read which root is claimable right now.
  const { active } = await deps.chain.readRoots();
  if (active) {
    await deps.db.query(
      `UPDATE settlements SET status = CASE WHEN day = $1 THEN 'active' ELSE 'superseded' END
       WHERE status IN ('posted', 'active') AND day <= $1`,
      [active.day],
    );
    clearRootCache();
  }
  return events.length;
}

/**
 * Sends queued faucet drips. Runs inside the relayer job: the relayer key is used by one job only.
 * A drip that fails for a passing reason (the RPC, the signer) stays queued and is tried again
 * later, a few times; one the contract refuses, or that reverts, fails at once.
 */
export async function processFaucet(deps: Deps): Promise<number> {
  const queued = (await deps.db.query<{ id: string; address: string; attempts: number; tx_hash: Hex | null }>(
    `SELECT id, address, attempts, tx_hash FROM faucet_requests
     WHERE status = 'queued' AND next_attempt_at <= $1 ORDER BY created_at LIMIT 20`,
    [deps.clock.now()],
  )).rows;
  let sent = 0;
  for (const r of queued) {
    try {
      // An earlier try went out and was not seen to confirm. Its voucher has expired by now, so its
      // receipt is final: paid, or it never will be.
      const earlier = r.tx_hash ? await deps.chain.sentTx(r.tx_hash) : null;
      const txHash = earlier?.success ? r.tx_hash! : await deps.chain.dripFaucet(getAddress(r.address) as Address, deps.config.FAUCET_DRIP_WEI);
      await deps.db.query("UPDATE faucet_requests SET status = 'sent', tx_hash = $1, error = NULL WHERE id = $2", [txHash, r.id]);
      sent++;
    } catch (e) {
      const now = deps.clock.now();
      const attempts = r.attempts + 1;
      const error = (e as Error).message.slice(0, 500);
      const unconfirmed = e instanceof TxError && e.kind === "unconfirmed";
      const permanent = e instanceof TxError && !unconfirmed;
      if (permanent || attempts >= FAUCET_MAX_ATTEMPTS) {
        await deps.db.query("UPDATE faucet_requests SET status = 'failed', attempts = $1, error = $2 WHERE id = $3", [attempts, error, r.id]);
        continue;
      }
      // Wait 1, 2, 4, 8 minutes between tries; after an unconfirmed send, until its voucher is dead.
      const wait = unconfirmed ? FAUCET_UNCONFIRMED_WAIT : 60n * 2n ** BigInt(attempts - 1);
      await deps.db.query(
        "UPDATE faucet_requests SET attempts = $1, error = $2, next_attempt_at = $3, tx_hash = COALESCE($4, tx_hash) WHERE id = $5",
        [attempts, error, now + wait, unconfirmed ? (e as TxError).txHash ?? null : null, r.id],
      );
    }
  }
  return sent;
}

/**
 * Housekeeping: drop challenges and X sign-in attempts that expired more than a day ago, and the
 * per-client sign-in counts of days before yesterday.
 */
export async function cleanup(deps: Deps): Promise<void> {
  await deps.db.query("DELETE FROM challenges WHERE expires_at < $1", [deps.clock.now() - 86_400n]);
  await deps.db.query("DELETE FROM x_logins WHERE expires_at < $1", [deps.clock.now() - 86_400n]);
  await deps.db.query("DELETE FROM x_signin_clients WHERE day < $1", [deps.clock.now() / 86_400n - 1n]);
}

/** Tells users when their 24-hour session has ended, once per session. */
export async function sendReminders(deps: Deps): Promise<number> {
  const now = deps.clock.now();
  const due = (await deps.db.query<{ user_id: string; credited_day: bigint; token: string }>(
    `SELECT m.user_id, m.credited_day, p.token FROM mining_sessions m
     JOIN push_tokens p ON p.user_id = m.user_id
     WHERE m.started_at BETWEEN $1 AND $2
       AND NOT EXISTS (SELECT 1 FROM mining_sessions n WHERE n.user_id = m.user_id AND n.started_at > m.started_at)
       AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.user_id = m.user_id AND r.day = m.credited_day)`,
    [now - 25n * 3600n, now - 24n * 3600n],
  )).rows;
  if (due.length === 0) return 0;
  await deps.push.send(due.map((d) => ({ to: d.token, title: "Mining session ended", body: "Tap to start today's session." })));
  for (const d of due) {
    await deps.db.query("INSERT INTO reminders (user_id, day) VALUES ($1,$2) ON CONFLICT DO NOTHING", [d.user_id, d.credited_day]);
  }
  return due.length;
}
