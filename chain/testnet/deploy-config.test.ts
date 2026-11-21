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

test("deploy config: the testnet's deployed config is unchanged", async () => {
  const { readFile } = await import("node:fs/promises");
  const deployed = JSON.parse(await readFile(new URL("./deploy-config.json", import.meta.url), "utf8"));
  const c = deployConfig({
    l1: { chainId: deployed.l1ChainID, finalizedHash: deployed.l1StartingBlockTag, finalizedTimestamp: deployed.l2OutputOracleStartingTimestamp },
    admin: deployed.proxyAdminOwner, sequencer: deployed.p2pSequencerAddress, batcher: deployed.batchSenderAddress, proposer: deployed.l2OutputOracleProposer,
  });
  assert.deepEqual(c, deployed);
});

const mainnet = { ...base, network: "mainnet" as const, l1: { ...base.l1, chainId: 56 }, challenger: a(5), safe: a(6) };

test("deploy config: mainnet settles on BSC with a one-hour wait and its own challenger", () => {
  const c = deployConfig(mainnet);
  assert.deepEqual([c.l1ChainID, c.l2ChainID, c.finalizationPeriodSeconds], [56, 668800, 3600]);
  assert.equal(c.batchInboxAddress.toLowerCase(), "0xff00000000000000000000000000000000668800");
  assert.equal(c.l2OutputOracleChallenger, a(5));
  assert.deepEqual([c.baseFeeVaultRecipient, c.l1FeeVaultRecipient, c.sequencerFeeVaultRecipient], [a(6), a(6), a(6)]);
  assert.deepEqual([c.finalSystemOwner, c.superchainConfigGuardian], [a(6), a(6)], "the Safe owns the system config and holds the pause");
  assert.equal(c.proxyAdminOwner, a(1), "upgrades move to the timelock at the handover");
  assert.equal(c.sequencerFeeVaultMinimumWithdrawalAmount, "0x16345785d8a0000", "fees pay out to the Safe from 0.1 BNB");
  assert.equal(c.fundDevAccounts, false);
});

test("deploy config: mainnet refuses a missing or shared challenger and the wrong L1", () => {
  assert.throws(() => deployConfig({ ...mainnet, challenger: undefined }), /needs a challenger/);
  assert.throws(() => deployConfig({ ...mainnet, safe: undefined }), /founders' Safe/);
  assert.throws(() => deployConfig({ ...mainnet, challenger: a(1) }), /five different keys/);
  assert.throws(() => deployConfig({ ...mainnet, challenger: a(4) }), /five different keys/);
  assert.throws(() => deployConfig({ ...mainnet, safe: a(2) }), /must not be one of the chain's keys/);
  assert.throws(() => deployConfig({ ...mainnet, l1: base.l1 }), /settles on chain 56, not 97/);
  assert.throws(() => deployConfig({ ...base, l1: { ...base.l1, chainId: 56 } }), /settles on chain 97, not 56/);
  assert.throws(() => deployConfig({ ...base, challenger: a(5) }), /testnet's challenger/);
});
