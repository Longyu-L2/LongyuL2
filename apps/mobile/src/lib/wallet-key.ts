/**
 * Which wallet key this device keeps, and for whom. A key is stored under its account's own name,
 * and only when it is that account's wallet (or the account has none yet). Nothing here sends a
 * key anywhere. No native imports, so the unit tests run it.
 */
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";

/** The account a key is kept for: its id names the stored key, its linked wallet says which key belongs. */
export interface WalletOwner {
  id: string;
  wallet: string | null;
}

/** Where a device keeps keys. `set` fails when the value was not kept. */
export interface KeyStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** A typed or stored private key without the space around it; null when it is not one. */
export function readKey(text: string | null | undefined): Hex | null {
  const key = (text ?? "").trim();
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as Hex) : null;
}

/** The storage name of an account's key: two accounts on one device never share one. */
export function walletKeyName(base: string, owner: WalletOwner): string {
  return `${base}.${owner.id.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

export const isWalletOf = (owner: WalletOwner, address: string): boolean => owner.wallet?.toLowerCase() === address.toLowerCase();

export type CheckedKey = { key: Hex; account: PrivateKeyAccount } | { error: "invalid_key" | "different_wallet" };

/** A typed key and its wallet, when the account may keep it: it has no wallet yet, or the key is that wallet's. */
export function checkKey(owner: WalletOwner, text: string): CheckedKey {
  const key = readKey(text);
  if (!key) return { error: "invalid_key" };
  const account = privateKeyToAccount(key);
  if (owner.wallet !== null && !isWalletOf(owner, account.address)) return { error: "different_wallet" };
  return { key, account };
}

/**
 * The key this device keeps for the account. A key saved before keys were kept per account (under
 * `base` alone) is taken over once, and only when it is the account's linked wallet; otherwise it
 * stays where it is, for the account it does belong to.
 */
export async function storedKey(store: KeyStore, base: string, owner: WalletOwner): Promise<Hex | null> {
  const own = readKey(await store.get(walletKeyName(base, owner)));
  if (own) return own;
  const old = readKey(await store.get(base));
  if (!old || !isWalletOf(owner, privateKeyToAccount(old).address)) return null;
  try {
    await store.set(walletKeyName(base, owner), old);
    await store.remove(base);
  } catch {
    // Not moved this time: it is still this account's key, and the next read tries again.
  }
  return old;
}

/**
 * The stored key, when it may be shown as the account's: it has no wallet yet, or the key is that
 * wallet's. A device can still hold the key of a wallet the account has since replaced elsewhere.
 */
export async function exportableKey(store: KeyStore, base: string, owner: WalletOwner): Promise<Hex | null> {
  const key = await storedKey(store, base, owner);
  if (!key) return null;
  return owner.wallet === null || isWalletOf(owner, privateKeyToAccount(key).address) ? key : null;
}

/** A clipboard, as far as taking a copied key out of it again needs one. */
export interface Clipboard {
  getStringAsync(): Promise<string>;
  setStringAsync(text: string): Promise<unknown>;
}

/** Empties the clipboard when it still holds the key, and leaves anything copied since alone. */
export async function clearCopiedKey(clipboard: Clipboard, key: string): Promise<void> {
  try {
    if ((await clipboard.getStringAsync()) === key) await clipboard.setStringAsync("");
  } catch {
    // The clipboard could not be read (a browser may refuse): it is left as it is.
  }
}
