/**
 * State roots posted on BSC, and the parts they are built from on LONGYU. A state root (the rollup's
 * output root) is keccak256(version 0, the block's state root, the storage root of the message
 * passer at 0x4200…0016, the block hash). A phone that rebuilds a posted one from LONGYU's own data
 * has checked that the chain it is served and what was committed on BSC agree.
 */
import { concat, createPublicClient, http, keccak256, parseAbi, type Address, type Hex, type PublicClient } from "viem";

export const MESSAGE_PASSER: Address = "0x4200000000000000000000000000000000000016";
const ZERO32: Hex = `0x${"00".repeat(32)}`;

export interface OutputRef {
  index: bigint;
  l2Block: bigint;
  root: Hex;
}

export interface RootParts {
  stateRoot: Hex;
  messagePasserRoot: Hex;
  blockHash: Hex;
}

export function outputRootOf(p: RootParts): Hex {
  return keccak256(concat([ZERO32, p.stateRoot, p.messagePasserRoot, p.blockHash]));
}

export interface ChainChecker {
  /** One of the latest posted state roots, for a phone to rebuild. */
  pick(): Promise<OutputRef>;
  /** The index of the newest posted state root. */
  latest(): Promise<bigint>;
  /** The state root posted at `index`, or null when none is posted there yet. */
  output(index: bigint): Promise<OutputRef | null>;
  /** The parts of LONGYU block `l2Block`, from this API's own node. */
  partsAt(l2Block: bigint): Promise<RootParts>;
}

const oracleAbi = parseAbi([
  "function latestOutputIndex() view returns (uint256)",
  "function getL2Output(uint256 index) view returns ((bytes32 outputRoot, uint128 timestamp, uint128 l2BlockNumber))",
]);

/** How many of the latest state roots a start may be asked to rebuild. */
const RECENT = 4n;
/**
 * How far back a check may go, in state roots (15 minutes each). The node keeps the state of the
 * blocks it posted for a few hours only, and older parts could not be rebuilt here to confirm a
 * disagreement.
 */
export const CHECK_WINDOW = 8n;

export function createChainChecker(o: { l1RpcUrl: string; oracle: Address; l2RpcUrl: string }): ChainChecker {
  const l1 = createPublicClient({ transport: http(o.l1RpcUrl) }) as PublicClient;
  const l2 = createPublicClient({ transport: http(o.l2RpcUrl) }) as PublicClient;
  // A posted root changes only if the challenger deletes it, so a short cache is enough.
  const outputs = new Map<bigint, { at: number; ref: OutputRef }>();
  let latest: { at: number; index: bigint } | null = null;

  async function latestIndex(fresh: boolean): Promise<bigint> {
    if (fresh || !latest || Date.now() - latest.at > 60_000) {
      latest = { at: Date.now(), index: await l1.readContract({ address: o.oracle, abi: oracleAbi, functionName: "latestOutputIndex" }) };
    }
    return latest.index;
  }

  async function output(index: bigint): Promise<OutputRef | null> {
    const held = outputs.get(index);
    if (held && Date.now() - held.at < 10 * 60_000) return held.ref;
    if (index > (await latestIndex(false)) && index > (await latestIndex(true))) return null;
    const r = await l1.readContract({ address: o.oracle, abi: oracleAbi, functionName: "getL2Output", args: [index] });
    const ref = { index, l2Block: r.l2BlockNumber, root: r.outputRoot };
    if (outputs.size > 256) outputs.clear();
    outputs.set(index, { at: Date.now(), ref });
    return ref;
  }

  return {
    output,
    latest: () => latestIndex(false),
    async pick() {
      const top = await latestIndex(false);
      const back = BigInt(Math.floor(Math.random() * Number(RECENT)));
      const ref = await output(top >= back ? top - back : 0n);
      if (!ref) throw new Error("no state root posted yet");
      return ref;
    },
    async partsAt(l2Block) {
      const [block, proof] = await Promise.all([
        l2.getBlock({ blockNumber: l2Block }),
        l2.getProof({ address: MESSAGE_PASSER, storageKeys: [], blockNumber: l2Block }),
      ]);
      return { stateRoot: block.stateRoot, messagePasserRoot: proof.storageHash, blockHash: block.hash! };
    },
  };
}
