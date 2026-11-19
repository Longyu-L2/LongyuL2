/** Pure helpers for the pay page, kept apart from the DOM so they can be tested. */

export interface OrderView {
  orderId: string;
  product: string;
  description: string;
  status: string;
  token: string;
  amount: string;
  amountDisplay: string;
  expiresAt: string;
  paidAt: string | null;
  pay: {
    chainId: string;
    router: `0x${string}`;
    call: string;
    args: unknown[];
    value: string;
    approve?: { token: `0x${string}`; spender: `0x${string}`; amount: string };
  } | null;
}

/** The order ID from "?order=0x…", or null when missing or malformed. */
export function parseOrderId(search: string): string | null {
  const id = new URLSearchParams(search).get("order");
  return id && /^0x[0-9a-fA-F]{64}$/.test(id) ? id.toLowerCase() : null;
}

export function explorerTxUrl(chainId: number, hash: string): string {
  return `${chainId === 97 ? "https://testnet.bscscan.com" : "https://bscscan.com"}/tx/${hash}`;
}
