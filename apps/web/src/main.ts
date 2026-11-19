import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  http,
  keccak256,
  stringToBytes,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { miningDistributorAbi } from "@longyu/abis";
import {
  ApiError,
  addChainParams,
  formatAmount,
  logWindows,
  mineLinks,
  owed,
  proofFailure,
  rewardSymbol,
  trustedNetwork,
  watchAssetParams,
  type NetworkInfo,
} from "./chain.ts";
import { errorMessage, isUnknownChain } from "./wallet-core.ts";

declare const __API_URL__: string;
declare const __FALLBACK_NETWORK__: NetworkInfo | null;
declare const __MINE_URL__: string;
declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const $ = (id: string) => document.getElementById(id)!;
const setError = (e: unknown) => ($("error").textContent = errorMessage(e));
const setStatus = (s: string) => ($("status").textContent = s);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error);
  return res.json() as Promise<T>;
}

type Proof = { cumulativeAmount: string; proof: Hex[] };

/** Where rewards are earned: shown when the page was built with LONGYU MINE's address. */
function showMine(): void {
  const links = mineLinks(typeof __MINE_URL__ === "undefined" ? "" : __MINE_URL__);
  if (!links) return;
  ($("mine-web") as HTMLAnchorElement).href = links.web;
  ($("mine-android") as HTMLAnchorElement).href = links.android;
  $("mine").hidden = false;
}

async function main(): Promise<void> {
  const answer = await getJson<NetworkInfo>(`${__API_URL__}/v1/network`).catch(() => null);
  // A page built with network details keeps to its own chain and contract (see trustedNetwork).
  const trusted = trustedNetwork(answer, __FALLBACK_NETWORK__);
  if (!trusted) throw new Error("The LONGYU API is unreachable and this page was built without network details.");
  if (answer && trusted !== answer) console.warn("Claim: the API names another chain or contract than this page was built with; the page's own are used.");
  const network: NetworkInfo = trusted;
  const distributor = network.distributor as Address;
  const chain = defineChain({
    id: Number(network.chainId),
    name: network.chainName,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: { default: { http: [network.rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(network.rpcUrl) });
  $("network").textContent = `${network.chainName} (${network.chainId})`;
  const symbol = rewardSymbol(network);
  $("symbol").textContent = symbol;
  $("watch").textContent = `Show ${symbol} in my wallet`;
  getJson<{ verifiedMiners: string; latestSettlement: { day: string } | null }>(`${__API_URL__}/v1/stats`)
    .then((s) => {
      $("miners").textContent = s.verifiedMiners;
      $("day").textContent = s.latestSettlement?.day ?? "–";
    })
    .catch(() => undefined);

  /**
   * Without the API: read the claimable root from the contract, find that day's published data file
   * through the RootProposed event, check it against the on-chain data hash, rebuild the tree and
   * take the proof from it. Null when no root is claimable yet or the address is not in it.
   */
  async function proofFromChain(account: Address): Promise<Proof | null> {
    const active = await pub.readContract({ address: distributor, abi: miningDistributorAbi, functionName: "activeRoot" });
    if (/^0x0+$/.test(active.root)) return null;
    // The RPC refuses wide log searches: look where the root's time points first, then back from the head.
    let dataURI: string | undefined;
    for (const range of logWindows(await pub.getBlock(), active.postedAt)) {
      const logs = await pub.getContractEvents({
        address: distributor,
        abi: miningDistributorAbi,
        eventName: "RootProposed",
        args: { day: active.day },
        ...range,
      });
      dataURI = logs.reverse().find((l) => l.args.root === active.root)?.args.dataURI;
      if (dataURI) break;
    }
    if (!dataURI) throw new Error("Could not find the published data for the active root.");
    const text = await fetch(dataURI)
      .then((res) => (res.ok ? res.text() : Promise.reject()))
      .catch(() => Promise.reject(new Error("Could not read the published data for the active root.")));
    if (keccak256(stringToBytes(text)) !== active.dataHash) throw new Error("The published data does not match the hash on-chain.");
    const data = JSON.parse(text) as { entries: { account: string; cumulative: string }[] };
    const values = data.entries.map((e) => [network.chainId, getAddress(distributor), getAddress(e.account), e.cumulative]);
    const tree = StandardMerkleTree.of(values, ["uint256", "address", "address", "uint256"]);
    if (tree.root !== active.root) throw new Error("Rebuilt tree does not match the on-chain root.");
    for (const [i, v] of tree.entries()) {
      if (v[2] === getAddress(account)) return { cumulativeAmount: String(v[3]), proof: tree.getProof(i) as Hex[] };
    }
    return null;
  }

  let account: Address | null = null;
  let proof: Proof | null = null;

  const refresh = async () => {
    const who = account;
    if (!who) return;
    $("address").textContent = who;
    try {
      const p = await getJson<Proof>(`${__API_URL__}/v1/rewards/proof/${who}`).catch((e) => {
        const failure = proofFailure(e);
        if (failure === "nothing") return null;
        if (failure === "error") throw e;
        setStatus("API unavailable; reading the proof from the chain and the published data…");
        return proofFromChain(who);
      });
      const claimed = p ? await pub.readContract({ address: distributor, abi: miningDistributorAbi, functionName: "claimed", args: [who] }) : 0n;
      // Another account was connected while this one loaded.
      if (who !== account) return;
      const amount = p ? owed(BigInt(p.cumulativeAmount), claimed) : 0n;
      proof = p;
      $("owed").textContent = `${formatAmount(amount)} ${symbol}`;
      ($("claim") as HTMLButtonElement).disabled = amount === 0n;
      setStatus(amount === 0n ? "Nothing to claim yet." : "");
      $("error").textContent = "";
    } catch (e) {
      if (who !== account) return;
      proof = null;
      $("owed").textContent = `0 ${symbol}`;
      ($("claim") as HTMLButtonElement).disabled = true;
      setStatus("");
      setError(e);
    }
  };

  /** Puts the wallet on LONGYU, adding the network when the wallet does not know it. */
  const ensureChain = async (eth: EIP1193Provider) => {
    const params = addChainParams(network);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: params.chainId }] } as never);
    } catch (e) {
      if (!isUnknownChain(e)) throw e;
      await eth.request({ method: "wallet_addEthereumChain", params: [params] } as never);
    }
  };

  $("connect").addEventListener("click", async () => {
    $("error").textContent = "";
    const eth = window.ethereum;
    if (!eth) return setError("No browser wallet found. Install MetaMask or open this page in your wallet's browser.");
    try {
      const wallet = createWalletClient({ chain, transport: custom(eth) });
      [account] = await wallet.requestAddresses();
    } catch (e) {
      return setError(e);
    }
    $("watch").hidden = !watchAssetParams(network);
    const loaded = refresh();
    // A wallet that refuses the network stays connected; the claim asks for it again.
    await ensureChain(eth).catch(() => undefined);
    await loaded;
  });

  $("claim").addEventListener("click", async () => {
    if (!account || !proof || !window.ethereum) return;
    $("error").textContent = "";
    try {
      const wallet = createWalletClient({ account, chain, transport: custom(window.ethereum) });
      await ensureChain(window.ethereum);
      const hash = await wallet.writeContract({
        address: distributor,
        abi: miningDistributorAbi,
        functionName: "claim",
        args: [account, BigInt(proof.cumulativeAmount), proof.proof],
      });
      setStatus(`Confirming… Transaction ${hash}`);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        setStatus(`Transaction ${hash}`);
        throw new Error("The claim failed on chain. Only gas was spent.");
      }
      await refresh();
      setStatus(`Claimed. Transaction ${hash}`);
    } catch (e) {
      setError(e);
    }
  });

  $("watch").addEventListener("click", async () => {
    const params = watchAssetParams(network);
    if (!params || !window.ethereum) return;
    try {
      await window.ethereum.request({ method: "wallet_watchAsset", params } as never);
    } catch (e) {
      setError(e);
    }
  });
}

showMine();
main().catch(setError);
