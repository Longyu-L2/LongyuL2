import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { checkOutputs, type OracleView, type OutputProposal, type VerifierView } from "../src/challenger.ts";

const root = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const PERIOD = 3600n;
const NOW = 1_800_000_000n;

/** The right root for block b is root(b), from the node and from the RPC alike. */
function setup(opts: { outputs: OutputProposal[]; safe?: bigint; rpcHead?: bigint; nodeRoot?: (b: bigint) => Hex; rpcRoot?: (b: bigint) => Hex; withKey?: boolean }) {
  const outputs = [...opts.outputs];
  const deleted: bigint[] = [];
  const oracle: OracleView = {
    nextOutputIndex: async () => BigInt(outputs.length),
    getL2Output: async (i) => outputs[Number(i)]!,
    finalizationPeriodSeconds: async () => PERIOD,
  };
  if (opts.withKey !== false) {
    oracle.deleteL2Outputs = async (i) => {
      deleted.push(i);
      outputs.length = Number(i);
      return "0xdead" as Hex;
    };
  }
  const verifier: VerifierView = {
    safeHead: async () => opts.safe ?? 1_000_000n,
    outputAt: async (b) => (opts.nodeRoot ?? ((x) => root(Number(x))))(b),
  };
  const fallback: VerifierView | undefined = opts.rpcHead === undefined ? undefined : {
    safeHead: async () => opts.rpcHead!,
    outputAt: async (b) => (opts.rpcRoot ?? ((x) => root(Number(x))))(b),
  };
  const events: string[] = [];
  const deps = { oracle, verifier, fallback, now: () => NOW, checked: new Set<string>(), lateSeconds: 1200n, log: (e: string) => void events.push(e) };
  return { deps, deleted, outputs, events };
}

const output = (i: number, ageSeconds: bigint, r?: Hex): OutputProposal => {
  const b = BigInt((i + 1) * 3600);
  return { outputRoot: r ?? root(Number(b)), timestamp: NOW - ageSeconds, l2BlockNumber: b };
};

test("challenger: right roots are checked once and nothing is deleted", async () => {
  const s = setup({ outputs: [output(0, 9000n), output(1, 2700n), output(2, 1800n), output(3, 900n)] });
  const c = await checkOutputs(s.deps);
  assert.equal(c.status, "ok");
  assert.match(c.detail, /3 of 3 waiting roots checked/);
  assert.deepEqual(s.deleted, []);
  assert.equal(s.deps.checked.size, 3, "the finalized root is not asked about");
  let asked = 0;
  s.deps.verifier.outputAt = async (b) => (asked++, root(Number(b)));
  await checkOutputs(s.deps);
  assert.equal(asked, 0, "checked roots are not asked again");
});

test("challenger: a wrong root is deleted with every root after it", async () => {
  const s = setup({ outputs: [output(0, 2700n), output(1, 1800n, root(1)), output(2, 900n)] });
  const c = await checkOutputs(s.deps);
  assert.equal(c.status, "critical");
  assert.match(c.detail, /State root 1 .*does not match this node. Deleted it and every later one in 0xdead/);
  assert.deepEqual(s.deleted, [1n]);
  assert.equal(s.outputs.length, 1);
  assert.ok(s.events.includes("wrong_state_root") && s.events.includes("state_roots_deleted"));
});

test("challenger: a finalized wrong root is past deleting and is not touched", async () => {
  const s = setup({ outputs: [output(0, 4000n, root(7))] });
  assert.equal((await checkOutputs(s.deps)).status, "ok");
  assert.deepEqual(s.deleted, []);
});

test("challenger: without the key a wrong root is reported, not deleted", async () => {
  const s = setup({ outputs: [output(0, 900n, root(7))], withKey: false });
  const c = await checkOutputs(s.deps);
  assert.equal(c.status, "critical");
  assert.match(c.detail, /challenger key is not set/);
});

test("challenger: a source that answers two different roots deletes nothing", async () => {
  let n = 0;
  const s = setup({ outputs: [output(0, 900n, root(7))], nodeRoot: () => root(100 + n++) });
  const c = await checkOutputs(s.deps);
  assert.equal(c.status, "critical");
  assert.match(c.detail, /two different roots/);
  assert.deepEqual(s.deleted, []);
});

test("challenger: past the node's head the LONGYU RPC checks, and a wrong root is deleted", async () => {
  let s = setup({ outputs: [output(0, 900n)], safe: 100n, rpcHead: 1_000_000n });
  let c = await checkOutputs(s.deps);
  assert.equal(c.status, "warning", "the node being behind is shown");
  assert.match(c.detail, /1 of 1 waiting roots checked .*this node is behind/);
  s = setup({ outputs: [output(0, 900n, root(9))], safe: 100n, rpcHead: 1_000_000n });
  c = await checkOutputs(s.deps);
  assert.match(c.detail, /does not match the LONGYU RPC/);
  assert.deepEqual(s.deleted, [0n]);
});

test("challenger: the node's answer decides where it has reached the block", async () => {
  // The RPC (the sequencer's) says otherwise, but the node has the block: the node is right.
  const s = setup({ outputs: [output(0, 900n)], rpcHead: 1_000_000n, rpcRoot: () => root(5) });
  assert.equal((await checkOutputs(s.deps)).status, "ok");
  assert.deepEqual(s.deleted, []);
});

test("challenger: a root no source can check waits, and is deleted close to finalizing", async () => {
  let s = setup({ outputs: [output(0, 900n)], safe: 100n });
  let c = await checkOutputs(s.deps);
  assert.match(c.detail, /1 not reachable yet/);
  assert.deepEqual(s.deleted, []);
  // A root for a block the sequencer does not have, posted 50 minutes ago.
  s = setup({ outputs: [output(0, 3000n)], safe: 100n, rpcHead: 100n });
  c = await checkOutputs(s.deps);
  assert.equal(c.status, "critical");
  assert.match(c.detail, /could not be checked before it finalizes.*Deleted/);
  assert.deepEqual(s.deleted, [0n]);
});

test("challenger: the late margin never exceeds half the wait", async () => {
  // A 1,200 s margin against a 3,600 s wait is used as is; a root 25 minutes from final still waits.
  let s = setup({ outputs: [output(0, 2100n)], safe: 100n });
  await checkOutputs(s.deps);
  assert.deepEqual(s.deleted, []);
  // With a margin larger than the wait, half the wait is used: 31 minutes before final is not yet late.
  s = setup({ outputs: [output(0, 1740n)], safe: 100n });
  s.deps.lateSeconds = 5000n;
  await checkOutputs(s.deps);
  assert.deepEqual(s.deleted, []);
  s.deps.now = () => NOW + 120n;
  await checkOutputs(s.deps);
  assert.deepEqual(s.deleted, [0n]);
});

test("challenger: too many waiting roots is critical", async () => {
  const s = setup({ outputs: Array.from({ length: 201 }, (_, i) => output(i, 100n)) });
  const c = await checkOutputs(s.deps);
  assert.equal(c.status, "critical");
  assert.match(c.detail, /More than 200/);
});

test("challenger: nothing posted yet", async () => {
  assert.equal((await checkOutputs(setup({ outputs: [] }).deps)).status, "ok");
});
