/** The Android app is not opened by invite links: a code is typed on the sign-in page. See invite-link.web.ts. */

export const invitedWith = (): string => "";

export function forgetInvite(): void {}

/** "" here: the app shares the code itself. */
export const inviteLinkFor = (_code: string): string => "";
