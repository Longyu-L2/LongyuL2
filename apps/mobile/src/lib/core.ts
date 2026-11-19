/**
 * Device-side essentials: configuration, secure storage, the API client, the self-custody wallet
 * and device integrity. Keys never leave the phone; the backend only ever sees signatures.
 */
import { Linking, Platform } from "react-native";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import * as AppIntegrity from "@expo/app-integrity";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { request } from "./request";
import { checkKey, exportableKey, storedKey, walletKeyName, type KeyStore, type WalletOwner } from "./wallet-key";
import { AUTH_REDIRECT, hex, readAuthReturn, returnErrorCode, toBase64Url, type XProof } from "./x-auth";

// viem needs crypto.getRandomValues for key generation.
const g = globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
if (!g.crypto?.getRandomValues) {
  g.crypto = { ...(g.crypto ?? {}), getRandomValues: (a: Uint8Array) => Crypto.getRandomValues(a) };
}

// ------------------------------------------------------------------- config

export const config = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080",
  /** Cloudflare Turnstile site key for the human check. Empty means development ("dev-pass"). */
  turnstileSiteKey: process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY ?? "",
  /** Development builds talk to a backend that accepts "dev:<nonce>" attestation tokens. */
  devAttestation: process.env.EXPO_PUBLIC_DEV_ATTESTATION === "true",
};

// ------------------------------------------------------------------ storage

const KEYS = {
  tokens: "longyu.tokens",
  wallet: "longyu.wallet.privateKey",
  installId: "longyu.installId",
  attestKeyId: "longyu.appAttestKeyId",
} as const;

const secure = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function installId(): Promise<string> {
  let id = await SecureStore.getItemAsync(KEYS.installId);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(KEYS.installId, id, secure);
  }
  return id;
}

const kept = (name: string) => `longyu.cache.${name.replace(/[^A-Za-z0-9._-]/g, "_")}`;

/**
 * Keeps a small value between launches (the account as last shown, a box the person ticked), so
 * the app opens with it; null forgets it. Never a secret, and nothing depends on it being kept.
 */
export async function remember(name: string, value: string | null): Promise<void> {
  try {
    if (value === null) await SecureStore.deleteItemAsync(kept(name));
    else await SecureStore.setItemAsync(kept(name), value, secure);
  } catch {
    // Not kept: the app asks the API instead.
  }
}

export async function recall(name: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(kept(name));
  } catch {
    return null;
  }
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
let onSignedOut: (() => void) | null = null;

/** A session that cannot be read (storage fails, or holds something else) counts as signed out. */
export async function loadTokens(): Promise<boolean> {
  tokens = null;
  try {
    const v = JSON.parse((await SecureStore.getItemAsync(KEYS.tokens)) ?? "null") as Partial<Tokens> | null;
    if (typeof v?.accessToken === "string" && typeof v.refreshToken === "string") tokens = { accessToken: v.accessToken, refreshToken: v.refreshToken };
  } catch {
    // Signed out.
  }
  return tokens !== null;
}

export async function saveTokens(t: Tokens | null): Promise<void> {
  tokens = t;
  if (t) await SecureStore.setItemAsync(KEYS.tokens, JSON.stringify(t), secure);
  else await SecureStore.deleteItemAsync(KEYS.tokens);
}

export function setSignedOutHandler(fn: () => void): void {
  onSignedOut = fn;
}

/** A request the API did not answer in time. Screens show it as any other failed try. */
const timedOut = () => new ApiError(0, "timeout");

let refreshing: Promise<boolean> | null = null;

/** Single-flight: parallel 401s share one refresh, so a refresh token is never spent twice. */
function refresh(): Promise<boolean> {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function doRefresh(): Promise<boolean> {
  if (!tokens) return false;
  const res = await request(`${config.apiUrl}/v1/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: tokens.refreshToken }),
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
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (tokens) headers.authorization = `Bearer ${tokens.accessToken}`;
  const res = await request(`${config.apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, timedOut);
  if (res.status === 401 && retry && tokens && (await refresh())) return api<T>(method, path, body, false);
  const json = (res.json ?? {}) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? "error", json.message);
  return json as T;
}

// ----------------------------------------------------------------- sign-in

/** Android reports the browser closing and the return link separately; the link may trail by this long. */
const RETURN_GRACE_MS = 600;

let signingIn = false;

/**
 * Opens X's sign-in page and waits for the API to send the browser back to the app. Returns null
 * when the person closes the page instead (or a sign-in is already open). The secret is made here
 * and kept in memory: the API gets only its hash until the ticket is redeemed, so the ticket is of
 * no use to anything else that sees the return link.
 */
export async function signInWithX(purpose: "sign-in" | "wallet-change"): Promise<XProof | null> {
  if (signingIn) return null;
  signingIn = true;
  const got: { url: string | null } = { url: null };
  // On Android the return link also arrives as an ordinary link event, sometimes after the browser reports closing.
  const links = Linking.addEventListener("url", ({ url }) => {
    if (url.startsWith(AUTH_REDIRECT)) got.url = url;
  });
  try {
    const appVerifier = hex(Crypto.getRandomValues(new Uint8Array(32)));
    const appChallenge = toBase64Url(
      await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, appVerifier, { encoding: Crypto.CryptoEncoding.BASE64 }),
    );
    const { authorizeUrl } = await api<{ authorizeUrl: string }>("POST", "/v1/auth/x/start", { appChallenge, purpose });
    if (typeof authorizeUrl !== "string" || !/^https?:\/\//.test(authorizeUrl)) throw new ApiError(0, "x_failed");
    // A wallet change does not reuse the browser's X session where the system can prevent it (iOS).
    const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, AUTH_REDIRECT, { preferEphemeralSession: purpose === "wallet-change" });
    if (result.type === "success") got.url = result.url;
    else if (Platform.OS === "android" && got.url === null) await new Promise((r) => setTimeout(r, RETURN_GRACE_MS));
    if (got.url === null) return null;
    const back = readAuthReturn(got.url);
    if ("error" in back) throw new ApiError(0, returnErrorCode(back.error));
    return { ticket: back.ticket, appVerifier };
  } finally {
    links.remove();
    signingIn = false;
  }
}

/** Signs in with X and opens a session on this device. False when the person closed the sign-in page. */
export async function signIn(referralCode?: string): Promise<boolean> {
  const proof = await signInWithX("sign-in");
  if (!proof) return false;
  const r = await api<Tokens>("POST", "/v1/auth/x/finish", { ...proof, installId: await installId(), platform: platform(), referralCode });
  await saveTokens({ accessToken: r.accessToken, refreshToken: r.refreshToken });
  return true;
}

/** For the web build, whose page reloads on the way back from X and reports a failed sign-in here. The app hears it from `signIn`. */
export function signInFailure(): { code: string; status?: number } | null {
  return null;
}

/** For the web build, which comes back from the X sign-in of a wallet change as a fresh page. The app waits inside `signInWithX`. */
export function walletChangeReturned(): boolean {
  return false;
}

// ------------------------------------------------------------------ wallet

/** The phone's secure storage, where each account's key is kept under its own name. */
const keys: KeyStore = {
  get: (name) => SecureStore.getItemAsync(name),
  set: (name, value) => SecureStore.setItemAsync(name, value, secure),
  remove: (name) => SecureStore.deleteItemAsync(name),
};

export async function loadWallet(owner: WalletOwner): Promise<PrivateKeyAccount | null> {
  const key = await storedKey(keys, KEYS.wallet, owner);
  return key ? privateKeyToAccount(key) : null;
}

export async function createWallet(owner: WalletOwner): Promise<PrivateKeyAccount> {
  const key = generatePrivateKey();
  await keys.set(walletKeyName(KEYS.wallet, owner), key);
  return privateKeyToAccount(key);
}

/** Keeps a typed key for the account. A key of some other wallet than the account's is refused, and nothing is stored. */
export async function importWallet(owner: WalletOwner, key: string): Promise<PrivateKeyAccount> {
  const checked = checkKey(owner, key);
  if ("error" in checked) throw new ApiError(400, checked.error);
  await keys.set(walletKeyName(KEYS.wallet, owner), checked.key);
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

const platform = (): "ios" | "android" => (Platform.OS === "ios" ? "ios" : "android");
export const devicePlatform: () => "ios" | "android" | "web" = platform;

/**
 * Android: a fresh key in the device's secure hardware, with the server's nonce as its attestation
 * challenge. Its certificate chain (leaf first) proves the device, the app and the nonce, and works
 * for an APK installed outside Google Play. Format: "akey:" + base64 certificates joined by ".".
 */
async function androidToken(nonce: string): Promise<string> {
  const alias = "longyu.attestation";
  try {
    await AppIntegrity.generateHardwareAttestedKeyAsync(alias, nonce);
    const chain = await AppIntegrity.getAttestationCertificateChainAsync(alias);
    if (chain.length < 2) throw new Error("no attestation chain");
    return `akey:${chain.join(".")}`;
  } catch {
    throw new ApiError(400, "attest_unsupported");
  }
}

/** One-time device registration (App Attest key attestation, or Android key attestation). */
export async function attestDevice(): Promise<void> {
  const c = await api<{ challengeId: string; nonce: string }>("POST", "/v1/device/challenge");
  let token: string;
  let keyId: string | undefined;
  if (config.devAttestation) {
    token = `dev:${c.nonce}`;
  } else if (platform() === "android") {
    token = await androidToken(c.nonce);
  } else {
    if (!AppIntegrity.isSupported) throw new ApiError(400, "attest_unsupported");
    // Apple attests a key only once, so every (re-)attestation uses a fresh key.
    keyId = await AppIntegrity.generateKeyAsync();
    token = await AppIntegrity.attestKeyAsync(keyId, c.nonce);
    await SecureStore.setItemAsync(KEYS.attestKeyId, keyId, secure);
  }
  const r = await api<{ attested: boolean }>("POST", "/v1/device/attest", { challengeId: c.challengeId, token, keyId });
  if (!r.attested) throw new ApiError(403, "attest_failed");
}

/** Per-session proof that the request comes from this genuine app on this device. (The web build has none to give.) */
export async function proveSession(nonce: string): Promise<string | undefined> {
  if (config.devAttestation) return `dev:${nonce}`;
  if (platform() === "android") return androidToken(nonce);
  const keyId = await SecureStore.getItemAsync(KEYS.attestKeyId);
  if (!keyId) throw new ApiError(400, "device_not_attested");
  return AppIntegrity.generateAssertionAsync(keyId, nonce);
}

export async function signOut(): Promise<void> {
  if (tokens) await api("POST", "/v1/auth/logout", { refreshToken: tokens.refreshToken }).catch(() => undefined);
  await saveTokens(null);
}
