/**
 * Bridge page: moves BNB and the mined token between BNB Smart Chain and LONGYU with the visitor's own
 * wallet, and takes withdrawals through prove and finalize on BSC. Nothing here holds a key. Where the
 * mined token does not move yet (mainnet until the TGE: PROFILE.bridgeToken), it moves BNB only.
 *
 * Deposits (BSC -> LONGYU)
 * - BNB: OptimismPortal.depositTransaction, built by viem's buildDepositTransaction on the LONGYU
 *   client and sent by depositTransaction on the BSC wallet. This is viem's documented path for the
 *   native asset. It is one contract call (L1StandardBridge.depositETHTo would add the messenger hop
 *   and its gas), and with the recipient equal to the sender the BNB lands on the same address even
 *   if the L2 call failed, because a deposit's mint is credited to the sender before the call runs.
 * - LONG: approve exactly the amount to the L1StandardBridge, then
 *   depositERC20To(L1_TOKEN, L2_TOKEN, sender, amount, 200000, "0x").
 *
 * Withdrawals (LONGYU -> BSC)
 * - Both assets: L2StandardBridge.withdrawTo(token, sender, amount, 200000, "0x"). For BNB the token
 *   is the legacy ETH address 0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000 and the amount is sent as
 *   value: in opbnb v0.5.6 L2StandardBridge 1.10.0, _initiateWithdrawal routes that address to
 *   _initiateBridgeETH, which requires msg.value == amount (and reverts on a custom gas token chain,
 *   which LONGYU is not). This is chosen over viem's initiateWithdrawal (a bare
 *   L2ToL1MessagePasser call): through the messengers, a delivery that fails on BSC is kept as a
 *   failed message that can be replayed, while the portal marks a bare withdrawal finalized even
 *   when its call fails, losing the BNB. Both assets then share one prove and finalize flow.
 * - Prove: viem's buildProveWithdrawal on the LONGYU client, proveWithdrawal on the BSC wallet.
 *   The proof is built against the latest output when it covers the withdrawal, not the first
 *   output after it: LONGYU's op-geth (path state scheme, gcmode full, pathdb.proposeblock 3600)
 *   only serves storage proofs for recently proposed blocks, and its proof keeper answers only
 *   queries without storage keys. The portal accepts any output that contains the withdrawal.
 * - Finalize: finalizeWithdrawal on the BSC wallet once getWithdrawalStatus says ready-to-finalize.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  parseEventLogs,
  toHex,
  type Address,
  type EIP1193Provider,
  type Hex,
  type TransactionReceipt,
} from "viem";
import {
  chainConfig,
  getL2TransactionHashes,
  getWithdrawals,
  publicActionsL1,
  publicActionsL2,
  walletActionsL1,
  type GetL2OutputReturnType,
} from "viem/op-stack";
import {
  L1_CHAIN_ID,
  L1_EXPLORER,
  L2_CHAIN_ID,
  NATIVE,
  TOKEN,
  L2_CROSS_DOMAIN_MESSENGER,
  L2_STANDARD_BRIDGE,
  L2_TO_L1_MESSAGE_PASSER,
  LEGACY_ERC20_ETH,
  MIN_GAS_LIMIT,
  STORAGE_KEY,
  addTracked,
  describeWithdrawal,
  errorMessage,
  formatAmount,
  formatDuration,
  gasReserve,
  isUnknownChain,
  l1BridgeAbi,
  l1TxUrl,
  l2BridgeAbi,
  l2TxUrl,
  loadTracked,
  longyuChainParams,
  messengerAbi,
  mintableAbi,
  outputOracleAbi,
  outputRootOf,
  PROPOSER_DELAY_SECONDS,
  secondsToProve,
  parseAmount,
  parseConfig,
  parseTxHash,
  portalAbi,
  removeTracked,
  shareAmount,
  shortHex,
  statusView,
  wiringProblems,
  type BridgeConfig,
  type RawConfig,
  type StatusView,
} from "./bridge-core.ts";
import { L1_CHAIN, PROFILE } from "./profile.ts";

declare const __BRIDGE_CONFIG__: RawConfig;
declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const $ = (id: string) => document.getElementById(id)!;
const show = (id: string, on: boolean) => ($(id).hidden = !on);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

type Direction = "deposit" | "withdraw";
/** NATIVE or TOKEN. */
type Asset = string;
type Note = (s: string) => void;
interface Link {
  href: string | null;
  text: string;
}
/** What the wiring check learned: LONGYU's L1 messenger and the oracle's timing. */
interface Wiring {
  messenger: Address;
  period: bigint;
  /** Seconds from one output to the next reaching BSC, at most. */
  interval: bigint;
  submissionInterval: bigint;
  blockTimeMs: bigint;
}
interface Entry {
  index: number;
  status: string;
  seconds?: number;
  asset?: Asset | null;
  amount?: bigint | null;
  note?: string;
  error?: string;
  link?: Link;
}

const MISMATCH = "Bridge contracts do not match LONGYU.";
const parsed = parseConfig(typeof __BRIDGE_CONFIG__ === "undefined" ? null : __BRIDGE_CONFIG__);
if (parsed.ok) start(parsed.config);
else closeBridge(parsed.problems);

/** Without a complete, valid configuration the page shows one line and no action works. */
function closeBridge(problems: string[]): void {
  $("closed").textContent = "The bridge is unavailable on this address.";
  show("closed", true);
  show("history", false);
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("#bridge button, #bridge input").forEach((node) => (node.disabled = true));
  console.info(`Bridge closed: ${problems.join("; ")}.`);
}

function start(cfg: BridgeConfig): void {
  const longyu = defineChain({
    ...chainConfig,
    id: L2_CHAIN_ID,
    name: PROFILE.l2.name,
    nativeCurrency: { name: "BNB", symbol: NATIVE, decimals: 18 },
    rpcUrls: { default: { http: [cfg.l2RpcUrl] } },
    ...(cfg.explorerUrl ? { blockExplorers: { default: { name: "LONGYU Explorer", url: cfg.explorerUrl } } } : {}),
    blockTime: 250,
    contracts: {
      ...chainConfig.contracts,
      portal: { [L1_CHAIN_ID]: { address: cfg.l1Portal } },
      l2OutputOracle: { [L1_CHAIN_ID]: { address: cfg.l1OutputOracle } },
      l1StandardBridge: { [L1_CHAIN_ID]: { address: cfg.l1StandardBridge } },
    },
    sourceId: L1_CHAIN_ID,
    ...PROFILE.l2.chain,
  });
  // Reads go to the configured RPCs, never through the wallet, so they do not depend on its network.
  const l1 = createPublicClient({ chain: L1_CHAIN, transport: http(cfg.l1RpcUrl) }).extend(publicActionsL1());
  const l2 = createPublicClient({ chain: longyu, transport: http(cfg.l2RpcUrl) }).extend(publicActionsL2());
  const bscParams = {
    chainId: toHex(L1_CHAIN_ID),
    chainName: L1_CHAIN.name,
    nativeCurrency: L1_CHAIN.nativeCurrency,
    rpcUrls: [cfg.l1RpcUrl],
    blockExplorerUrls: [L1_EXPLORER],
  };

  const amountInput = $("amount") as HTMLInputElement;
  const hashInput = $("hash") as HTMLInputElement;
  const sendButton = $("send") as HTMLButtonElement;

  let dir: Direction = "deposit";
  let asset: Asset = NATIVE;
  let account: Address | null = null;
  let balance: bigint | null = null;
  /** What a share of the balance leaves behind for gas; nothing for the mined token. */
  let reserve = 0n;
  let busy = false;
  let paused = false;
  let wiring: Wiring | null = null;
  let tracked: Hex[] = readTracked();
  const entries = new Map<Hex, Entry[]>();
  const done = new Set<string>();
  const receipts = new Map<Hex, TransactionReceipt>();
  /** The mined token's two addresses; only a network where it moves has them. */
  const tokens = () => {
    const { l1Token, l2Token } = cfg;
    if (!l1Token || !l2Token) throw new Error(`${TOKEN} moves after the TGE.`);
    return { l1Token, l2Token };
  };

  // ---------------------------------------------------------------- storage (best effort)

  function readTracked(): Hex[] {
    try {
      return loadTracked(localStorage.getItem(STORAGE_KEY));
    } catch {
      return [];
    }
  }
  function track(hash: Hex): void {
    tracked = addTracked(tracked, hash, done);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tracked));
    } catch {
      // private mode or blocked storage: the list lasts for this visit only
    }
    renderList();
  }
  function untrack(hash: Hex): void {
    tracked = removeTracked(tracked, hash);
    entries.delete(hash);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tracked));
    } catch {
      // as above
    }
    renderList();
  }

  // ---------------------------------------------------------------- wiring check

  /** Ties every configured address to LONGYU on chain before the first transaction. */
  let wiringRun: Promise<Wiring> | null = null;
  function checkWiring(): Promise<Wiring> {
    wiringRun ??= readWiring().catch((e: unknown) => {
      wiringRun = null;
      throw e;
    });
    return wiringRun;
  }
  async function readWiring(): Promise<Wiring> {
    const [l1ChainId, l2ChainId] = await Promise.all([
      l1.getChainId().catch(() => Promise.reject(new Error("BNB Smart Chain RPC unreachable. Try again."))),
      l2.getChainId().catch(() => Promise.reject(new Error("LONGYU RPC unreachable. Try again."))),
    ]);
    let observed;
    try {
      const { l1Token, l2Token } = cfg;
      const [[portalVersion, portalOracle, bridgeMessenger, period, interval, blockTimeMs, l2OtherBridge, l2OtherMessenger], token] = await Promise.all([
        Promise.all([
          l1.readContract({ address: cfg.l1Portal, abi: portalAbi, functionName: "version" }),
          l1.readContract({ address: cfg.l1Portal, abi: portalAbi, functionName: "l2Oracle" }),
          l1.readContract({ address: cfg.l1StandardBridge, abi: l1BridgeAbi, functionName: "messenger" }),
          l1.readContract({ address: cfg.l1OutputOracle, abi: outputOracleAbi, functionName: "FINALIZATION_PERIOD_SECONDS" }),
          l1.readContract({ address: cfg.l1OutputOracle, abi: outputOracleAbi, functionName: "SUBMISSION_INTERVAL" }),
          l1.readContract({ address: cfg.l1OutputOracle, abi: outputOracleAbi, functionName: "L2_FOURIER_MILLISECONDS_BLOCK_TIME" }),
          l2.readContract({ address: L2_STANDARD_BRIDGE, abi: l2BridgeAbi, functionName: "otherBridge" }),
          l2.readContract({ address: L2_CROSS_DOMAIN_MESSENGER, abi: messengerAbi, functionName: "otherMessenger" }),
        ]),
        // The mined token's side, where it moves.
        l1Token && l2Token
          ? Promise.all([
              l1.readContract({ address: l1Token, abi: erc20Abi, functionName: "decimals" }),
              l2.readContract({ address: l2Token, abi: mintableAbi, functionName: "remoteToken" }),
              l2.readContract({ address: l2Token, abi: mintableAbi, functionName: "bridge" }),
              l2.readContract({ address: l2Token, abi: mintableAbi, functionName: "decimals" }),
            ]).then(([l1TokenDecimals, l2TokenRemote, l2TokenBridge, l2TokenDecimals]) => ({ l1TokenDecimals, l2TokenRemote, l2TokenBridge, l2TokenDecimals }))
          : {},
      ]);
      const messengerPortal = await l1.readContract({ address: bridgeMessenger, abi: messengerAbi, functionName: "portal" });
      observed = {
        value: { messenger: bridgeMessenger, period, interval: (interval * blockTimeMs) / 1000n + BigInt(PROPOSER_DELAY_SECONDS), submissionInterval: interval, blockTimeMs },
        problems: wiringProblems({ l1ChainId, l2ChainId, portalVersion, portalOracle, bridgeMessenger, messengerPortal, l2OtherBridge, l2OtherMessenger, ...token }, cfg),
      };
    } catch (e) {
      console.warn("Bridge wiring check failed:", e);
      throw new Error(isContractError(e) ? MISMATCH : "Network busy. Try again.");
    }
    if (observed.problems.length) {
      console.warn(`Bridge wiring: ${observed.problems.join("; ")}.`);
      throw new Error(MISMATCH);
    }
    wiring = observed.value;
    renderForm();
    return wiring;
  }
  /** A read that reached the chain and failed there (no code, wrong contract), as opposed to a network error. */
  function isContractError(e: unknown): boolean {
    for (let cur = e as { name?: string; cause?: unknown } | undefined, i = 0; cur && i < 8; cur = cur.cause as typeof cur, i++) {
      if (cur.name === "ContractFunctionZeroDataError" || cur.name === "ContractFunctionRevertedError") return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- wallet

  function provider(): EIP1193Provider {
    const eth = window.ethereum;
    if (!eth) throw new Error("No wallet found. Open this page in your wallet's browser (MetaMask, Trust Wallet or Binance Wallet).");
    return eth;
  }

  async function connect(): Promise<Address> {
    const [first] = (await provider().request({ method: "eth_requestAccounts" })) as Address[];
    if (!first) throw new Error("No account selected in the wallet.");
    const next = getAddress(first);
    if (next !== account) {
      account = next;
      renderForm();
      void refreshBalance();
    }
    return next;
  }

  /** Puts the wallet on the chain the next transaction is for, adding LONGYU (or BSC) when the wallet lacks it. */
  async function ensureChain(target: "l1" | "l2", note: Note): Promise<void> {
    const eth = provider();
    const id = target === "l1" ? L1_CHAIN_ID : L2_CHAIN_ID;
    const name = target === "l1" ? PROFILE.l1.name : PROFILE.l2.name;
    const current = async () => Number(await eth.request({ method: "eth_chainId" }));
    if ((await current()) === id) return;
    note(`Switch your wallet to ${name}`);
    const chainId = toHex(id);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (e) {
      if (!isUnknownChain(e)) throw e;
      await eth.request({ method: "wallet_addEthereumChain", params: [target === "l1" ? bscParams : longyuChainParams(cfg)] });
      if ((await current()) !== id) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    }
    if ((await current()) !== id) throw new Error(`Switch your wallet to ${name}.`);
  }

  const l1Wallet = () => createWalletClient({ chain: L1_CHAIN, transport: custom(provider()) }).extend(walletActionsL1());
  const l2Wallet = () => createWalletClient({ chain: longyu, transport: custom(provider()) });

  const l1Fee = async (gas: bigint) => gas * (await l1.getGasPrice());
  /** L2 execution plus the L1 data fee LONGYU charges for posting the transaction to BSC. */
  const l2Fee = async (gas: bigint, tx: { account: Address; to: Address; data: Hex; value: bigint }) => {
    const [price, dataFee] = await Promise.all([l2.getGasPrice(), l2.estimateL1Fee({ ...tx, chain: longyu }).catch(() => 0n)]);
    return gas * price + dataFee;
  };

  function setLink(id: "tx" | "tx2", href: string | null, text: string): void {
    const a = $(id) as HTMLAnchorElement;
    if (href) a.href = href;
    else a.removeAttribute("href");
    a.textContent = text;
    show(id, true);
  }
  const setStatus: Note = (s) => ($("status").textContent = s);

  // ---------------------------------------------------------------- deposits

  async function depositBnb(amount: bigint, from: Address): Promise<void> {
    const shown = `${formatAmount(amount)} ${NATIVE}`;
    const held = await l1.getBalance({ address: from });
    if (held < amount) throw new Error(`Not enough ${NATIVE} on BSC: ${formatAmount(held)}.`);
    const args = await l2.buildDepositTransaction({ account: from, mint: amount, to: from });
    const fee = await l1Fee(await l1.estimateDepositTransactionGas({ account: from, request: args.request, targetChain: longyu }));
    if (held < amount + fee) throw new Error(`Not enough ${NATIVE} on BSC for ${shown} plus gas.`);
    await ensureChain("l1", setStatus);
    setStatus(`Confirm ${shown} in your wallet`);
    const hash = await l1Wallet().depositTransaction(args);
    await followDeposit(hash, shown);
  }

  async function depositLong(amount: bigint, from: Address): Promise<void> {
    const shown = `${formatAmount(amount)} ${TOKEN}`;
    const { l1Token, l2Token } = tokens();
    const tokenBalance = () => l1.readContract({ address: l1Token, abi: erc20Abi, functionName: "balanceOf", args: [from] });
    const allowance = () => l1.readContract({ address: l1Token, abi: erc20Abi, functionName: "allowance", args: [from, cfg.l1StandardBridge] });
    const held = await tokenBalance();
    if (held < amount) throw new Error(`Not enough ${TOKEN} on BSC: ${formatAmount(held)}.`);
    const gasMoney = await l1.getBalance({ address: from });
    if ((await allowance()) < amount) {
      const approve = { account: from, address: l1Token, abi: erc20Abi, functionName: "approve", args: [cfg.l1StandardBridge, amount] } as const;
      if (gasMoney < (await l1Fee(await l1.estimateContractGas(approve)))) throw new Error(`Not enough ${NATIVE} on BSC for gas.`);
      await ensureChain("l1", setStatus);
      setStatus(`1/2 · Approve ${shown} in your wallet`);
      const hash = await l1Wallet().writeContract(approve);
      setLink("tx", l1TxUrl(hash), "Approval on BscScan");
      setStatus("1/2 · Confirming the approval…");
      if ((await l1.waitForTransactionReceipt({ hash })).status !== "success") throw new Error("The approval failed on BSC.");
      // The RPC behind the page may trail the one that saw the receipt; wait until it shows the allowance.
      for (let i = 0; (await allowance()) < amount; i++) {
        if (i === 15) throw new Error("The approval is not visible yet. Try again in a minute.");
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    const deposit = {
      account: from,
      address: cfg.l1StandardBridge,
      abi: l1BridgeAbi,
      functionName: "depositERC20To",
      args: [l1Token, l2Token, from, amount, MIN_GAS_LIMIT, "0x"],
    } as const;
    if ((await l1.getBalance({ address: from })) < (await l1Fee(await l1.estimateContractGas(deposit)))) throw new Error(`Not enough ${NATIVE} on BSC for gas.`);
    await ensureChain("l1", setStatus);
    setStatus(`2/2 · Confirm the deposit of ${shown}`);
    const hash = await l1Wallet().writeContract(deposit);
    await followDeposit(hash, shown);
  }

  /** Waits for the BSC transaction, then for the deposit it creates on LONGYU. */
  async function followDeposit(hash: Hex, shown: string): Promise<void> {
    setLink("tx", l1TxUrl(hash), "Deposit on BscScan");
    setStatus("Confirming on BSC…");
    const receipt = await l1.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The deposit failed on BSC. Only gas was spent.");
    const [l2Hash] = getL2TransactionHashes({ logs: receipt.logs.filter((l) => same(l.address, cfg.l1Portal)) });
    if (!l2Hash) throw new Error("The BSC transaction made no LONGYU deposit.");
    void refreshBalance();
    setStatus(`${shown} on the way to LONGYU…`);
    let arrived: TransactionReceipt;
    try {
      arrived = await l2.waitForTransactionReceipt({ hash: l2Hash, timeout: 15 * 60_000, pollingInterval: 4_000 });
    } catch {
      setStatus("Still on the way. Your balance on LONGYU updates when it lands.");
      return;
    }
    setLink("tx2", l2TxUrl(cfg.explorerUrl, l2Hash), cfg.explorerUrl ? "Arrival on LONGYU" : `LONGYU ${shortHex(l2Hash)}`);
    const relayFailed = parseEventLogs({
      abi: messengerAbi,
      eventName: "FailedRelayedMessage",
      logs: arrived.logs.filter((l) => same(l.address, L2_CROSS_DOMAIN_MESSENGER)),
    });
    if (arrived.status !== "success" || relayFailed.length) throw new Error("The deposit reached LONGYU but was not delivered. It can be replayed.");
    setStatus(`${shown} arrived on LONGYU.`);
  }

  // ---------------------------------------------------------------- withdrawals

  async function withdraw(kind: Asset, amount: bigint, from: Address, w: Wiring): Promise<void> {
    const shown = `${formatAmount(amount)} ${kind}`;
    const native = await l2.getBalance({ address: from });
    if (kind === NATIVE && native < amount) throw new Error(`Not enough ${NATIVE} on LONGYU: ${formatAmount(native)}.`);
    if (kind === TOKEN) {
      const held = await l2.readContract({ address: tokens().l2Token, abi: erc20Abi, functionName: "balanceOf", args: [from] });
      if (held < amount) throw new Error(`Not enough ${TOKEN} on LONGYU: ${formatAmount(held)}.`);
    }
    const value = kind === NATIVE ? amount : 0n;
    const args = [kind === NATIVE ? LEGACY_ERC20_ETH : tokens().l2Token, from, amount, MIN_GAS_LIMIT, "0x"] as const;
    const call = { account: from, address: L2_STANDARD_BRIDGE, abi: l2BridgeAbi, functionName: "withdrawTo", args, value } as const;
    const gas = await l2.estimateContractGas(call);
    const fee = await l2Fee(gas, { account: from, to: L2_STANDARD_BRIDGE, data: encodeFunctionData({ abi: l2BridgeAbi, functionName: "withdrawTo", args }), value });
    if (native < value + fee) throw new Error(kind === NATIVE ? `Not enough ${NATIVE} on LONGYU for ${shown} plus gas.` : `Not enough ${NATIVE} on LONGYU for gas.`);
    await ensureChain("l2", setStatus);
    setStatus(`Confirm the withdrawal of ${shown}`);
    const hash = await l2Wallet().writeContract(call);
    track(hash); // kept before anything else can fail, so the withdrawal is never lost from the list
    void refreshOne(hash);
    setLink("tx", l2TxUrl(cfg.explorerUrl, hash), cfg.explorerUrl ? "Withdrawal on LONGYU" : `LONGYU ${shortHex(hash)}`);
    setStatus("Confirming on LONGYU…");
    const receipt = await l2.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The withdrawal failed on LONGYU. Only gas was spent.");
    setStatus(`Started. Prove on BSC in ≈ ${formatDuration(Number(w.interval))}, then wait ${formatDuration(Number(w.period))}.`);
    void refreshOne(hash);
  }

  async function withdrawalReceipt(hash: Hex) {
    let receipt = receipts.get(hash);
    if (!receipt) {
      receipt = await l2.getTransactionReceipt({ hash });
      receipts.set(hash, receipt);
    }
    // Only the message passer's events are withdrawals; a contract could emit a look-alike event.
    const logs = receipt.logs.filter((l) => same(l.address, L2_TO_L1_MESSAGE_PASSER));
    return { receipt: { ...receipt, logs }, withdrawals: getWithdrawals({ logs }) };
  }

  /** Builds the proof against the latest output, falling back to the first output after the withdrawal. */
  async function buildProof(receipt: TransactionReceipt, withdrawal: ReturnType<typeof getWithdrawals>[number], from: Address) {
    const latestIndex = await l1.readContract({ address: cfg.l1OutputOracle, abi: outputOracleAbi, functionName: "latestOutputIndex" });
    const latest = await l1.readContract({ address: cfg.l1OutputOracle, abi: outputOracleAbi, functionName: "getL2Output", args: [latestIndex] });
    const outputs: GetL2OutputReturnType[] = [];
    if (latest.l2BlockNumber >= receipt.blockNumber) outputs.push({ outputIndex: latestIndex, ...latest });
    const first = await l1.getL2Output({ l2BlockNumber: receipt.blockNumber, targetChain: longyu });
    if (!outputs.some((o) => o.outputIndex === first.outputIndex)) outputs.push(first);
    for (const output of outputs) {
      try {
        const args = await l2.buildProveWithdrawal({ account: from, output, withdrawal });
        if (same(outputRootOf(args.outputRootProof), output.outputRoot)) return args;
        console.warn(`Proof for output ${output.outputIndex} does not match its root.`);
      } catch (e) {
        console.warn(`No proof at output ${output.outputIndex}:`, e);
      }
    }
    throw new Error("LONGYU cannot serve this proof right now. Try again after the next state root.");
  }

  async function prove(hash: Hex, index: number, note: Note, entry: Entry): Promise<void> {
    const from = await connect();
    await checkWiring();
    const { receipt, withdrawals } = await withdrawalReceipt(hash);
    const withdrawal = withdrawals[index];
    if (!withdrawal) throw new Error("Withdrawal not found.");
    const status = await l1.getWithdrawalStatus({ receipt, logIndex: index, targetChain: longyu });
    if (status !== "ready-to-prove") throw new Error(`${statusView(status).label}.`);
    note("Building the proof…");
    const args = await buildProof(receipt, withdrawal, from);
    const fee = await l1Fee(await l1.estimateProveWithdrawalGas(args));
    if ((await l1.getBalance({ address: from })) < fee) throw new Error(`Not enough ${NATIVE} on BSC for gas.`);
    await ensureChain("l1", note);
    note("Confirm the proof in your wallet");
    const tx = await l1Wallet().proveWithdrawal(args);
    entry.link = { href: l1TxUrl(tx), text: "Proof on BscScan" };
    note("Confirming on BSC…");
    if ((await l1.waitForTransactionReceipt({ hash: tx })).status !== "success") throw new Error("The proof failed on BSC. Only gas was spent.");
    note("Proven.");
  }

  async function finalize(hash: Hex, index: number, note: Note, entry: Entry): Promise<void> {
    const from = await connect();
    const w = await checkWiring();
    const { receipt, withdrawals } = await withdrawalReceipt(hash);
    const withdrawal = withdrawals[index];
    if (!withdrawal) throw new Error("Withdrawal not found.");
    const status = await l1.getWithdrawalStatus({ receipt, logIndex: index, targetChain: longyu });
    if (status !== "ready-to-finalize") throw new Error(`${statusView(status).label}.`);
    const request = { account: from, targetChain: longyu, withdrawal };
    const fee = await l1Fee(await l1.estimateFinalizeWithdrawalGas(request));
    if ((await l1.getBalance({ address: from })) < fee) throw new Error(`Not enough ${NATIVE} on BSC for gas.`);
    await ensureChain("l1", note);
    note("Confirm the finalization in your wallet");
    const tx = await l1Wallet().finalizeWithdrawal(request);
    entry.link = { href: l1TxUrl(tx), text: "Finalization on BscScan" };
    note("Confirming on BSC…");
    const r = await l1.waitForTransactionReceipt({ hash: tx });
    if (r.status !== "success") throw new Error("The finalization failed on BSC. Only gas was spent.");
    const finalized = parseEventLogs({ abi: portalAbi, eventName: "WithdrawalFinalized", logs: r.logs.filter((l) => same(l.address, cfg.l1Portal)) });
    const relayFailed = parseEventLogs({ abi: messengerAbi, eventName: "FailedRelayedMessage", logs: r.logs.filter((l) => same(l.address, w.messenger)) });
    if (finalized.some((e) => !e.args.success) || relayFailed.length) throw new Error("Finalized, but delivery on BSC failed. It can be replayed.");
    note("Finalized.");
  }

  // ---------------------------------------------------------------- withdrawal list

  async function timeToProve(withdrawalBlock: bigint): Promise<number> {
    const w = await checkWiring();
    const [nextOutputBlock, head] = await Promise.all([
      l1.readContract({ address: cfg.l1OutputOracle, abi: outputOracleAbi, functionName: "nextBlockNumber" }),
      l2.getBlockNumber(),
    ]);
    return secondsToProve({ withdrawalBlock, nextOutputBlock, submissionInterval: w.submissionInterval, head, blockTimeMs: w.blockTimeMs });
  }

  async function inspect(hash: Hex): Promise<Entry[]> {
    let data;
    try {
      data = await withdrawalReceipt(hash);
    } catch (e) {
      return [{ index: 0, status: (e as { name?: string }).name === "TransactionReceiptNotFoundError" ? "pending" : "error" }];
    }
    if (data.receipt.status !== "success") return [{ index: 0, status: "reverted" }];
    if (!data.withdrawals.length) return [{ index: 0, status: "not-withdrawal" }];
    return Promise.all(
      data.withdrawals.map(async (wd, index): Promise<Entry> => {
        const info = describeWithdrawal(wd, cfg);
        try {
          const status = await l1.getWithdrawalStatus({ receipt: data.receipt, logIndex: index, targetChain: longyu });
          let seconds: number | undefined;
          if (status === "waiting-to-finalize") seconds = (await l1.getTimeToFinalize({ withdrawalHash: wd.withdrawalHash, targetChain: longyu })).seconds;
          if (status === "waiting-to-prove") seconds = await timeToProve(data.receipt.blockNumber).catch(() => undefined);
          return { index, status, seconds, asset: info.asset, amount: info.amount };
        } catch (e) {
          console.warn(`Withdrawal status for ${hash}:`, e);
          return { index, status: "error", asset: info.asset, amount: info.amount };
        }
      }),
    );
  }

  const carried = (e?: Entry) => (e ? { note: e.note, error: e.error, link: e.link } : {});
  async function refreshOne(hash: Hex): Promise<void> {
    try {
      await checkWiring();
    } catch {
      entries.set(hash, [{ index: 0, status: "error" }]);
      return renderList();
    }
    const fresh = await inspect(hash);
    const old = entries.get(hash) ?? [];
    // Keep what the visitor saw during an action (its note, error and link) across the refresh.
    for (const e of fresh) Object.assign(e, carried(old.find((o) => o.index === e.index)));
    if (!tracked.includes(hash)) return;
    entries.set(hash, fresh);
    if (fresh.every((e) => e.status === "finalized")) done.add(hash);
    renderList();
  }

  let refreshing = false;
  async function refreshList(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      paused = await l1.readContract({ address: cfg.l1Portal, abi: portalAbi, functionName: "paused" }).catch(() => paused);
      await Promise.all(tracked.filter((h) => !done.has(h)).map(refreshOne));
    } finally {
      refreshing = false;
      renderList();
    }
  }

  function renderList(): void {
    const list = $("list");
    list.replaceChildren();
    show("empty", tracked.length === 0);
    for (const hash of tracked) {
      const items = entries.get(hash) ?? [{ index: 0, status: "loading" }];
      for (const entry of items) list.append(itemNode(hash, entry, items.length > 1));
    }
  }

  function itemNode(hash: Hex, entry: Entry, numbered: boolean): HTMLElement {
    const view: StatusView = entry.status === "loading" ? { label: "Checking…", action: null, tone: "wait" } : statusView(entry.status, { paused });
    const item = el("div", "item");

    const top = el("div", "row");
    const what = entry.amount != null && entry.asset ? `${formatAmount(entry.amount)} ${entry.asset}` : "Withdrawal";
    top.append(el("span", "amount num", numbered ? `${what} · ${entry.index + 1}` : what));
    const remove = el("button", "x", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove from list");
    remove.disabled = busy;
    remove.onclick = () => untrack(hash);
    top.append(remove);

    const state = el("div", "row");
    let time = "";
    if (entry.seconds && entry.seconds > 0) time = entry.status === "waiting-to-finalize" ? `${formatDuration(entry.seconds)} left` : `≈ ${formatDuration(entry.seconds)}`;
    state.append(el("span", view.tone, view.label), el("span", "muted num", time));

    const ref = el("div", "row muted");
    const href = l2TxUrl(cfg.explorerUrl, hash);
    const link = el(href ? "a" : "span", "num", shortHex(hash));
    link.title = hash;
    if (link instanceof HTMLAnchorElement && href) Object.assign(link, { href, target: "_blank", rel: "noopener noreferrer" });
    ref.append(link);
    if (entry.link) {
      const a = el("a", "", entry.link.text);
      if (entry.link.href) Object.assign(a, { href: entry.link.href, target: "_blank", rel: "noopener noreferrer" });
      ref.append(a);
    }
    item.append(top, state, ref);

    if (view.action) {
      const act = el("button", "act", view.action === "prove" ? "Prove on BSC" : "Finalize on BSC");
      act.type = "button";
      act.disabled = busy;
      const action = view.action;
      act.onclick = () => void runItem(hash, entry, action);
      item.append(act);
    }
    item.append(el("div", "muted note", entry.note ?? ""), el("div", "err", entry.error ?? ""));
    return item;
  }

  async function runItem(hash: Hex, entry: Entry, action: "prove" | "finalize"): Promise<void> {
    if (busy) return;
    setBusy(true);
    Object.assign(entry, { note: "", error: "", link: undefined });
    const note: Note = (s) => {
      entry.note = s;
      renderList();
    };
    try {
      await (action === "prove" ? prove : finalize)(hash, entry.index, note, entry);
    } catch (e) {
      entry.note = "";
      entry.error = errorMessage(e);
    } finally {
      setBusy(false);
      await refreshOne(hash);
    }
  }

  // ---------------------------------------------------------------- form

  let balanceRun = 0;
  async function refreshBalance(): Promise<void> {
    const run = ++balanceRun;
    balance = null;
    if (!account) return void ($("balance").textContent = "–");
    $("balance").textContent = "…";
    const who = account;
    try {
      const value =
        dir === "deposit"
          ? asset === NATIVE
            ? await l1.getBalance({ address: who })
            : await l1.readContract({ address: tokens().l1Token, abi: erc20Abi, functionName: "balanceOf", args: [who] })
          : asset === NATIVE
            ? await l2.getBalance({ address: who })
            : await l2.readContract({ address: tokens().l2Token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
      const price = asset !== NATIVE ? 0n : await (dir === "deposit" ? l1.getGasPrice() : l2.getGasPrice()).catch(() => 0n);
      if (run !== balanceRun) return;
      balance = value;
      reserve = asset === NATIVE ? gasReserve(price) : 0n;
      $("balance").textContent = `${formatAmount(value)} ${asset}`;
    } catch {
      if (run === balanceRun) $("balance").textContent = "–";
    }
  }

  function renderForm(): void {
    $("dir-deposit").setAttribute("aria-pressed", String(dir === "deposit"));
    $("dir-withdraw").setAttribute("aria-pressed", String(dir === "withdraw"));
    $("asset-bnb").setAttribute("aria-pressed", String(asset === NATIVE));
    $("asset-long").setAttribute("aria-pressed", String(asset === TOKEN));
    $("route").textContent = dir === "deposit" ? `${PROFILE.l1.name} → LONGYU` : `LONGYU → ${PROFILE.l1.name}`;
    $("eta").textContent = dir === "deposit" ? "≈ 1 min" : wiring ? `≈ ${formatDuration(Number(wiring.interval + wiring.period))}` : "–";
    show("quick", account !== null);
    show("connect", account === null);
    show("send", account !== null);
    show("to-row", account !== null);
    $("to").textContent = account ? shortHex(account) : "";
    $("to").title = account ?? "";
    const amount = parseAmount(amountInput.value);
    const verb = dir === "deposit" ? "Deposit" : "Withdraw";
    sendButton.textContent = amount ? `${verb} ${formatAmount(amount)} ${asset}` : verb;
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("#bridge button, #bridge input, #history button").forEach((node) => (node.disabled = busy));
    // Where the mined token does not move yet, its choice stays off.
    if (!cfg.l1Token || !cfg.l2Token) ($("asset-long") as HTMLButtonElement).disabled = true;
  }

  function setBusy(on: boolean): void {
    busy = on;
    renderForm();
    renderList();
  }

  function choose(next: { dir?: Direction; asset?: Asset }): void {
    if (busy) return;
    dir = next.dir ?? dir;
    asset = next.asset ?? asset;
    ["tx", "tx2"].forEach((id) => show(id, false));
    setStatus("");
    $("error").textContent = "";
    renderForm();
    void refreshBalance();
  }

  async function run(task: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    $("error").textContent = "";
    setStatus("");
    ["tx", "tx2"].forEach((id) => show(id, false));
    try {
      await task();
    } catch (e) {
      setStatus("");
      $("error").textContent = errorMessage(e);
    } finally {
      setBusy(false);
      void refreshBalance();
    }
  }

  $("dir-deposit").onclick = () => choose({ dir: "deposit" });
  $("dir-withdraw").onclick = () => choose({ dir: "withdraw" });
  $("asset-bnb").onclick = () => choose({ asset: NATIVE });
  $("asset-long").onclick = () => choose({ asset: TOKEN });
  amountInput.oninput = renderForm;
  document.querySelectorAll<HTMLButtonElement>("#quick button").forEach((node) => {
    node.onclick = () => {
      if (balance === null) return;
      const amount = shareAmount(balance, Number(node.dataset.share), reserve);
      amountInput.value = amount > 0n ? formatAmount(amount) : "";
      setStatus("");
      $("error").textContent = amount > 0n ? "" : balance > 0n ? `Not enough ${NATIVE} to leave for gas.` : `No ${asset} here yet.`;
      renderForm();
    };
  });
  $("connect").onclick = () => run(async () => void (await connect()));
  sendButton.onclick = () =>
    run(async () => {
      const text = amountInput.value.trim();
      const amount = parseAmount(text);
      if (!text) throw new Error("Enter an amount.");
      if (amount === null) throw new Error("Use digits and at most 18 decimals.");
      if (amount === 0n) throw new Error("Enter an amount above 0.");
      const [d, a] = [dir, asset];
      const from = await connect();
      const w = await checkWiring();
      if (d === "withdraw") await withdraw(a, amount, from, w);
      else if (a === NATIVE) await depositBnb(amount, from);
      else await depositLong(amount, from);
    });
  $("add").onclick = () => {
    const hash = parseTxHash(hashInput.value);
    $("track-error").textContent = hash ? "" : "Not a transaction hash.";
    if (!hash) return;
    hashInput.value = "";
    track(hash);
    void refreshOne(hash);
  };

  const eth = window.ethereum;
  if (eth) {
    eth.on?.("accountsChanged", (accounts: readonly Address[]) => {
      account = accounts[0] ? getAddress(accounts[0]) : null;
      renderForm();
      void refreshBalance();
    });
    eth
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        if (accounts[0] && !account) {
          account = getAddress(accounts[0]);
          renderForm();
          void refreshBalance();
        }
      })
      .catch(() => undefined);
  }

  renderForm();
  renderList();
  checkWiring().then(
    () => refreshList(),
    (e: unknown) => {
      $("error").textContent = errorMessage(e);
      void refreshList(); // retries the check once and marks the list unavailable if it fails again
    },
  );
  setInterval(() => {
    if (!document.hidden && !busy) void refreshList();
  }, 60_000);
}
