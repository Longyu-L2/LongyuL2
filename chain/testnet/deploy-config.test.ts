import { test } from "node:test";
import assert from "node:assert/strict";
import { deployConfig, onWholeSecond } from "./deploy-config.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const base = { l1: { chainId: 97, finalizedHash: `0x${"ab".repeat(32)}`, finalizedTimestamp: 1_790_000_000 }, admin: a(1), sequencer: a(2), batcher: a(3), proposer: a(4) };

test("deploy config: safe defaults for a public chain and opBNB's timing", () => {
  const c = deployConfig(base);
  assert.equal(c.fundDevAccounts, false, "no pre-funded development accounts");
  assert.equal(c.enableGovernance, false, "no governance token");
  assert.equal(c.finalizationPeriodSeconds, 600, "the testnet's ten-minute withdrawal wait");
  assert.deepEqual([c.l1ChainID, c.l2ChainID, c.l2BlockTime], [97, 668801, 1]);
  assert.deepEqual([c.sequencerWindowSize, c.channelTimeout, c.maxSequencerDrift], [96000, 1200, 600]);
  assert.equal(c.l2OutputOracleSubmissionInterval, 3600, "matches op-geth --pathdb.proposeblock");
  assert.equal(c.batchInboxAddress.toLowerCase(), "0xff00000000000000000000000000000000668801");
  assert.equal(c.l2OutputOracleStartingTimestamp, base.l1.finalizedTimestamp);
  assert.equal(c.useCustomGasToken, false);
  assert.equal(c.useFaultProofs, false);
  for (const k of Object.keys(c).filter((k) => /TimeOffset$/.test(k))) assert.equal((c as Record<string, unknown>)[k], "0x0", k);
});

test("deploy config: a gas token turns on the custom gas token", () => {
  const c = deployConfig({ ...base, gasToken: a(99) });
  assert.equal(c.useCustomGasToken, true);
  assert.equal(c.customGasTokenAddress, a(99));
});

test("deploy config: refuses shared keys and malformed input", () => {
  assert.throws(() => deployConfig({ ...base, batcher: base.sequencer }), /four different keys/);
  assert.throws(() => deployConfig({ ...base, proposer: "0x12" }), /proposer is not an address/);
  assert.throws(() => deployConfig({ ...base, l1: { ...base.l1, finalizedHash: "0x12" } }), /bad L1 block hash/);
});

test("deploy config: only a BSC block on a whole second can start the chain", () => {
  assert.equal(onWholeSecond({ mixHash: `0x${"0".repeat(64)}` }), true);
  assert.equal(onWholeSecond({ mixHash: `0x${"0".repeat(61)}1c2` }), false, "450 ms");
  assert.throws(() => onWholeSecond({ mixHash: "0x" }), /bad mixHash/);
});
