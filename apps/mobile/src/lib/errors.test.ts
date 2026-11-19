import { test } from "node:test";
import assert from "node:assert/strict";
import { errorKey, errorKeyOf } from "./errors.ts";
import { en } from "./i18n.ts";

test("every known error code has wording of its own", () => {
  const codes = {
    x_denied: "xDenied", x_failed: "xFailed", x_too_soon: "xTooSoon", x_elsewhere: "xOtherBrowser", x_paused: "xPaused", x_too_many: "xTooMany",
    ticket_invalid: "xFailed", sign_in_unavailable: "xFailed", reauth_required: "xFailed",
    reauth_invalid: "xWrongAccount", wallet_change_cooldown: "walletCooldown",
    account_restricted: "accountRestricted", region_blocked: "regionBlocked", region_unknown: "regionBlocked", web_mining_unavailable: "webMiningOff",
    device_locked: "deviceLocked", device_unknown: "deviceCheckFailed", device_not_attested: "deviceCheckFailed",
    attestation_required: "deviceCheckFailed", attestation_failed: "deviceCheckFailed", attest_failed: "deviceCheckFailed", attest_unsupported: "deviceUnsupported",
    pulse_failed: "humanCheckCancelled", captcha_failed: "humanCheckCancelled", check_cancelled: "humanCheckCancelled",
    storage_unavailable: "storageBlocked", device_required: "needsDevice",
    invalid_key: "invalidKey", different_wallet: "differentWallet", wallet_in_use: "walletInUse", wallet_required: "walletRequired",
    siwe_invalid: "walletLinkFailed", signature_invalid: "walletLinkFailed",
    session_not_available: "sessionNotAvailable", nothing_to_claim: "nothingToClaim",
    payments_unavailable: "capacityUnavailable", unknown_plan: "capacityUnavailable", verify_first: "capacityVerifyFirst",
    too_many_open_orders: "capacityTooManyOpen", boost_queue_full: "capacityQueueFull",
    verification_unavailable: "verifyNotOpen", appeal_open: "appealOpen",
  } as const;
  for (const [code, key] of Object.entries(codes)) {
    assert.equal(errorKey(code), key, code);
    assert.notEqual(key, "error");
    assert.ok(en[key].trim(), key);
  }
});

test("unknown error codes fall back to the general message", () => {
  for (const code of ["internal_error", "invalid_request", "conflict", "error", "Error", "", "constructor", "toString", "__proto__"]) {
    assert.equal(errorKey(code), "error", code);
    assert.equal(errorKey(code, 500), "error", code);
  }
  // The rate limiter answers with its own text and no code of ours.
  assert.equal(errorKey("Error", 429), "tooManyRequests");
  assert.equal(errorKey("device_locked", 429), "deviceLocked");
});

test("errorKeyOf reads the code and status of whatever was thrown", () => {
  class ApiError extends Error {
    constructor(readonly status: number, readonly code: string, message?: string) {
      super(message ?? code);
    }
  }
  assert.equal(errorKeyOf(new ApiError(409, "wallet_in_use", "This wallet is already used by LONGYU")), "walletInUse");
  assert.equal(errorKeyOf(new ApiError(429, "Error", "Rate limit exceeded, retry in 1 minute")), "tooManyRequests");
  assert.equal(errorKeyOf(new ApiError(500, "internal_error")), "error");
  assert.equal(errorKeyOf(new TypeError("Network request failed")), "error");
  // A request that ran out of time reads as one that never connected.
  assert.equal(errorKeyOf(new ApiError(0, "timeout")), "error");
  assert.equal(errorKeyOf({ code: 7, status: "429" }), "error");
  assert.equal(errorKeyOf("wallet_in_use"), "error");
  assert.equal(errorKeyOf(null), "error");
  assert.equal(errorKeyOf(undefined), "error");
});
