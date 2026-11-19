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

export type AuthReturn = { ticket: string } | { error: "denied" | "failed" };

/**
 * Reads the link the sign-in page came back on. The API sends exactly `?ticket=<43 characters>`,
 * `?error=denied` (the person refused at X) or `?error=failed`; anything else counts as failed.
 */
export function readAuthReturn(url: string): AuthReturn {
  const query = url.startsWith(`${AUTH_REDIRECT}?`) ? url.slice(AUTH_REDIRECT.length + 1) : "";
  const ticket = /^ticket=([A-Za-z0-9_-]{43})$/.exec(query)?.[1];
  if (ticket) return { ticket };
  return { error: query === "error=denied" ? "denied" : "failed" };
}

/**
 * The web app's side of the same return. The API sends the browser to the web app's own address
 * with `#ticket=<43 characters>`, `#error=denied` or `#error=failed` after it; a browser sends that
 * part to no server. Null when the address carries no sign-in return at all.
 */
export function readWebReturn(hash: string): AuthReturn | null {
  if (!/^#(ticket|error)=/.test(hash)) return null;
  const ticket = /^#ticket=([A-Za-z0-9_-]{43})$/.exec(hash)?.[1];
  if (ticket) return { ticket };
  return { error: hash === "#error=denied" ? "denied" : "failed" };
}

/** True for the sign-in return link, as a full link or as the path the router makes of it. */
export function isAuthReturn(link: string): boolean {
  const path = link.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\/+/, "");
  return /^auth(?:[/?#]|$)/.test(path);
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Padded base64 to base64url without padding, the form the API compares the secret's hash in. */
export const toBase64Url = (base64: string): string => base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
