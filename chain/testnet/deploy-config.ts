/**
 * Builds the rollup deploy config for LONGYU testnet or mainnet (BNB Chain's opbnb v0.5.6, contracts-bedrock).
 *
 *   L1_RPC_URL=https://bsc-testnet-rpc.publicnode.com ADMIN=0x.. SEQUENCER=0x.. BATCHER=0x.. PROPOSER=0x.. \
 *   [GAS_TOKEN=0x..] npx tsx chain/testnet/deploy-config.ts > chain/testnet/deploy-config.json
 *
 *   NETWORK=mainnet L1_RPC_URL=https://bsc-rpc.publicnode.com ADMIN=0x.. SEQUENCER=0x.. BATCHER=0x.. \
 *   PROPOSER=0x.. CHALLENGER=0x.. SAFE=0x.. npx tsx chain/testnet/deploy-config.ts > chain/mainnet/deploy-config.json
 *
 * Replaces the guide's getting-started template, which is invalid JSON and has unsafe defaults for a
 * public chain: it pre-funds well-known development accounts, deploys an "Optimism" governance token and
 * sets a 12-second withdrawal delay. Timing follows opBNB's production rollup config
 * (op-node/chaincfg/chains.go): BSC's blocks are fast (0.45 s), so windows counted in L1 blocks are long.
 */
import { getAddress, isAddress } from "viem";

export type Network = "testnet" | "mainnet";

/** What differs between the two networks. Everything else in the config is the same. */
export const NETWORKS = {
  testnet: { l1ChainId: 97, l2ChainId: 668801, finalizationPeriodSeconds: 600, feeVaultMinimum: "0x8ac7230489e80000" },
  // A one-hour withdrawal wait, safe only while the automatic challenger runs (SECURITY.md).
  mainnet: { l1ChainId: 56, l2ChainId: 668800, finalizationPeriodSeconds: 3600, feeVaultMinimum: "0x16345785d8a0000" },
} as const satisfies Record<Network, { l1ChainId: number; l2ChainId: number; finalizationPeriodSeconds: number; feeVaultMinimum: string }>;

export interface Inputs {
  /** Defaults to the testnet. */
  network?: Network;
  l1: { chainId: number; finalizedHash: string; finalizedTimestamp: number };
  admin: string;
  sequencer: string;
  batcher: string;
  proposer: string;
  /** Mainnet: the automatic challenger's key, which deletes a wrong state root. The testnet uses the admin key. */
  challenger?: string;
  /**
   * Mainnet: the founders' Safe on BSC. It owns the system config from the start, holds the guardian's
   * pause and receives the fee vaults' payouts; the upgrade rights reach it through a timelock at the
   * handover. The testnet uses the admin key for all of these.
   */
  safe?: string;
  /** BEP-20 on BSC to use as LONGYU's gas token; omitted means BNB as gas. */
  gasToken?: string;
}

export const L2_CHAIN_ID = NETWORKS.testnet.l2ChainId;
/** Proposer interval in L2 blocks, 15 minutes at 250 ms; op-geth keeps proofs for the same span (--pathdb.proposeblock). */
export const OUTPUT_INTERVAL = 3600;
const ZERO32 = `0x${"0".repeat(64)}`;

export function deployConfig(i: Inputs) {
  const network = i.network ?? "testnet";
  const net = NETWORKS[network];
  const mainnet = network === "mainnet";
  if (mainnet && (!i.challenger || !i.safe)) throw new Error("mainnet needs a challenger and the founders' Safe");
  if (!mainnet && (i.challenger || i.safe)) throw new Error("the testnet's challenger and owner are the admin key");
  const named: Record<string, string> = { admin: i.admin, sequencer: i.sequencer, batcher: i.batcher, proposer: i.proposer };
  if (i.challenger) named.challenger = i.challenger;
  if (i.safe) named.safe = i.safe;
  if (i.gasToken) named.gasToken = i.gasToken;
  for (const [k, v] of Object.entries(named)) {
    if (!isAddress(v)) throw new Error(`${k} is not an address`);
  }
  if (i.l1.chainId !== net.l1ChainId) throw new Error(`the ${network} settles on chain ${net.l1ChainId}, not ${i.l1.chainId}`);
  if (!/^0x[0-9a-f]{64}$/i.test(i.l1.finalizedHash)) throw new Error("bad L1 block hash");
  const keys = [i.admin, i.sequencer, i.batcher, i.proposer, ...(i.challenger ? [i.challenger] : [])].map((a) => a.toLowerCase());
  if (new Set(keys).size !== keys.length) {
    throw new Error(mainnet ? "admin, sequencer, batcher, proposer and challenger must be five different keys" : "admin, sequencer, batcher and proposer must be four different keys");
  }
  // The Safe is never one of the chain's own keys.
  if (i.safe && keys.includes(i.safe.toLowerCase())) throw new Error("the Safe must not be one of the chain's keys");
  const admin = getAddress(i.admin);
  const challenger = i.challenger ? getAddress(i.challenger) : admin;
  const owner = i.safe ? getAddress(i.safe) : admin;
  return {
    l1StartingBlockTag: i.l1.finalizedHash,
    l1ChainID: i.l1.chainId,
    l2ChainID: net.l2ChainId,
    // The setting from before Volta and Fourier. Both are active from genesis, so blocks come every 250 ms.
    l2BlockTime: 1,
    // Whole seconds only; BSC now runs below one second, and opBNB's own configs used 3.
    l1BlockTime: 3,

    maxSequencerDrift: 600,
    sequencerWindowSize: 96000,
    channelTimeout: 1200,

    p2pSequencerAddress: getAddress(i.sequencer),
    batchInboxAddress: getAddress(`0xff${String(net.l2ChainId).padStart(38, "0")}`),
    batchSenderAddress: getAddress(i.batcher),

    l2OutputOracleSubmissionInterval: OUTPUT_INTERVAL,
    l2OutputOracleStartingBlockNumber: 0,
    l2OutputOracleStartingTimestamp: i.l1.finalizedTimestamp,
    l2OutputOracleProposer: getAddress(i.proposer),
    l2OutputOracleChallenger: challenger,
    // Between a state root and the withdrawals it proves: ten minutes on the testnet, an hour on mainnet (SECURITY.md).
    finalizationPeriodSeconds: net.finalizationPeriodSeconds,

    // The upgrade rights start with the deploying key (on LONGYU) and its one-signer SystemOwnerSafe (on
    // BSC); the handover moves both behind a timelock run by the founders' Safe before real value moves.
    proxyAdminOwner: admin,
    finalSystemOwner: owner,
    superchainConfigGuardian: owner,
    baseFeeVaultRecipient: owner,
    l1FeeVaultRecipient: owner,
    sequencerFeeVaultRecipient: owner,
    // The chain's fees collect in three vaults on LONGYU. Once one holds this much (10 BNB on the
    // testnet, 0.1 BNB on mainnet), anyone may call its withdraw(): the fees go through the bridge to
    // the recipient above on BSC (network 0), proved and finalized there like any withdrawal.
    baseFeeVaultMinimumWithdrawalAmount: net.feeVaultMinimum,
    l1FeeVaultMinimumWithdrawalAmount: net.feeVaultMinimum,
    sequencerFeeVaultMinimumWithdrawalAmount: net.feeVaultMinimum,
    baseFeeVaultWithdrawalNetwork: 0,
    l1FeeVaultWithdrawalNetwork: 0,
    sequencerFeeVaultWithdrawalNetwork: 0,

    gasPriceOracleOverhead: 0,
    gasPriceOracleScalar: 1000000,
    gasPriceOracleBaseFeeScalar: 1368,
    gasPriceOracleBlobBaseFeeScalar: 810949,

    // No governance token, and no pre-funded development accounts on a public chain.
    enableGovernance: false,
    governanceTokenSymbol: "NA",
    governanceTokenName: "NotApplicable",
    governanceTokenOwner: admin,
    fundDevAccounts: false,

    l2GenesisBlockGasLimit: "0x5f5e100",
    l2GenesisBlockBaseFeePerGas: "0x3b9aca00",
    eip1559Denominator: 50,
    eip1559DenominatorCanyon: 250,
    eip1559Elasticity: 6,

    // Every upgrade, upstream and BNB Chain's own, active from the first block.
    l2GenesisRegolithTimeOffset: "0x0",
    l2GenesisCanyonTimeOffset: "0x0",
    l2GenesisDeltaTimeOffset: "0x0",
    l2GenesisEcotoneTimeOffset: "0x0",
    l2GenesisFjordTimeOffset: "0x0",
    l2GenesisVoltaTimeOffset: "0x0",
    l2GenesisFourierTimeOffset: "0x0",
    fermat: 0,
    snowTimeOffset: "0x0",
    haberTimeOffset: "0x0",
    wrightTimeOffset: "0x0",

    systemConfigStartBlock: 0,
    requiredProtocolVersion: ZERO32,
    recommendedProtocolVersion: ZERO32,

    useCustomGasToken: Boolean(i.gasToken),
    customGasTokenAddress: i.gasToken ? getAddress(i.gasToken) : "0x0000000000000000000000000000000000000000",

    // Permissioned outputs (no fault proofs), as on opBNB. The proof fields are still required by the
    // deploy script; these are the template's values and are unused while useFaultProofs is false.
    useFaultProofs: false,
    usePlasma: false,
    faultGameAbsolutePrestate: "0x03c7ae758795765c6664a5d39bf63841c71ff191e9189522bad8ebff5d4eca98",
    faultGameMaxDepth: 44,
    faultGameClockExtension: 0,
    faultGameMaxClockDuration: 600,
    faultGameGenesisBlock: 0,
    faultGameGenesisOutputRoot: ZERO32,
    faultGameSplitDepth: 14,
    faultGameWithdrawalDelay: 604800,
    preimageOracleMinProposalSize: 1800000,
    preimageOracleChallengePeriod: 86400,
    proofMaturityDelaySeconds: 604800,
    disputeGameFinalityDelaySeconds: 302400,
    respectedGameType: 0,
    daChallengeWindow: 160,
    daResolveWindow: 160,
    daBondSize: 1000000,
    daResolverRefundPercentage: 0,
  };
}

/** BSC keeps a block's milliseconds in its mixHash (BEP-520); a zero mixHash is a whole second. */
export function onWholeSecond(block: { mixHash: string }): boolean {
  if (!/^0x[0-9a-f]{64}$/i.test(block.mixHash)) throw new Error("bad mixHash");
  return BigInt(block.mixHash) === 0n;
}

/**
 * Reads the BSC block the chain starts from: the newest block that falls on a whole second, at or
 * before the finalized one (or L1_BLOCK_TAG, e.g. "latest" on a local rehearsal chain). The L2 genesis
 * block takes this block's time in seconds, and op-node refuses to start a chain whose genesis is
 * older than its L1 origin, even by a block's 450 ms. One BSC block in twenty is on a whole second.
 */
async function startingBlock(rpc: string, tag = "finalized") {
  type Block = { hash: string; parentHash: string; timestamp: string; mixHash: string };
  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error || body.result === undefined || body.result === null) throw new Error(`${method}: ${body.error?.message ?? "no result"}`);
    return body.result;
  };
  const chainId = Number(await call("eth_chainId", []));
  let block = (await call("eth_getBlockByNumber", [tag, false])) as Block;
  for (let i = 0; !onWholeSecond(block); i++) {
    if (i === 200) throw new Error("no BSC block on a whole second in the last 200");
    block = (await call("eth_getBlockByHash", [block.parentHash, false])) as Block;
  }
  return { chainId, finalizedHash: block.hash, finalizedTimestamp: Number(block.timestamp) };
}

async function main() {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const network = process.env.NETWORK || "testnet";
  if (network !== "testnet" && network !== "mainnet") throw new Error("NETWORK must be testnet or mainnet");
  const l1 = await startingBlock(need("L1_RPC_URL"), process.env.L1_BLOCK_TAG || "finalized");
  const config = deployConfig({
    network, l1, admin: need("ADMIN"), sequencer: need("SEQUENCER"), batcher: need("BATCHER"), proposer: need("PROPOSER"),
    challenger: process.env.CHALLENGER || undefined, safe: process.env.SAFE || undefined, gasToken: process.env.GAS_TOKEN || undefined,
  });
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("chain/testnet/deploy-config.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
