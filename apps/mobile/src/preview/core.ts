/**
 * Design preview only (see metro.config.js): stands in for the web device layer, with sample
 * data instead of the API, secure storage and device checks. Pick a state with ?s=:
 *   mining (default): a session running, a boost active and one queued
 *   ready:   a session can start, no boost
 *   resting: between sessions
 *   new:     an account made today, with identity checks open
 *   posted:  nothing to claim, yesterday's rewards in a settlement that opens later today
 *   unsettled: nothing to claim, the running day's rewards due after its settlement
 */
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { WalletOwner } from "../lib/wallet-key";
import type { XProof } from "../lib/x-auth";

export const config = { apiUrl: "preview", turnstileSiteKey: "", devAttestation: true };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
  }
}

type Scenario = "mining" | "ready" | "resting" | "new" | "posted" | "unsettled";
const scenario = (): Scenario => {
  const s = new URLSearchParams(globalThis.location?.search ?? "").get("s");
  return s === "ready" || s === "resting" || s === "new" || s === "posted" || s === "unsettled" ? s : "mining";
};

const E18 = 10n ** 18n;
const now = () => Math.floor(Date.now() / 1000);
const wei = (whole: number) => (BigInt(Math.round(whole * 10_000)) * E18 / 10_000n).toString();
// A throwaway key that exists only in the preview; it never signs anything.
const account = privateKeyToAccount(`0x${"5a".repeat(32)}`);

const startedAt = (s: Scenario) =>
  s === "mining" || s === "unsettled" ? now() - 6 * 3600 - 18 * 60 : s === "resting" || s === "posted" ? now() - 20 * 3600 : null;

/** The account's balances, as both the mining status and the rewards answer carry them. */
function balances(s: Scenario) {
  const started = startedAt(s);
  const fresh = s === "new";
  // Nothing to claim: what the other states show as claimable is already claimed here.
  const waiting = s === "posted" || s === "unsettled";
  return {
    earned: wei(fresh ? 0 : 1286.4521), claimed: wei(fresh ? 0 : waiting ? 1241.5081 : 1198.73), claimable: wei(fresh || waiting ? 0 : 42.7781), pending: wei(fresh ? 0 : 44.944),
    entitled: wei(fresh ? 0 : 1286.4521),
    accrual: started === null ? null : { perHour: wei(s === "mining" ? 1.7825 : 1.1883), until: String(started + 86_400) },
    unlock: s === "posted" ? { at: String(now() + 2 * 3600 + 31 * 60), exact: true } : s === "unsettled" ? { at: String(now() + 26 * 3600), exact: false } : null,
    at: String(now()),
  };
}

function fixture(method: string, path: string): unknown {
  const s = scenario();
  const day = 142;
  if (path === "/v1/me") {
    return {
      id: "preview", xUsername: "meilin_x", avatarUrl: null, handle: "meilin", tier: s === "new" ? 1 : 2,
      referralCode: "LY7K2Q", banned: false, createdAt: String(now() - (s === "new" ? 0 : 143 * 86_400)),
      miningDays: s === "new" ? "0" : "118", invites: s === "new" ? "0" : "7",
      wallet: account.address, deviceAttested: true,
    };
  }
  if (path === "/v1/network") {
    return {
      chainId: "668801", chainName: "LONGYU Testnet", explorerUrl: "https://scan-testnet.longyu.network",
      nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: 18 },
      rewardToken: { address: "0x00000000000000000000000000000000000071c0", name: "LONGYU Testnet Token", symbol: "tLONG", decimals: 18 },
      verificationOpen: s === "new",
    };
  }
  if (path === "/v1/mining/status") {
    const started = startedAt(s);
    return {
      day, tier: s === "new" ? 1 : 2, streakDays: s === "new" ? 0 : 23, graceDays: s === "new" ? 0 : 2,
      session: started === null ? null : { startedAt: String(started), endsAt: String(started + 86_400), creditedDay: String(day) },
      canStart: s === "ready" || s === "new",
      nextAllowedAt: s === "resting" ? String(now() + 4 * 3600 + 12 * 60) : null,
      estimatedPerHour: wei(s === "mining" ? 1.7825 : 1.1883),
      boostBps: s === "mining" ? 5000 : 0,
      invites: s === "new" ? { active: 0, bps: 0, bpsEach: 500, capBps: 2500 } : { active: 3, bps: 1500, bpsEach: 500, capBps: 2500 },
      balances: balances(s),
    };
  }
  if (path === "/v1/boosts") {
    const boosted = s === "mining";
    return {
      available: true, eligible: s !== "new", reason: s === "new" ? "verify_first" : null, today: String(day),
      plans: [
        { id: "c1-7", boostBps: 1000, days: 7, token: "BNB", price: "0.0014" },
        { id: "c1-30", boostBps: 1000, days: 30, token: "BNB", price: "0.0054" },
        { id: "c1-90", boostBps: 1000, days: 90, token: "BNB", price: "0.0144" },
        { id: "c2-7", boostBps: 2500, days: 7, token: "BNB", price: "0.0028" },
        { id: "c2-30", boostBps: 2500, days: 30, token: "BNB", price: "0.0108" },
        { id: "c2-90", boostBps: 2500, days: 90, token: "BNB", price: "0.0288" },
        { id: "c3-7", boostBps: 5000, days: 7, token: "BNB", price: "0.0049" },
        { id: "c3-30", boostBps: 5000, days: 30, token: "BNB", price: "0.0189" },
        { id: "c3-90", boostBps: 5000, days: 90, token: "BNB", price: "0.0504" },
        { id: "c4-7", boostBps: 7500, days: 7, token: "BNB", price: "0.007" },
        { id: "c4-30", boostBps: 7500, days: 30, token: "BNB", price: "0.027" },
        { id: "c4-90", boostBps: 7500, days: 90, token: "BNB", price: "0.072" },
        { id: "c5-7", boostBps: 10000, days: 7, token: "BNB", price: "0.0091" },
        { id: "c5-30", boostBps: 10000, days: 30, token: "BNB", price: "0.0351" },
        { id: "c5-90", boostBps: 10000, days: 90, token: "BNB", price: "0.0936" },
      ],
      current: boosted ? { boost_bps: 5000, start_day: String(day - 12), end_day: String(day + 18) } : null,
      upcoming: boosted ? [{ boost_bps: 2500, start_day: String(day + 18), end_day: String(day + 48) }] : [],
      orders: boosted
        ? [{ orderId: `0x${"ab".repeat(32)}`, plan: "c5-30", boostBps: 10000, days: 30, token: "BNB", amount: wei(0.0351), amountDisplay: "0.0351", status: "open", expiresAt: String(now() + 20 * 3600), payUrl: "https://testnet.longyu.network/pay.html?order=0x", pay: null }]
        : [],
    };
  }
  if (path === "/v1/rewards") {
    const fresh = s === "new";
    return {
      address: account.address, activeRootDay: String(day - 1),
      ...balances(s),
      claims: fresh ? [] : [
        { id: "c3", status: "confirmed", cumulative: wei(1198.73), tx_hash: `0x${"7e".repeat(32)}`, created_at: String(now() - 86_400) },
        { id: "c2", status: "confirmed", cumulative: wei(1154.2), tx_hash: `0x${"3c".repeat(32)}`, created_at: String(now() - 3 * 86_400) },
        { id: "c1", status: "confirmed", cumulative: wei(1009.5), tx_hash: `0x${"9d".repeat(32)}`, created_at: String(now() - 7 * 86_400) },
      ],
    };
  }
  if (path === "/v1/stats") return { day: String(day), miners: "61907", verifiedMiners: "48213", totalClaimed: wei(318_442_915), latestSettlement: { day: String(day - 1) } };
  if (path === "/v1/leaderboard") {
    const names = ["dragonfly", "jadewave", "meilin", "orbit88", "qingshan", "nova_k", "lumen", "tidecaller", "zhaoyun", "starling"];
    return { entries: names.map((handle, i) => ({ rank: i + 1, handle, streakDays: 142 - i * 9, miningDays30: String(30 - Math.min(i, 6)) })) };
  }
  if (path === "/v1/mining/challenge") return { challengeId: "preview", nonce: "00", pulseRequired: false };
  if (path === "/v1/boosts/orders") return { orderId: `0x${"cd".repeat(32)}`, payUrl: "https://testnet.longyu.network/pay.html?order=0x" };
  if (method === "POST") return {};
  throw new ApiError(404, "not_found", `no preview data for ${path}`);
}

export async function api<T = Record<string, unknown>>(method: "GET" | "POST", path: string): Promise<T> {
  await new Promise((r) => setTimeout(r, 120));
  return fixture(method, path) as T;
}

const kept = new Map<string, string>();
export const remember = async (name: string, value: string | null) => void (value === null ? kept.delete(name) : kept.set(name, value));
export const recall = async (name: string): Promise<string | null> => kept.get(name) ?? null;

export const installId = async () => "preview";
export const loadTokens = async () => true;
export const saveTokens = async () => undefined;
export const setSignedOutHandler = (_fn: () => void) => undefined;
export const loadWallet = async (_owner: WalletOwner): Promise<PrivateKeyAccount | null> => account;
export const createWallet = async (_owner: WalletOwner): Promise<PrivateKeyAccount> => account;
export const importWallet = async (_owner: WalletOwner, _key: string): Promise<PrivateKeyAccount> => account;
export const exportWalletKey = async (_owner: WalletOwner): Promise<string | null> => `0x${"5a".repeat(32)}`;
export const signInWithX = async (_purpose: "sign-in" | "wallet-change"): Promise<XProof | null> => ({ ticket: "preview", appVerifier: "preview" });
export const signIn = async (_referralCode?: string) => true;
export const signInFailure = (): { code: string; status?: number } | null => null;
export const walletChangeReturned = () => false;
export const linkWallet = async (_a: PrivateKeyAccount, _reauth?: { reauthTicket: string; appVerifier: string }) => undefined;
export const devicePlatform = () => "android" as const;
export const attestDevice = async () => undefined;
export const proveSession = async (_nonce: string) => "dev:preview";
export const signOut = async () => undefined;
