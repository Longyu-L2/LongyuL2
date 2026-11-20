/**
 * The invite code a visitor arrived with ("/?invite=CODE"). It is kept for the tab, so it is still
 * there when a sign-in comes back from X without it.
 */
import { cleanInviteCode, inviteCodeFrom, inviteLink } from "./invite";

const KEY = "longyu.invite";

function kept(): string {
  try {
    return cleanInviteCode(window.sessionStorage.getItem(KEY));
  } catch {
    return "";
  }
}

function keep(code: string): void {
  try {
    if (code) window.sessionStorage.setItem(KEY, code);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // Storage is blocked: the code still lasts as long as this page does.
  }
}

let arrived = "";
if (typeof window !== "undefined") {
  arrived = inviteCodeFrom(window.location.search);
  if (arrived) keep(arrived);
  else arrived = kept();
}

/** The code to offer on the sign-in page, or "". */
export const invitedWith = (): string => arrived;

/** Called once someone is signed in: the code has been used, or does not apply to an existing account. */
export function forgetInvite(): void {
  arrived = "";
  keep("");
}

/** The link that brings someone to this site with `code` filled in. */
export const inviteLinkFor = (code: string): string => (typeof window === "undefined" ? "" : inviteLink(window.location.origin, code));
