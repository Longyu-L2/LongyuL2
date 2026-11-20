/** Invite codes and the link that carries one. No platform APIs here, so it runs under Node tests. */

/** A typed or linked invite code as the API takes it: trimmed and upper case, or "" when it cannot be one. */
export function cleanInviteCode(raw: string | null | undefined): string {
  const code = (raw ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{4,16}$/.test(code) ? code : "";
}

/** The invite code in a page address's query string ("?invite=CODE"), or "". */
export function inviteCodeFrom(search: string): string {
  return cleanInviteCode(new URLSearchParams(search).get("invite"));
}

/** The link that opens the web miner with `code` filled in for whoever signs up. */
export function inviteLink(origin: string, code: string): string {
  return `${origin}/?invite=${encodeURIComponent(code)}`;
}
