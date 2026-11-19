/** Pure helpers every page with a wallet shares (tested under Node, in bridge-core.test.ts). */

export const CANCELLED = "Cancelled in your wallet.";

type ErrorLike = { code?: unknown; name?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown; data?: unknown };

/** A short message for the page. Rejections in the wallet always read the same. */
export function errorMessage(e: unknown): string {
  let cur = e as ErrorLike | undefined;
  for (let i = 0; i < 8 && cur && typeof cur === "object"; i++) {
    if (cur.code === 4001 || cur.name === "UserRejectedRequestError") return CANCELLED;
    if (cur.name === "WaitForTransactionReceiptTimeoutError") return "Still pending. Check the transaction link.";
    cur = cur.cause as ErrorLike | undefined;
  }
  const err = e as ErrorLike | null;
  const m = String((err && typeof err === "object" && (err.shortMessage || err.message)) || e);
  if (/user rejected|user denied|rejected the request|denied transaction|user cancel/i.test(m)) return CANCELLED;
  if (/insufficient funds/i.test(m)) return "Not enough tBNB for gas.";
  return m.length > 200 ? `${m.slice(0, 199)}…` : m;
}

/** True when the wallet does not know the chain yet (EIP-3326 error 4902, also nested by some mobile wallets). */
export function isUnknownChain(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown; data?: { originalError?: { code?: unknown } } } | null;
  if (!err || typeof err !== "object") return false;
  return err.code === 4902 || err.data?.originalError?.code === 4902 || /unrecognized chain id/i.test(String(err.message ?? ""));
}
