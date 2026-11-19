import { test } from "node:test";
import assert from "node:assert/strict";
import { checkKey, clearCopiedKey, exportableKey, isWalletOf, readKey, storedKey, walletKeyName, type KeyStore } from "./wallet-key.ts";

// Throwaway keys that exist only in this test. The first is the key "1", whose address is well known.
const KEY_A = `0x${"0".repeat(63)}1`;
const ADDRESS_A = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const KEY_B = `0x${"0".repeat(63)}2`;
const ADDRESS_B = "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF";
const BASE = "longyu.wallet.privateKey";

function memory(initial: Record<string, string> = {}, writable = true): KeyStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (name) => data.get(name) ?? null,
    set: async (name, value) => {
      if (!writable) throw new Error("storage refused");
      data.set(name, value);
    },
    remove: async (name) => void data.delete(name),
  };
}

test("readKey accepts a private key and nothing else", () => {
  assert.equal(readKey(KEY_A), KEY_A);
  assert.equal(readKey(`  ${KEY_A}\n`), KEY_A);
  assert.equal(readKey(`0x${"AB".repeat(32)}`), `0x${"AB".repeat(32)}`);
  for (const bad of [null, undefined, "", "0x", KEY_A.slice(2), KEY_A.slice(0, -1), `${KEY_A}0`, `0x${"zz".repeat(32)}`, ADDRESS_A]) assert.equal(readKey(bad), null);
});

test("each account's key has a storage name of its own", () => {
  const a = walletKeyName(BASE, { id: "3f0c9a52-7b1e-4c7a-9d55-0a6a8b7f2e11", wallet: null });
  const b = walletKeyName(BASE, { id: "9d1b7c04-55aa-4e0f-8a3c-6f2e1d0c9b88", wallet: null });
  assert.equal(a, `${BASE}.3f0c9a52-7b1e-4c7a-9d55-0a6a8b7f2e11`);
  assert.notEqual(a, b);
  assert.notEqual(a, BASE);
  // Only characters a phone's secure storage takes in a name.
  assert.match(walletKeyName(BASE, { id: "a b/c:d", wallet: null }), /^[A-Za-z0-9._-]+$/);
});

test("checkKey keeps a typed key only for the account whose wallet it is", () => {
  const fresh = checkKey({ id: "u1", wallet: null }, ` ${KEY_A} `);
  assert.ok("account" in fresh);
  assert.equal(fresh.key, KEY_A);
  assert.equal(fresh.account.address, ADDRESS_A);

  const same = checkKey({ id: "u1", wallet: ADDRESS_A.toLowerCase() }, KEY_A);
  assert.ok("account" in same && same.account.address === ADDRESS_A);
  const other = checkKey({ id: "u2", wallet: ADDRESS_B }, KEY_B);
  assert.ok("account" in other && other.account.address === ADDRESS_B);

  assert.deepEqual(checkKey({ id: "u1", wallet: ADDRESS_B }, KEY_A), { error: "different_wallet" });
  assert.deepEqual(checkKey({ id: "u1", wallet: ADDRESS_A }, "not a key"), { error: "invalid_key" });
  assert.deepEqual(checkKey({ id: "u1", wallet: null }, ""), { error: "invalid_key" });
});

test("isWalletOf compares addresses whatever their case", () => {
  assert.equal(isWalletOf({ id: "u1", wallet: ADDRESS_A.toLowerCase() }, ADDRESS_A), true);
  assert.equal(isWalletOf({ id: "u1", wallet: ADDRESS_B }, ADDRESS_A), false);
  assert.equal(isWalletOf({ id: "u1", wallet: null }, ADDRESS_A), false);
});

test("storedKey reads only the account's own key", async () => {
  const u1 = { id: "u1", wallet: ADDRESS_A };
  const u2 = { id: "u2", wallet: ADDRESS_B };
  const store = memory({ [walletKeyName(BASE, u1)]: KEY_A });
  assert.equal(await storedKey(store, BASE, u1), KEY_A);
  assert.equal(await storedKey(store, BASE, u2), null);
  assert.equal(await storedKey(store, BASE, { id: "u2", wallet: null }), null);
  // Another account with the same wallet on record still does not read u1's key.
  assert.equal(await storedKey(store, BASE, { id: "u3", wallet: ADDRESS_A }), null);
  assert.equal(await storedKey(memory({ [walletKeyName(BASE, u1)]: "garbage" }), BASE, u1), null);
});

test("storedKey takes over a key saved before keys were per account, once, for its own account", async () => {
  const owner = { id: "u1", wallet: ADDRESS_A.toLowerCase() };
  const store = memory({ [BASE]: KEY_A });
  assert.equal(await storedKey(store, BASE, owner), KEY_A);
  assert.deepEqual([...store.data], [[walletKeyName(BASE, owner), KEY_A]]);
  assert.equal(await storedKey(store, BASE, owner), KEY_A);
});

test("storedKey leaves an old key alone when it is not the account's wallet", async () => {
  for (const owner of [{ id: "u2", wallet: ADDRESS_B }, { id: "u2", wallet: null }]) {
    const store = memory({ [BASE]: KEY_A });
    assert.equal(await storedKey(store, BASE, owner), null);
    assert.deepEqual([...store.data], [[BASE, KEY_A]]);
  }
  // The account's own key wins over an old one.
  const owner = { id: "u2", wallet: ADDRESS_B };
  const both = memory({ [BASE]: KEY_A, [walletKeyName(BASE, owner)]: KEY_B });
  assert.equal(await storedKey(both, BASE, owner), KEY_B);
  assert.equal(both.data.get(BASE), KEY_A);
});

test("storedKey still returns the old key when it cannot be moved", async () => {
  const owner = { id: "u1", wallet: ADDRESS_A };
  const store = memory({ [BASE]: KEY_A }, false);
  assert.equal(await storedKey(store, BASE, owner), KEY_A);
  assert.deepEqual([...store.data], [[BASE, KEY_A]]);
});

test("exportableKey shows a stored key only as the wallet the account is linked to", async () => {
  const name = walletKeyName(BASE, { id: "u1", wallet: null });
  // A key stored under the account's own name that is not the linked wallet: replaced elsewhere, or never linked.
  const stale = memory({ [name]: KEY_A });
  assert.equal(await exportableKey(stale, BASE, { id: "u1", wallet: ADDRESS_B }), null);
  assert.equal(stale.data.get(name), KEY_A);

  assert.equal(await exportableKey(memory({ [name]: KEY_A }), BASE, { id: "u1", wallet: ADDRESS_A.toLowerCase() }), KEY_A);
  // An account with no wallet yet sees the key it is about to link.
  assert.equal(await exportableKey(memory({ [name]: KEY_A }), BASE, { id: "u1", wallet: null }), KEY_A);
  assert.equal(await exportableKey(memory(), BASE, { id: "u1", wallet: ADDRESS_A }), null);
  assert.equal(await exportableKey(memory({ [name]: KEY_A }), BASE, { id: "u2", wallet: ADDRESS_A }), null);
  // A key saved before keys were per account follows the same rule.
  assert.equal(await exportableKey(memory({ [BASE]: KEY_A }), BASE, { id: "u1", wallet: ADDRESS_A }), KEY_A);
  assert.equal(await exportableKey(memory({ [BASE]: KEY_A }), BASE, { id: "u1", wallet: ADDRESS_B }), null);
});

test("clearCopiedKey empties the clipboard only while it still holds the key", async () => {
  const clipboard = (held: string, readable = true) => {
    const board = {
      held,
      getStringAsync: async () => {
        if (!readable) throw new Error("not allowed");
        return board.held;
      },
      setStringAsync: async (text: string) => {
        board.held = text;
        return true;
      },
    };
    return board;
  };
  const still = clipboard(KEY_A);
  await clearCopiedKey(still, KEY_A);
  assert.equal(still.held, "");

  const since = clipboard("something copied later");
  await clearCopiedKey(since, KEY_A);
  assert.equal(since.held, "something copied later");

  // A clipboard that may not be read is left as it is, and nothing is thrown.
  const refused = clipboard(KEY_A, false);
  await clearCopiedKey(refused, KEY_A);
  assert.equal(refused.held, KEY_A);

  const stuck = { getStringAsync: async () => KEY_A, setStringAsync: async () => Promise.reject(new Error("not allowed")) };
  await clearCopiedKey(stuck, KEY_A);
});
