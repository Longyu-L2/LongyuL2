/**
 * The app's own wording for the error codes the API and the device layer report. A screen shows
 * `t(errorKeyOf(e))`, never the API's text. No native imports, so the unit tests run it.
 */
import type { StringKey } from "./i18n";

const KEYS: Record<string, StringKey> = {
  // sign-in
  x_denied: "xDenied",
  x_failed: "xFailed",
  x_too_soon: "xTooSoon",
  x_elsewhere: "xOtherBrowser",
  x_paused: "xPaused",
  x_too_many: "xTooMany",
  ticket_invalid: "xFailed",
  sign_in_unavailable: "xFailed",
  reauth_required: "xFailed",
  reauth_invalid: "xWrongAccount",
  // account
  account_restricted: "accountRestricted",
  region_blocked: "regionBlocked",
  region_unknown: "regionBlocked",
  web_mining_unavailable: "webMiningOff",
  // device and human checks
  device_locked: "deviceLocked",
  device_unknown: "deviceCheckFailed",
  device_not_attested: "deviceCheckFailed",
  attestation_required: "deviceCheckFailed",
  attestation_failed: "deviceCheckFailed",
  attest_failed: "deviceCheckFailed",
  attest_unsupported: "deviceUnsupported",
  pulse_failed: "humanCheckCancelled",
  captcha_failed: "humanCheckCancelled",
  check_cancelled: "humanCheckCancelled",
  storage_unavailable: "storageBlocked",
  device_required: "needsDevice",
  // wallet
  invalid_key: "invalidKey",
  different_wallet: "differentWallet",
  wallet_in_use: "walletInUse",
  wallet_required: "walletRequired",
  wallet_change_cooldown: "walletCooldown",
  siwe_invalid: "walletLinkFailed",
  signature_invalid: "walletLinkFailed",
  // mining and rewards
  session_not_available: "sessionNotAvailable",
  work_required: "chainCheckFailed",
  work_invalid: "chainCheckFailed",
  chain_check_failed: "chainCheckFailed",
  output_unknown: "chainCheckFailed",
  output_too_old: "chainCheckFailed",
  nothing_to_claim: "nothingToClaim",
  // capacity
  payments_unavailable: "capacityUnavailable",
  unknown_plan: "capacityUnavailable",
  verify_first: "capacityVerifyFirst",
  too_many_open_orders: "capacityTooManyOpen",
  boost_queue_full: "capacityQueueFull",
  // profile
  verification_unavailable: "verifyNotOpen",
  appeal_open: "appealOpen",
};

/** The translation key for an error code. Unknown codes get the general message, or the rate limit's by its status. */
export function errorKey(code: string, status = 0): StringKey {
  // Own entries only: a code such as "constructor" is not in the table.
  if (Object.prototype.hasOwnProperty.call(KEYS, code)) return KEYS[code]!;
  return status === 429 ? "tooManyRequests" : "error";
}

/** The same for whatever was thrown: an ApiError carries a code and a status, anything else is unknown. */
export function errorKeyOf(e: unknown): StringKey {
  const v = (typeof e === "object" && e !== null ? e : {}) as { code?: unknown; status?: unknown };
  return errorKey(typeof v.code === "string" ? v.code : "", typeof v.status === "number" ? v.status : 0);
}
