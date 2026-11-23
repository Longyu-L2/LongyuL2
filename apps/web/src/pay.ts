/**
 * Pay page: completes a LONGYU order (a mining boost or a partner order) with the visitor's own
 * wallet on BNB Smart Chain. Opened from the app as /pay.html?order=<order id>.
 * Token payments approve exactly the order amount, then call PaymentRouter.payToken; BNB payments
 * call payNative. The page then waits for the API to see the payment as final.
 */
import { createPublicClient, createWalletClient, custom, erc20Abi, type Address, type EIP1193Provider, type Hex } from "viem";
import { bsc } from "viem/chains";
import { paymentRouterAbi } from "@longyu/abis";
import { explorerTxUrl, parseOrderId, type OrderView } from "./pay-core.ts";
import { L1_CHAIN } from "./profile.ts";
import { closedByVisitor, walletSession } from "./wallet-modal.ts";

declare const __API_URL__: string;
declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const $ = (id: string) => document.getElementById(id)!;
const show = (id: string, on: boolean) => ($(id).hidden = !on);
const setError = (e: unknown) => {
  const m = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
  $("error").textContent = /User rejected|denied/i.test(m) ? "You cancelled the request in your wallet." : m;
};
const setStatus = (s: string) => ($("status").textContent = s);

async function getOrder(orderId: string): Promise<OrderView> {
  const res = await fetch(`${__API_URL__}/v1/orders/${orderId}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error === "order_not_found" ? "This order does not exist." : `Could not load the order (${body.error ?? res.status}).`);
  return body as OrderView;
}

function render(o: OrderView): void {
  $("description").textContent = o.description;
  $("amount").textContent = `${o.amountDisplay} ${o.token}`;
  $("expires").textContent = new Date(Number(o.expiresAt) * 1000).toLocaleString();
  const labels: Record<string, string> = {
    open: "Waiting for payment", paid: "Paid", review: "Payment received, under review", refunded: "Refunded", cancelled: "Cancelled",
  };
  $("state").textContent = labels[o.status] ?? o.status;
  show("pay", Boolean(o.pay));
  if (!o.pay && o.status === "open") $("state").textContent = "Expired: create a new order in the app";
}

/** The wallet that pays: any wallet works, since the payment is matched to the order by its reference, not by who pays. */
const session = walletSession();

async function pay(o: OrderView): Promise<void> {
  const p = o.pay!;
  // BNB Smart Chain, or the build's own BNB Smart Chain (its testnet on a testnet build).
  const chain = Number(p.chainId) === bsc.id ? bsc : Number(p.chainId) === L1_CHAIN.id ? L1_CHAIN : null;
  if (!chain) throw new Error(`Unsupported payment chain ${p.chainId}.`);
  // The wallet dialog: installed wallets, or on a phone without one, links that open this order in a wallet app.
  const account = await session.connect();
  const eth = session.provider() as EIP1193Provider | null;
  if (!eth) throw new Error("No account selected in the wallet.");
  const hexId = `0x${chain.id.toString(16)}` as Hex;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hexId, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [...chain.rpcUrls.default.http],
        blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : [] }],
    });
  }
  const wallet = createWalletClient({ account, chain, transport: custom(eth) });
  const pub = createPublicClient({ chain, transport: custom(eth) });
  const amount = BigInt(o.amount);
  const ref = p.args[0] as Hex;

  let hash: Hex;
  if (p.approve) {
    const token = p.approve.token;
    const balance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
    if (balance < amount) throw new Error(`Not enough ${o.token}: this wallet holds less than ${o.amountDisplay}.`);
    const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, p.router] });
    if (allowance < amount) {
      setStatus(`Step 1 of 2: approve ${o.amountDisplay} ${o.token} in your wallet`);
      const approval = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [p.router, amount] });
      setStatus("Waiting for the approval to confirm…");
      const r = await pub.waitForTransactionReceipt({ hash: approval });
      if (r.status !== "success") throw new Error("The approval failed on chain.");
    }
    setStatus(`Step 2 of 2: confirm the payment of ${o.amountDisplay} ${o.token}`);
    hash = await wallet.writeContract({ address: p.router, abi: paymentRouterAbi, functionName: "payToken", args: [ref, token, amount] });
  } else {
    const balance = await pub.getBalance({ address: account });
    if (balance < amount) throw new Error(`Not enough BNB: this wallet holds less than ${o.amountDisplay} BNB plus gas.`);
    setStatus(`Confirm the payment of ${o.amountDisplay} BNB in your wallet`);
    hash = await wallet.writeContract({ address: p.router, abi: paymentRouterAbi, functionName: "payNative", args: [ref], value: amount });
  }
  const link = $("tx") as HTMLAnchorElement;
  link.href = explorerTxUrl(chain.id, hash);
  link.textContent = "View the payment on BscScan";
  show("tx", true);
  setStatus("Waiting for the payment to confirm…");
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The payment failed on chain. Nothing was charged except gas.");

  // The API activates the order once BSC finalizes the block, usually within a minute.
  setStatus("Paid. Waiting for BNB Smart Chain to finalize the payment…");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const now = await getOrder(o.orderId).catch(() => null);
    if (now && now.status !== "open") {
      render(now);
      setStatus(now.status === "paid" ? "Done. Your order is active; you can return to the app." : "Payment received. It needs a review by LONGYU.");
      return;
    }
  }
  setStatus("Paid on chain. LONGYU will activate the order shortly; you can return to the app.");
}

async function main(): Promise<void> {
  const orderId = parseOrderId(location.search);
  if (!orderId) throw new Error("This link has no valid order. Open it again from the LONGYU app.");
  let order = await getOrder(orderId);
  render(order);
  ($("pay") as HTMLButtonElement).onclick = async () => {
    $("error").textContent = "";
    ($("pay") as HTMLButtonElement).disabled = true;
    try {
      order = await getOrder(orderId);
      render(order);
      if (!order.pay) return;
      await pay(order);
    } catch (e) {
      if (!closedByVisitor(e)) setError(e);
      setStatus("");
    } finally {
      ($("pay") as HTMLButtonElement).disabled = false;
    }
  };
}

main().catch(setError);
