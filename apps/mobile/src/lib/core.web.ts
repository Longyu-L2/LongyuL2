/**
 * The browser's device layer: what core.ts is on a phone, with the same exports. Metro picks this
 * file for the web build. A browser has no secure hardware, so the session and the wallet key live
 * in this site's own storage (never on a server), and the device check is a human check, which the
 * API asks for again before every session.
 */
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { openHumanCheck } from "./human-check-dom";
import { pickLanguage, translator } from "./i18n";
import { request } from "./request";
import { checkKey, exportableKey, storedKey, walletKeyName, type KeyStore, type WalletOwner } from "./wallet-key";
import { hex, readWebReturn, toBase64Url, type AuthReturn, type XProof } from "./x-auth";

// ------------------------------------------------------------------- config

export const config = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080",
  /** Cloudflare Turnstile site key for the human check. Empty means development ("dev-pass"). */
  turnstileSiteKey: process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY ?? "",
  /** Phones only: a browser has no device attestation to stand in for. */
  devAttestation: false,
};

const browser = typeof window !== "undefined";
// This file's own messages (the screens translate theirs through the app state).
const t = translator(pickLanguage(browser ? navigator.languages ?? [navigator.language] : []));

// ------------------------------------------------------------------ storage

const KEYS = {
  tokens: "longyu.tokens",
  wallet: "longyu.wallet.privateKey",
  installId: "longyu.installId",
  signIn: "longyu.signIn",
} as const;

/** Reads this site's storage. Null when the browser refuses (private windows, blocked site data). */
function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Writes (or with null, removes) a value. False when the browser did not keep it. */
function store(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return window.localStorage.getItem(key) === value;
  } catch {
    return false;
  }
}

const storageBlocked = () => new ApiError(400, "storage_unavailable");

const kept = (name: string) => `longyu.cache.${name.replace(/[^A-Za-z0-9._-]/g, "_")}`;

/**
 * Keeps a small value between visits (the account as last shown, a box the person ticked), so
 * the app opens with it; null forgets it. Never a secret, and nothing depends on it being kept.
 */
export async function remember(name: string, value: string | null): Promise<void> {
  store(kept(name), value);
}

export async function recall(name: string): Promise<string | null> {
  return stored(kept(name));
}

let memoryInstallId: string | null = null;

export async function installId(): Promise<string> {
  let id = stored(KEYS.installId) ?? memoryInstallId;
  if (!id) {
    id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : hex(crypto.getRandomValues(new Uint8Array(16)));
    store(KEYS.installId, id);
  }
  memoryInstallId = id;
  return id;
}

// --------------------------------------------------------------------- API

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

let tokens: Tokens | null = null;
/** False while the browser would not keep the session, which then lasts as long as this tab. */
let persisted = true;
let onSignedOut: (() => void) | null = null;

function readTokens(): Tokens | null {
  const raw = stored(KEYS.tokens);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Tokens>;
    return typeof v.accessToken === "string" && typeof v.refreshToken === "string" ? { accessToken: v.accessToken, refreshToken: v.refreshToken } : null;
  } catch {
    return null;
  }
}

/** The session as it is now. Tabs of one browser share it, so another tab may have renewed or ended it. */
function current(): Tokens | null {
  if (persisted) tokens = readTokens();
  return tokens;
}

export async function loadTokens(): Promise<boolean> {
  tokens = readTokens();
  persisted = true;
  await resumeOnce();
  return current() !== null;
}

export async function saveTokens(next: Tokens | null): Promise<void> {
  tokens = next;
  persisted = store(KEYS.tokens, next ? JSON.stringify(next) : null);
}

export function setSignedOutHandler(fn: () => void): void {
  onSignedOut = fn;
}

if (browser) {
  // Signing out in one tab signs the others out.
  window.addEventListener("storage", (e) => {
    if (e.key === KEYS.tokens && e.newValue === null && persisted && tokens) {
      tokens = null;
      onSignedOut?.();
    }
  });
}

/** A request the API did not answer in time. Screens show it as any other failed try. */
const timedOut = () => new ApiError(0, "timeout");

let refreshing: Promise<boolean> | null = null;

/**
 * Single-flight, in this tab and across tabs: parallel 401s share one refresh, so a refresh token
 * is never spent twice. `used` is the session the refused request was sent with.
 */
function refresh(used: Tokens): Promise<boolean> {
  refreshing ??= acrossTabs(() => doRefresh(used)).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function acrossTabs<T>(fn: () => Promise<T>): Promise<T> {
  const locks = navigator.locks as LockManager | undefined;
  return locks ? (locks.request("longyu.refresh", fn) as Promise<T>) : fn();
}

async function doRefresh(used: Tokens): Promise<boolean> {
  const now = current();
  if (!now) {
    onSignedOut?.();
    return false;
  }
  // Another tab renewed the session while this one waited: use that.
  if (now.accessToken !== used.accessToken) return true;
  const res = await request(`${config.apiUrl}/v1/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: now.refreshToken }),
  }, timedOut);
  // Only a refusal ends the session. An API that is down, unreachable or too slow leaves it for the next try.
  if (res.status === 400 || res.status === 401) {
    await saveTokens(null);
    onSignedOut?.();
    return false;
  }
  if (!res.ok || !res.json) throw new ApiError(res.status, "refresh_failed");
  await saveTokens(res.json as Tokens);
  return true;
}

export async function api<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown, retry = true): Promise<T> {
  const used = current();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (used) headers.authorization = `Bearer ${used.accessToken}`;
  const res = await request(`${config.apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, timedOut);
  if (res.status === 401 && retry && used && (await refresh(used))) return api<T>(method, path, body, false);
  const json = (res.json ?? {}) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? "error", json.message);
  return json as T;
}

// ----------------------------------------------------------------- sign-in

type Purpose = "sign-in" | "wallet-change";

/** What this browser keeps while the person is away at X: the secret that redeems the ticket they come back with. */
interface Pending {
  purpose: Purpose;
  appVerifier: string;
  referralCode?: string;
  at: number;
}

const PENDING_MS = 10 * 60_000;

/**
 * The API sends the browser back to this site with the result after a `#`, which no server sees.
 * It is read here, as the page loads, and taken out of the address bar and the tab's history.
 */
const returned: AuthReturn | null = browser ? readWebReturn(window.location.hash) : null;
if (returned) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);

let leaving = false;
if (browser) {
  // Coming back from X with the browser's back button can restore this page as it was left, still
  // waiting for a sign-in that will not arrive. Start it afresh.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && leaving) window.location.reload();
  });
}

function takePending(): Pending | null {
  const raw = stored(KEYS.signIn);
  store(KEYS.signIn, null);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Pending>;
    if ((v.purpose !== "sign-in" && v.purpose !== "wallet-change") || typeof v.appVerifier !== "string" || typeof v.at !== "number") return null;
    if (Math.abs(Date.now() - v.at) > PENDING_MS) return null;
    return { purpose: v.purpose, appVerifier: v.appVerifier, referralCode: typeof v.referralCode === "string" ? v.referralCode : undefined, at: v.at };
  } catch {
    return null;
  }
}

let signInError: { code: string; status?: number } | null = null;
let walletChange: { proof: XProof } | { error: ApiError } | null = null;

/** Why the sign-in this page came back from did not open a session, once. Null when there is nothing to say. */
export function takeSignInError(): { code: string; status?: number } | null {
  const e = signInError;
  signInError = null;
  return e;
}

/** True when the page came back from the X sign-in that replacing a wallet asks for, until that result is used. */
export function walletChangeReturned(): boolean {
  return walletChange !== null;
}

let resumed: Promise<void> | null = null;

/** Finishes what the person left for X to do. Runs once, before the app decides whether it is signed in. */
function resumeOnce(): Promise<void> {
  resumed ??= returned ? resume(returned) : Promise.resolve();
  return resumed;
}

async function resume(back: AuthReturn): Promise<void> {
  const pending = takePending();
  const failed = "error" in back ? (back.error === "denied" ? "x_denied" : "x_failed") : null;
  if (!pending) {
    // Nothing here was waiting for this return: an old link, or one opened in a different browser.
    if (!tokens) signInError = { code: failed ?? "x_failed" };
    return;
  }
  if (pending.purpose === "wallet-change") {
    if (!tokens) return;
    walletChange = "ticket" in back ? { proof: { ticket: back.ticket, appVerifier: pending.appVerifier } } : { error: new ApiError(0, failed ?? "x_failed") };
    return;
  }
  if (!("ticket" in back)) {
    signInError = { code: failed ?? "x_failed" };
    return;
  }
  try {
    const r = await api<Tokens>("POST", "/v1/auth/x/finish", {
      ticket: back.ticket,
      appVerifier: pending.appVerifier,
      installId: await installId(),
      platform: "web",
      referralCode: pending.referralCode,
    });
    await saveTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken });
  } catch (e) {
    signInError = e instanceof ApiError ? { code: e.code, status: e.status } : { code: "x_failed" };
  }
}

const isWebAddress = (url: unknown): url is string => {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
};

/**
 * Sends this tab to X's sign-in page. The page comes back as a fresh load (see `returned`), so the
 * promise never resolves. The secret is made here and kept in this browser: the API gets only its
 * hash until the ticket is redeemed, so the ticket is of no use to anything else that sees it.
 */
async function leaveForX(purpose: Purpose, referralCode?: string): Promise<never> {
  const appVerifier = hex(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(appVerifier)));
  const appChallenge = toBase64Url(btoa(String.fromCharCode(...digest)));
  const pending: Pending = { purpose, appVerifier, referralCode, at: Date.now() };
  // Without storage the secret would be gone by the time the person is back.
  if (!store(KEYS.signIn, JSON.stringify(pending))) throw storageBlocked();
  try {
    const { authorizeUrl } = await api<{ authorizeUrl: string }>("POST", "/v1/auth/x/start", { appChallenge, purpose, client: "web" });
    if (!isWebAddress(authorizeUrl)) throw new ApiError(0, "x_failed");
    leaving = true;
    window.location.assign(authorizeUrl);
  } catch (e) {
    store(KEYS.signIn, null);
    throw e;
  }
  return new Promise<never>(() => undefined);
}

/**
 * The proof of a fresh sign-in with X. The first call leaves for X; once the page is back
 * (`walletChangeReturned`), the next call for a wallet change returns what it came back with.
 */
export async function signInWithX(purpose: Purpose): Promise<XProof | null> {
  if (purpose === "wallet-change" && walletChange) {
    const back = walletChange;
    walletChange = null;
    if ("error" in back) throw back.error;
    return back.proof;
  }
  return leaveForX(purpose);
}

/** Leaves for X; the session opens when the page loads again (`loadTokens`). */
export async function signIn(referralCode?: string): Promise<boolean> {
  return leaveForX("sign-in", referralCode);
}

// ------------------------------------------------------------------ wallet

/** This site's storage, where each account's key is kept under its own name. */
const keys: KeyStore = {
  get: async (name) => stored(name),
  // Fails when the browser did not keep the key: a wallet whose key was not saved must never be linked.
  set: async (name, value) => {
    if (!store(name, value)) throw storageBlocked();
  },
  remove: async (name) => void store(name, null),
};

async function keepKey(owner: WalletOwner, key: string): Promise<void> {
  await keys.set(walletKeyName(KEYS.wallet, owner), key);
  // Asks the browser not to clear this site's data on its own. It may refuse; the key is saved either way.
  void navigator.storage?.persist?.().catch(() => false);
}

export async function loadWallet(owner: WalletOwner): Promise<PrivateKeyAccount | null> {
  const key = await storedKey(keys, KEYS.wallet, owner);
  return key ? privateKeyToAccount(key) : null;
}

export async function createWallet(owner: WalletOwner): Promise<PrivateKeyAccount> {
  const key = generatePrivateKey();
  await keepKey(owner, key);
  return privateKeyToAccount(key);
}

/** Keeps a typed key for the account. A key of some other wallet than the account's is refused, and nothing is stored. */
export async function importWallet(owner: WalletOwner, key: string): Promise<PrivateKeyAccount> {
  const checked = checkKey(owner, key);
  if ("error" in checked) throw new ApiError(400, checked.error);
  await keepKey(owner, checked.key);
  return checked.account;
}

/** Shown only after the user confirms, and only as the account's wallet; the key is never sent anywhere. */
export async function exportWalletKey(owner: WalletOwner): Promise<string | null> {
  return exportableKey(keys, KEYS.wallet, owner);
}

/**
 * Proves wallet ownership to the backend with a Sign-In with Ethereum message. Replacing an
 * existing wallet also needs a fresh sign-in with X: the result of `signInWithX("wallet-change")`.
 */
export async function linkWallet(account: PrivateKeyAccount, reauth?: { reauthTicket: string; appVerifier: string }): Promise<void> {
  const c = await api<{ nonce: string; domain: string; chainId: number }>("POST", "/v1/wallet/challenge");
  const message = createSiweMessage({
    address: account.address,
    chainId: c.chainId,
    domain: c.domain,
    nonce: c.nonce,
    uri: `https://${c.domain}`,
    version: "1",
    issuedAt: new Date(),
    statement: "Link this wallet to my LONGYU MINE account.",
  });
  const signature = await account.signMessage({ message });
  await api("POST", "/v1/wallet/link", { message, signature, ...reauth });
}

// --------------------------------------------------------- device integrity

export const devicePlatform = (): "ios" | "android" | "web" => "web";

/** One pass of the human check, as the token the API verifies. */
async function humanToken(): Promise<string> {
  if (!config.turnstileSiteKey) return "dev-pass";
  const check = openHumanCheck(config.turnstileSiteKey, {
    title: t("humanCheck"),
    cancel: t("cancel"),
    note: t("turnstileNote"),
    failed: t("humanCheckFailed"),
  });
  try {
    return await check.token;
  } catch {
    throw new ApiError(0, "check_cancelled");
  }
}

/** Registers this browser: a human check stands in for the device proof a phone gives. */
export async function attestDevice(): Promise<void> {
  // The check first: the API's challenge is short-lived, and the person may take a while.
  const token = await humanToken();
  const c = await api<{ challengeId: string }>("POST", "/v1/device/challenge");
  const r = await api<{ attested: boolean }>("POST", "/v1/device/attest", { challengeId: c.challengeId, token });
  if (!r.attested) throw new ApiError(403, "check_cancelled");
}

/** A browser has no per-session device proof; the API asks it for the human check before every session instead. */
export async function proveSession(_nonce: string): Promise<string | undefined> {
  return undefined;
}

export async function signOut(): Promise<void> {
  const now = current();
  if (now) await api("POST", "/v1/auth/logout", { refreshToken: now.refreshToken }).catch(() => undefined);
  await saveTokens(null);
}

/** Screens are type-checked against core.ts; this fails the type check when the two stop matching. */
export type MatchesNative = typeof import("./core.web") extends typeof import("./core") ? true : never;
const matchesNative: MatchesNative = true;
void matchesNative;
