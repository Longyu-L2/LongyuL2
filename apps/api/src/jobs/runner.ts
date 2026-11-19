import { hostname } from "node:os";
import type { Deps } from "../context.ts";
import { cleanup, indexEvents, processFaucet, publishNext, relayClaims, sendReminders } from "./chain-jobs.ts";
import { settleNextDay } from "./settlement.ts";
import { watchPayments } from "./payments.ts";
import { indexTransfers } from "./transfers.ts";

interface Job {
  name: string;
  everyMs: number;
  /** How long one run may hold the job's lease. */
  leaseSeconds: number;
  run: (deps: Deps) => Promise<unknown>;
}

export const JOBS: Job[] = [
  { name: "indexer", everyMs: 5_000, leaseSeconds: 300, run: (d) => indexEvents(d) },
  // Settling a large day takes minutes; the long lease stops a second instance starting the same day.
  { name: "settlement", everyMs: 60_000, leaseSeconds: 2 * 3600, run: settleNextDay },
  { name: "publisher", everyMs: 60_000, leaseSeconds: 600, run: publishNext },
  // Claims and faucet drips share the relayer key, so they share one job and one lease.
  { name: "relayer", everyMs: 15_000, leaseSeconds: 600, run: async (d) => { await relayClaims(d); await processFaucet(d); } },
  { name: "payments", everyMs: 30_000, leaseSeconds: 300, run: watchPayments },
  { name: "transfers", everyMs: 30_000, leaseSeconds: 300, run: indexTransfers },
  { name: "maintenance", everyMs: 10 * 60_000, leaseSeconds: 600, run: async (d) => { await sendReminders(d); await cleanup(d); } },
];

const holder = `${hostname()}:${process.pid}`;

/** A database lease so that only one API instance runs each job at a time. */
async function acquire(deps: Deps, name: string, ttlSeconds: bigint): Promise<boolean> {
  const now = deps.clock.now();
  const { rows } = await deps.db.query<{ name: string }>(
    `INSERT INTO job_locks (name, holder, expires_at) VALUES ($1,$2,$3)
     ON CONFLICT (name) DO UPDATE SET holder = $2, expires_at = $3
       WHERE job_locks.expires_at < $4 OR job_locks.holder = $2
     RETURNING name`,
    [name, holder, now + ttlSeconds, now],
  );
  return rows.length > 0;
}

/** Records job heartbeats for the health endpoint. */
export async function beat(deps: Deps, name: string, event: "start" | "success" | "error", err?: unknown): Promise<void> {
  const now = deps.clock.now();
  if (event === "start") {
    await deps.db.query(
      "INSERT INTO job_runs (name, last_started) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET last_started = $2",
      [name, now],
    );
  } else if (event === "success") {
    await deps.db.query(
      "INSERT INTO job_runs (name, last_success, failures) VALUES ($1,$2,0) ON CONFLICT (name) DO UPDATE SET last_success = $2, failures = 0",
      [name, now],
    );
  } else {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await deps.db.query(
      `INSERT INTO job_runs (name, last_error, last_error_at, failures) VALUES ($1,$2,$3,1)
       ON CONFLICT (name) DO UPDATE SET last_error = $2, last_error_at = $3, failures = job_runs.failures + 1`,
      [name, message, now],
    );
  }
}

export function startJobs(deps: Deps, log: (msg: string, err?: unknown) => void): () => void {
  const timers: NodeJS.Timeout[] = [];
  for (const job of JOBS) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        if (await acquire(deps, job.name, BigInt(job.leaseSeconds))) {
          try {
            await beat(deps, job.name, "start");
            try {
              await job.run(deps);
            } catch (e) {
              await beat(deps, job.name, "error", e).catch(() => undefined);
              throw e;
            }
            await beat(deps, job.name, "success");
          } finally {
            // Release so the next tick (on any instance) can run without waiting for expiry.
            await deps.db.query("UPDATE job_locks SET expires_at = 0 WHERE name = $1 AND holder = $2", [job.name, holder]);
          }
        }
      } catch (e) {
        log(`job ${job.name} failed`, e);
      } finally {
        running = false;
      }
    };
    timers.push(setInterval(tick, job.everyMs));
    void tick();
  }
  return () => timers.forEach(clearInterval);
}
