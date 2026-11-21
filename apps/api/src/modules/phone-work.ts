/**
 * The work a phone does for a mining session.
 * - A puzzle: find a counter for which sha256("<challenge nonce>:<counter>") starts with `bits` zero
 *   bits. A few seconds on a phone; it makes starting sessions in bulk cost computing time.
 * - A chain check: rebuild a state root posted on BSC from LONGYU's own data (see chain-check.ts).
 * Neither changes what a session earns. A phone that rebuilds a root which this API's own node does
 * not rebuild either has found a real disagreement between the chain and BSC: that is recorded and
 * reported, and the phone is not turned away for it.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Deps } from "../context.ts";
import { HttpError } from "../lib/util.ts";
import { CHECK_WINDOW, outputRootOf, type RootParts } from "../services/chain-check.ts";

const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/) as unknown as z.ZodType<`0x${string}`>;
export const PartsSchema = z.object({ stateRoot: hash32, messagePasserRoot: hash32, blockHash: hash32 });
export const CounterSchema = z.string().regex(/^\d{1,15}$/);

export function puzzleSolved(nonce: string, counter: string, bits: number): boolean {
  const digest = createHash("sha256").update(`${nonce}:${counter}`).digest();
  let left = bits;
  for (const byte of digest) {
    if (left <= 0) return true;
    if (left >= 8) {
      if (byte !== 0) return false;
      left -= 8;
    } else {
      return byte >> (8 - left) === 0;
    }
  }
  return left <= 0;
}

/** Whether this kind of device must do the work; others may, and are held to it when they do. */
export function workRequired(deps: Deps, platform: string): boolean {
  return deps.config.PHONE_WORK_PLATFORMS.split(",").map((p) => p.trim()).includes(platform);
}

export type CheckOutcome = "match" | "chain_mismatch" | "wrong";

/** Compares rebuilt parts with the state root posted at `index`. Throws when BSC cannot be read. */
export async function checkOutput(deps: Deps, index: bigint, parts: RootParts): Promise<CheckOutcome> {
  const checker = deps.chainCheck;
  if (!checker) throw new HttpError(503, "chain_check_off");
  if (index + CHECK_WINDOW < (await checker.latest())) throw new HttpError(400, "output_too_old");
  const posted = await checker.output(index);
  if (!posted) throw new HttpError(400, "output_unknown");
  if (outputRootOf(parts).toLowerCase() === posted.root.toLowerCase()) return "match";
  const own = outputRootOf(await checker.partsAt(posted.l2Block));
  if (own.toLowerCase() === posted.root.toLowerCase()) return "wrong";
  const added = await deps.db.query(
    `INSERT INTO chain_check_alerts (output_index, l2_block, posted_root, computed_root, found_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (output_index) DO NOTHING RETURNING output_index`,
    [index, posted.l2Block, posted.root, own, deps.clock.now()],
  );
  if (added.rows[0]) {
    await deps.notifier.notify(
      "State root mismatch",
      `The state root posted on BSC at index ${index} (LONGYU block ${posted.l2Block}) is ${posted.root}, but LONGYU's own node rebuilds ${own}. A phone found it first. Check the proposer and, if the posted root is wrong, delete it with the challenger key before withdrawals can use it.`,
    );
  }
  return "chain_mismatch";
}
