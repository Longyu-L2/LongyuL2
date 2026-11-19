import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  isAddressEqual,
  parseEventLogs,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { bsc } from "viem/chains";
import { randomBytes } from "node:crypto";
import { emissionScheduleAbi, faucetAbi, miningDistributorAbi } from "@longyu/abis";
import type { ScheduleParams } from "@longyu/reward-engine";

export interface RootInfo {
  root: Hex;
  day: bigint;
  postedAt: bigint;
  totalEntitled: bigint;
  dataHash: Hex;
}

export type DistributorEvent =
  | { kind: "claimed"; account: Address; amount: bigint; cumulative: bigint; day: bigint; block: bigint; txHash: Hex }
  | { kind: "skipped"; account: Address; cumulative: bigint; reason: number; block: bigint; txHash: Hex }
  | { kind: "proposed"; day: bigint; root: Hex; block: bigint }
  | { kind: "activated"; day: bigint; root: Hex; block: bigint }
  | { kind: "vetoed"; day: bigint; root: Hex; block: bigint };

/** What operations need to see about the chain and the operator accounts. Null = not configured. */
export interface ChainHealth {
  block: bigint;
  blockTime: bigint;
  paused: boolean;
  publisherBalance: bigint | null;
  relayerBalance: bigint | null;
  vaultBalance: bigint | null;
  faucetBalance: bigint | null;
}

/** A transfer of the reward asset: native value (logIndex -1) or a token Transfer event. */
export interface RewardTransfer {
  txHash: Hex;
  logIndex: number;
  block: bigint;
  blockTime: bigint;
  from: Address;
  to: Address;
  amount: bigint;
  native: boolean;
}

/** The ERC-20 the distributor pays rewards in. */
export interface RewardToken {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
}

/** LONGYU's native token is BNB bridged from BSC. */
export function nativeCurrency(c: { NATIVE_SYMBOL: "tBNB" | "BNB" }) {
  return { name: "BNB", symbol: c.NATIVE_SYMBOL, decimals: 18 } as const;
}

export interface ClaimItem {
  account: Address;
  cumulative: bigint;
  proof: Hex[];
}

/**
 * A transaction whose fate is known to be something other than success:
 * - "refused": the contract rejected the call before anything was sent. Sending it again cannot help.
 * - "reverted": it was mined and reverted.
 * - "unconfirmed": it was sent, but no receipt came while waiting. It may still be mined.
 * Any other error from a send (network, signer) happened before the transaction went out.
 */
export class TxError extends Error {
  constructor(
    readonly kind: "refused" | "reverted" | "unconfirmed",
    message: string,
    readonly txHash?: Hex,
  ) {
    super(message);
  }
}

/** How a sent transaction ended, with the distributor events in it. */
export interface TxOutcome {
  success: boolean;
  events: DistributorEvent[];
}

export interface ChainGateway {
  readonly chainId: bigint;
  readonly distributor: Address;
  readSchedule(): Promise<ScheduleParams>;
  /** The reward ERC-20, or null when rewards are paid in the native token. */
  rewardToken(): Promise<RewardToken | null>;
  readDistributorConfig(): Promise<{ maxRewardPerDay: bigint; maxDailyIncrease: bigint; challengeDelay: bigint }>;
  readRoots(): Promise<{ active: RootInfo | null; pending: RootInfo | null }>;
  proposeRoot(day: bigint, root: Hex, total: bigint, dataHash: Hex, uri: string): Promise<Hex>;
  /** `onSent` is called with the hash as soon as the transaction is out, before it confirms. */
  claimMany(items: ClaimItem[], onSent?: (txHash: Hex) => Promise<void>): Promise<{ txHash: Hex; events: DistributorEvent[] }>;
  dripFaucet(recipient: Address, amount: bigint): Promise<Hex>;
  /** The outcome of a transaction sent earlier, or null while it has no receipt (pending or dropped). */
  sentTx(hash: Hex): Promise<TxOutcome | null>;
  latestBlock(): Promise<bigint>;
  distributorEvents(fromBlock: bigint, toBlock: bigint): Promise<DistributorEvent[]>;
  babtBalance(address: Address): Promise<bigint>;
  verifySignature(address: Address, message: string, signature: Hex): Promise<boolean>;
  healthSnapshot(): Promise<ChainHealth>;
  /** Every transfer of the reward asset in the block range (value-carrying transactions or token events). */
  rewardTransfers(fromBlock: bigint, toBlock: bigint): Promise<RewardTransfer[]>;
  transactionSucceeded(hash: Hex): Promise<boolean>;
  isContract(address: Address): Promise<boolean>;
}

/** Serialises transactions from one account so nonces never collide. */
class Mutex {
  private last: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.last.then(fn, fn);
    this.last = next.catch(() => undefined);
    return next;
  }
}

const toRoot = (r: { root: Hex; day: bigint; postedAt: bigint; totalEntitled: bigint; dataHash: Hex }): RootInfo | null =>
  r.root === "0x0000000000000000000000000000000000000000000000000000000000000000"
    ? null
    : { root: r.root, day: r.day, postedAt: r.postedAt, totalEntitled: r.totalEntitled, dataHash: r.dataHash };

/** The distributor's events among a set of logs. Logs from any other contract are ignored, whatever they look like. */
function parseDistributorLogs(logs: Parameters<typeof parseEventLogs>[0]["logs"], distributor: Address): DistributorEvent[] {
  const parsed = parseEventLogs({ abi: miningDistributorAbi, logs: logs.filter((l) => isAddressEqual(l.address, distributor)) });
  const out: DistributorEvent[] = [];
  for (const l of parsed) {
    const block = l.blockNumber ?? 0n;
    switch (l.eventName) {
      case "Claimed":
        out.push({ kind: "claimed", account: l.args.account, amount: l.args.amount, cumulative: l.args.cumulativeAmount, day: l.args.day, block, txHash: l.transactionHash! });
        break;
      case "ClaimSkipped":
        out.push({ kind: "skipped", account: l.args.account, cumulative: l.args.cumulativeAmount, reason: Number(l.args.reason), block, txHash: l.transactionHash! });
        break;
      case "RootProposed":
        out.push({ kind: "proposed", day: l.args.day, root: l.args.root, block });
        break;
      case "RootActivated":
        out.push({ kind: "activated", day: l.args.day, root: l.args.root, block });
        break;
      case "RootVetoed":
        out.push({ kind: "vetoed", day: l.args.day, root: l.args.root, block });
        break;
      default:
        break;
    }
  }
  return out;
}

export interface ViemChainOptions {
  rpcUrl: string;
  chainId: bigint;
  chainName: string;
  nativeSymbol: "tBNB" | "BNB";
  distributor: Address;
  faucet?: Address;
  publisher?: LocalAccount;
  relayer?: LocalAccount;
  faucetSigner?: LocalAccount;
  bscRpcUrl: string;
  babtAddress: Address;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const erc20BalanceAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const transferEventAbi = [
  {
    type: "event", name: "Transfer", anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

const babtAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Reads BABT balances on BSC: at verification, and again when the migration snapshot is taken. */
export function createBabtReader(o: { bscRpcUrl: string; babtAddress: Address }): Pick<ChainGateway, "babtBalance"> {
  const bscClient = createPublicClient({ chain: bsc, transport: http(o.bscRpcUrl) });
  return {
    babtBalance: (address) => bscClient.readContract({ address: o.babtAddress, abi: babtAbi, functionName: "balanceOf", args: [address] }),
  };
}

export function createViemChain(o: ViemChainOptions): ChainGateway {
  const chain = defineChain({
    id: Number(o.chainId),
    name: o.chainName,
    nativeCurrency: nativeCurrency({ NATIVE_SYMBOL: o.nativeSymbol }),
    rpcUrls: { default: { http: [o.rpcUrl] } },
  });
  const transport = http(o.rpcUrl);
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const babt = createBabtReader(o);
  const relayerLock = new Mutex();
  const publisherLock = new Mutex();

  const need = <T>(v: T | undefined, what: string): T => {
    if (!v) throw new Error(`${what} is not configured`);
    return v;
  };

  async function send(
    account: LocalAccount,
    lock: Mutex,
    request: Parameters<ReturnType<typeof createWalletClient>["writeContract"]>[0],
    onSent?: (txHash: Hex) => Promise<void>,
  ) {
    return lock.run(async () => {
      const wallet = createWalletClient({ account, chain, transport });
      let hash: Hex;
      try {
        hash = await wallet.writeContract({ ...request, account, chain } as never);
      } catch (e) {
        // A revert found while estimating gas: the contract said no and nothing was sent.
        if (e instanceof BaseError && e.walk((cause) => cause instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError) {
          throw new TxError("refused", e.shortMessage);
        }
        throw e;
      }
      // From here the transaction is out: a failure to see it confirm is not a failure of the transaction.
      let receipt;
      try {
        await onSent?.(hash);
        receipt = await pub.waitForTransactionReceipt({ hash });
      } catch (e) {
        throw new TxError("unconfirmed", `transaction ${hash} was sent but not seen to confirm: ${(e as Error).name}`, hash);
      }
      if (receipt.status !== "success") throw new TxError("reverted", `transaction ${hash} reverted`, hash);
      return receipt;
    });
  }

  return {
    chainId: o.chainId,
    distributor: o.distributor,

    async readSchedule() {
      const schedule = await pub.readContract({ address: o.distributor, abi: miningDistributorAbi, functionName: "schedule" });
      const read = (fn: "startTime" | "initialDailyBudget" | "periodDays" | "decayBps" | "totalCap") =>
        pub.readContract({ address: schedule, abi: emissionScheduleAbi, functionName: fn });
      const [startTime, initialDailyBudget, periodDays, decayBps, totalCap] = await Promise.all([
        read("startTime"), read("initialDailyBudget"), read("periodDays"), read("decayBps"), read("totalCap"),
      ]);
      return { startTime, initialDailyBudget, periodDays, decayBps, totalCap };
    },

    async rewardToken() {
      const asset = await pub.readContract({ address: o.distributor, abi: miningDistributorAbi, functionName: "asset" });
      if (asset === ZERO) return null;
      const read = <F extends "name" | "symbol" | "decimals">(functionName: F) => pub.readContract({ address: asset, abi: erc20Abi, functionName });
      const [name, symbol, decimals] = await Promise.all([read("name"), read("symbol"), read("decimals")]);
      return { address: asset, name, symbol, decimals };
    },

    async readDistributorConfig() {
      const read = (fn: "maxRewardPerDay" | "maxDailyIncrease" | "challengeDelay") =>
        pub.readContract({ address: o.distributor, abi: miningDistributorAbi, functionName: fn });
      const [maxRewardPerDay, maxDailyIncrease, challengeDelay] = await Promise.all([
        read("maxRewardPerDay"), read("maxDailyIncrease"), read("challengeDelay"),
      ]);
      return { maxRewardPerDay, maxDailyIncrease, challengeDelay };
    },

    async readRoots() {
      const [active, pending] = await Promise.all([
        pub.readContract({ address: o.distributor, abi: miningDistributorAbi, functionName: "activeRoot" }),
        pub.readContract({ address: o.distributor, abi: miningDistributorAbi, functionName: "pendingRoot" }),
      ]);
      return { active: toRoot(active), pending: toRoot(pending) };
    },

    async proposeRoot(day, root, total, dataHash, uri) {
      const receipt = await send(need(o.publisher, "publisher key"), publisherLock, {
        address: o.distributor,
        abi: miningDistributorAbi,
        functionName: "proposeRoot",
        args: [day, root, total, dataHash, uri],
      } as never);
      return receipt.transactionHash;
    },

    async claimMany(items, onSent) {
      const receipt = await send(need(o.relayer, "relayer key"), relayerLock, {
        address: o.distributor,
        abi: miningDistributorAbi,
        functionName: "claimMany",
        args: [items.map((i) => i.account), items.map((i) => i.cumulative), items.map((i) => i.proof)],
      } as never, onSent);
      return { txHash: receipt.transactionHash, events: parseDistributorLogs(receipt.logs, o.distributor) };
    },

    async sentTx(hash) {
      try {
        const receipt = await pub.getTransactionReceipt({ hash });
        return { success: receipt.status === "success", events: parseDistributorLogs(receipt.logs, o.distributor) };
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },

    async dripFaucet(recipient, amount) {
      const faucet = need(o.faucet, "faucet address");
      const signer = need(o.faucetSigner, "faucet signer key");
      const nonce = BigInt(`0x${randomBytes(16).toString("hex")}`);
      const latest = await pub.getBlock();
      const deadline = latest.timestamp + 600n;
      const signature = await signer.signTypedData({
        domain: { name: "LONGYU Faucet", version: "1", chainId: Number(o.chainId), verifyingContract: faucet },
        types: { Voucher: [
          { name: "recipient", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ] },
        primaryType: "Voucher",
        message: { recipient, amount, nonce, deadline },
      });
      const receipt = await send(need(o.relayer, "relayer key"), relayerLock, {
        address: faucet,
        abi: faucetAbi,
        functionName: "drip",
        args: [recipient, amount, nonce, deadline, signature],
      } as never);
      return receipt.transactionHash;
    },

    // cacheTime 0: viem otherwise reuses the block number for 4 seconds and the indexer lags.
    latestBlock: () => pub.getBlockNumber({ cacheTime: 0 }),

    async distributorEvents(fromBlock, toBlock) {
      const logs = await pub.getLogs({ address: o.distributor, fromBlock, toBlock });
      return parseDistributorLogs(logs, o.distributor);
    },

    babtBalance: babt.babtBalance,

    verifySignature: (address, message, signature) => pub.verifyMessage({ address, message, signature }),

    async rewardTransfers(fromBlock, toBlock) {
      const asset = await pub.readContract({ address: o.distributor, abi: miningDistributorAbi, functionName: "asset" });
      const out: RewardTransfer[] = [];
      if (asset === ZERO) {
        // Native reward asset: read each block's value-carrying transactions, a few blocks at a time.
        const numbers: bigint[] = [];
        for (let b = fromBlock; b <= toBlock; b++) numbers.push(b);
        for (let i = 0; i < numbers.length; i += 20) {
          const blocks = await Promise.all(numbers.slice(i, i + 20).map((blockNumber) => pub.getBlock({ blockNumber, includeTransactions: true })));
          for (const b of blocks) {
            for (const tx of b.transactions) {
              if (typeof tx === "string" || !tx.to || tx.value === 0n) continue;
              out.push({ txHash: tx.hash, logIndex: -1, block: b.number!, blockTime: b.timestamp, from: tx.from, to: tx.to, amount: tx.value, native: true });
            }
          }
        }
        return out;
      }
      const logs = await pub.getContractEvents({ address: asset, abi: transferEventAbi, eventName: "Transfer", fromBlock, toBlock, strict: true });
      const times = new Map<bigint, bigint>();
      for (const l of logs) {
        if (l.removed || l.blockNumber === null || l.logIndex === null || !l.transactionHash) continue;
        let t = times.get(l.blockNumber);
        if (t === undefined) {
          t = (await pub.getBlock({ blockNumber: l.blockNumber })).timestamp;
          times.set(l.blockNumber, t);
        }
        out.push({ txHash: l.transactionHash, logIndex: l.logIndex, block: l.blockNumber, blockTime: t, from: l.args.from, to: l.args.to, amount: l.args.value, native: false });
      }
      return out;
    },

    async transactionSucceeded(hash) {
      return (await pub.getTransactionReceipt({ hash })).status === "success";
    },

    async isContract(address) {
      const code = await pub.getCode({ address });
      return code !== undefined && code !== "0x";
    },

    async healthSnapshot() {
      const read = <F extends "paused" | "vault" | "asset">(functionName: F) =>
        pub.readContract({ address: o.distributor, abi: miningDistributorAbi, functionName });
      const [block, paused, vault, asset] = await Promise.all([pub.getBlock({ blockTag: "latest" }), read("paused"), read("vault"), read("asset")]);
      const holding = async (token: Address, holder: Address) =>
        token === ZERO
          ? pub.getBalance({ address: holder })
          : pub.readContract({ address: token, abi: erc20BalanceAbi, functionName: "balanceOf", args: [holder] });
      const native = (a?: Address) => (a ? pub.getBalance({ address: a }) : Promise.resolve(null));
      const [publisherBalance, relayerBalance, vaultBalance, faucetBalance] = await Promise.all([
        native(o.publisher?.address),
        native(o.relayer?.address),
        vault === ZERO ? Promise.resolve(null) : holding(asset, vault),
        o.faucet
          ? pub.readContract({ address: o.faucet, abi: faucetAbi, functionName: "asset" }).then((a) => holding(a, o.faucet!))
          : Promise.resolve(null),
      ]);
      return { block: block.number!, blockTime: block.timestamp, paused, publisherBalance, relayerBalance, vaultBalance, faucetBalance };
    },
  };
}
