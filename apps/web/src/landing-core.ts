/** Pure helpers for the landing page (tested under Node). */

export interface LandingConfig {
  rpcUrl: string;
  chainId: string;
  chainName: string;
  explorerUrl: string;
  symbol: string;
}

function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const url = new URL(v);
    const local = url.protocol === "http:" && url.hostname === "localhost";
    return (url.protocol === "https:" || local) && !url.username && !url.password ? v : null;
  } catch {
    return null;
  }
}

/** The settings the build wrote into the page, or null when one of them is not what the page can use. */
export function parseLandingConfig(raw: unknown): LandingConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const rpcUrl = httpsUrl(r.rpcUrl);
  const explorerUrl = httpsUrl(r.explorerUrl);
  const chainId = typeof r.chainId === "string" && /^[1-9][0-9]{0,15}$/.test(r.chainId) ? r.chainId : null;
  const chainName = typeof r.chainName === "string" && r.chainName.trim() ? r.chainName.trim() : null;
  const symbol = typeof r.symbol === "string" && /^[A-Za-z]{2,8}$/.test(r.symbol) ? r.symbol : null;
  if (!rpcUrl || !explorerUrl || !chainId || !chainName || !symbol) return null;
  return { rpcUrl, chainId, chainName, explorerUrl, symbol };
}

/** EIP-3085 parameters: the wallet adds the network, or switches to it when it already has it. */
export function walletChain(c: LandingConfig) {
  return {
    chainId: `0x${BigInt(c.chainId).toString(16)}`,
    chainName: c.chainName,
    nativeCurrency: { name: "BNB", symbol: c.symbol, decimals: 18 },
    rpcUrls: [c.rpcUrl],
    blockExplorerUrls: [c.explorerUrl],
  };
}

/** The block height in a node's answer to eth_blockNumber, or null when the answer is not one. */
export function blockNumberOf(answer: unknown): number | null {
  if (typeof answer !== "object" || answer === null) return null;
  const result = (answer as { result?: unknown }).result;
  if (typeof result !== "string" || !/^0x(0|[1-9a-f][0-9a-f]{0,12})$/i.test(result)) return null;
  return Number.parseInt(result, 16);
}

/** 12345678 as 12,345,678. */
export function formatCount(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) return "–";
  return String(n).replace(/\B(?=(\d{3})+$)/g, ",");
}

/**
 * The height to show a moment after `shown`, on the way to `latest`: the counter runs through the
 * blocks it missed between two reads and never shows one the node has not reported.
 */
export function nextShown(shown: number, latest: number): number {
  if (latest <= shown) return latest;
  return shown + Math.max(1, Math.ceil((latest - shown) / 6));
}
