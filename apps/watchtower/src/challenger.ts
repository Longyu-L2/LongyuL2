/**
 * The challenger: checks every state root posted on BSC before it finalizes, and deletes a wrong one,
 * with every root after it, before any withdrawal can be finalized against it. The honest proposer then
 * posts the right root again.
 * - Its own node derives the chain from the batches on BSC and trusts nothing the sequencer says; where
 *   it has reached a root's block, its answer decides.
 * - Where it has not, the root is rebuilt from a LONGYU RPC's data instead (the sequencer's: it catches
 *   a root posted with a stolen proposer key, not a lying sequencer).
 * - A root neither can check by the time it is close to finalizing is deleted too: one for a block that
 *   was never batched could otherwise finalize unchecked, and deleting a right root only costs a re-post.
 */
import type { Hex } from "viem";
import type { Check, Log } from "./checks.ts";

export interface OutputProposal {
  outputRoot: Hex;
  timestamp: bigint;
  l2BlockNumber: bigint;
}

export interface OracleView {
  nextOutputIndex(): Promise<bigint>;
  getL2Output(index: bigint): Promise<OutputProposal>;
  finalizationPeriodSeconds(): Promise<bigint>;
  /** Absent without the challenger key: the service then reports and deletes nothing. */
  deleteL2Outputs?: (index: bigint) => Promise<Hex>;
}

export interface VerifierView {
  /** The newest L2 block this source can rebuild a root for. */
  safeHead(): Promise<bigint>;
  outputAt(l2Block: bigint): Promise<Hex>;
}

export interface ChallengerDeps {
  oracle: OracleView;
  /** This service's own node. */
  verifier: VerifierView;
  /** A LONGYU RPC, used where the own node is behind. */
  fallback?: VerifierView;
  /** Unix seconds. */
  now(): bigint;
  /** Roots already found right, as "index:root"; kept by the caller between runs. */
  checked: Set<string>;
  /** A root still unchecked this close to finalizing is deleted. At most half the wait is used. */
  lateSeconds: bigint;
  log: Log;
}

/** More open roots than this means something is badly wrong, and is reported as critical. */
const MAX_OPEN = 200;

const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

export async function checkOutputs(d: ChallengerDeps): Promise<Check> {
  const name = "state roots on BSC";
  const next = await d.oracle.nextOutputIndex();
  if (next === 0n) return { name, status: "ok", detail: "No state root posted yet." };
  for (const k of d.checked) if (BigInt(k.split(":")[0]!) + BigInt(MAX_OPEN) < next) d.checked.delete(k);
  const period = await d.oracle.finalizationPeriodSeconds();
  const late = d.lateSeconds < period / 2n ? d.lateSeconds : period / 2n;
  const now = d.now();

  // Roots are posted in order of time, so the first finalized one going back ends the open ones.
  const open: { index: bigint; o: OutputProposal }[] = [];
  let capped = false;
  for (let i = next - 1n; i >= 0n; i--) {
    const o = await d.oracle.getL2Output(i);
    if (now - o.timestamp >= period) break;
    if (open.length === MAX_OPEN) {
      capped = true;
      break;
    }
    open.push({ index: i, o });
  }
  open.reverse();
  if (capped) {
    return { name, status: "critical", detail: `More than ${MAX_OPEN} state roots are waiting to finalize; the older ones are not checked. Check the proposer.` };
  }

  const own = open.length > 0 ? await d.verifier.safeHead() : 0n;
  const rpc = open.length > 0 && d.fallback ? await d.fallback.safeHead().catch(() => -1n) : -1n;
  let waiting = 0;
  for (const { index, o } of open) {
    const key = `${index}:${o.outputRoot.toLowerCase()}`;
    if (d.checked.has(key)) continue;
    const source = o.l2BlockNumber <= own ? d.verifier : d.fallback && o.l2BlockNumber <= rpc ? d.fallback : null;
    let verdict: string | null = null;
    if (source) {
      const expected = await source.outputAt(o.l2BlockNumber);
      if (same(expected, o.outputRoot)) {
        d.checked.add(key);
        continue;
      }
      // Asked twice: a source that answers two different roots for one block is not trusted to delete.
      const again = await source.outputAt(o.l2BlockNumber);
      if (!same(again, expected)) {
        return { name, status: "critical", detail: `${source === d.verifier ? "This node" : "The LONGYU RPC"} gave two different roots for L2 block ${o.l2BlockNumber}; state root ${index} was not judged.` };
      }
      verdict = `does not match ${source === d.verifier ? "this node" : "the LONGYU RPC"}`;
      d.log("wrong_state_root", { index: String(index), l2Block: String(o.l2BlockNumber), posted: o.outputRoot, expected });
    } else if (o.timestamp + period - now <= late) {
      verdict = `could not be checked before it finalizes (this node is at block ${own})`;
      d.log("unchecked_state_root", { index: String(index), l2Block: String(o.l2BlockNumber), own: String(own), rpc: String(rpc) });
    } else {
      waiting++;
      continue;
    }
    if (!d.oracle.deleteL2Outputs) {
      return { name, status: "critical", detail: `State root ${index} (L2 block ${o.l2BlockNumber}) ${verdict}, and the challenger key is not set: delete it by hand before it finalizes.` };
    }
    const tx = await d.oracle.deleteL2Outputs(index);
    d.log("state_roots_deleted", { from: String(index), tx });
    for (const k of [...d.checked]) if (BigInt(k.split(":")[0]!) >= index) d.checked.delete(k);
    return { name, status: "critical", detail: `State root ${index} (L2 block ${o.l2BlockNumber}) ${verdict}. Deleted it and every later one in ${tx}.` };
  }
  const checkedNow = open.length - waiting;
  // Roots checked from the RPC count as checked, but the own node being behind is itself worth seeing.
  const ownBehind = open.some((x) => x.o.l2BlockNumber > own);
  const behind = ownBehind ? `; this node is behind (at block ${own}), so roots past it are checked from the LONGYU RPC` : "";
  return {
    name,
    status: ownBehind ? "warning" : "ok",
    detail: open.length === 0 ? "No root waiting to finalize." : `${checkedNow} of ${open.length} waiting roots checked and right${behind}${waiting ? `; ${waiting} not reachable yet` : ""}.`,
  };
}
