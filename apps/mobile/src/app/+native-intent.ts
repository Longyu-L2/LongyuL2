import { isAuthReturn } from "@/lib/x-auth";

/**
 * Keeps the sign-in return link (longyumine://auth?ticket=...) away from the router: it is not a
 * screen, and the ticket is read only by the sign-in that is waiting for it (see signInWithX). If
 * the app was started by that link, the sign-in that asked for it is gone, so it opens normally.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  if (!isAuthReturn(path)) return path;
  return initial ? "/" : null;
}
