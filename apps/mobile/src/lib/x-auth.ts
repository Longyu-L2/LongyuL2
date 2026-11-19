/**
 * The parts of sign-in with X that need no device: the link the sign-in page comes back on, reading
 * it, and the encodings of the app's one-time secret. No native imports, so the unit tests run it.
 */

/** Where the API sends the browser once X is done (its APP_AUTH_REDIRECT setting). */
export const AUTH_REDIRECT = "longyumine://auth";

/** What a completed visit to X leaves the app with: the API's one-time ticket and the secret that redeems it. */
export interface XProof {
  ticket: string;
  appVerifier: string;
}

/**
 * Why a sign-in came back without a ticket: the person refused at X (denied), X did not confirm the
 * account (failed), this X account signed in a moment ago (too_soon), the day's ceiling on sign-ins
 * is reached (paused), or this network reached its own ceiling for the day (too_many).
 */
const RETURN_ERRORS = ["denied", "failed", "too_soon", "paused", "too_many"] as const;
export type ReturnError = (typeof RETURN_ERRORS)[number];

export type AuthReturn = { ticket: string } | { error: ReturnError };

/** Exactly `ticket=<43 characters>` or `error=<one of the API's codes>`; anything else counts as failed. */
function readResult(result: string): AuthReturn {
  const ticket = /^ticket=([A-Za-z0-9_-]{43})$/.exec(result)?.[1];
  if (ticket) return { ticket };
  const error = RETURN_ERRORS.find((e) => result === `error=${e}`);
  return { error: error ?? "failed" };
}

/** Reads the link the sign-in page came back on: the API sends the result after the `?`. */
export function readAuthReturn(url: string): AuthReturn {
  return readResult(url.startsWith(`${AUTH_REDIRECT}?`) ? url.slice(AUTH_REDIRECT.length + 1) : "");
}

/**
 * The web app's side of the same return. The API sends the browser to the web app's own address
 * with the result after a `#`; a browser sends that part to no server. Null when the address
 * carries no sign-in return at all.
 */
export function readWebReturn(hash: string): AuthReturn | null {
  return /^#(ticket|error)=/.test(hash) ? readResult(hash.slice(1)) : null;
}

/** The app's error code for a sign-in that came back without a ticket (see errors.ts). */
export const returnErrorCode = (error: ReturnError): string => `x_${error}`;

/**
 * True for a browser built into another app (X, Telegram, Instagram and the like). Such a browser
 * can hand the visit to X to a different one, which then comes back without this one's secret, and
 * the app around it may clear what the site saved, a wallet key included.
 */
export function embeddedBrowser(userAgent: string): boolean {
  if (/Twitter|FBAN|FBAV|FB_IAB|Instagram|Telegram|MicroMessenger|Line\/|TikTok|musical_ly|Snapchat|LinkedInApp/.test(userAgent)) return true;
  // Android's web view names itself.
  if (/; wv\)/.test(userAgent)) return true;
  // On an iPhone or iPad, Safari and the browsers built on it carry "Safari/"; a web view inside an app does not.
  return /iPhone|iPad|iPod/.test(userAgent) && /AppleWebKit/.test(userAgent) && !/Safari\//.test(userAgent);
}

/** True for the sign-in return link, as a full link or as the path the router makes of it. */
export function isAuthReturn(link: string): boolean {
  const path = link.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\/+/, "");
  return /^auth(?:[/?#]|$)/.test(path);
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Padded base64 to base64url without padding, the form the API compares the secret's hash in. */
export const toBase64Url = (base64: string): string => base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
