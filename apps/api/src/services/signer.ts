/**
 * Signing accounts for the publisher, relayer and faucet signer.
 * - Development: a raw private key from the environment.
 * - Production, either of:
 *   - LONGYU's signer service (apps/signer) on the private network. It holds the keys and signs
 *     only what its policy allows; this module asks, then checks that what came back is exactly
 *     what was asked for, signed by the expected address.
 *   - An AWS KMS secp256k1 key. The private key never leaves the HSM; this module turns KMS's
 *     DER signatures into Ethereum signatures (low-s, with the recovery bit).
 */
import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import {
  bytesToHex,
  hashMessage,
  hashTypedData,
  hexToBytes,
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type LocalAccount,
  type TransactionSerializable,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount, publicKeyToAddress, toAccount } from "viem/accounts";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = SECP256K1_N / 2n;

/** The two KMS calls we need; a real KMSClient or a test fake. */
export interface KmsLike {
  send(command: GetPublicKeyCommand | SignCommand): Promise<{ PublicKey?: Uint8Array; Signature?: Uint8Array }>;
}

export function localAccount(privateKey: Hex): LocalAccount {
  return privateKeyToAccount(privateKey);
}

/** Parses a DER ECDSA signature: SEQUENCE { INTEGER r, INTEGER s }. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  const expect = (tag: number) => {
    if (der[i++] !== tag) throw new Error("invalid DER signature");
  };
  const readLen = (): number => {
    let len = der[i++]!;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | der[i++]!;
    }
    return len;
  };
  const readInt = (): bigint => {
    expect(0x02);
    const len = readLen();
    const bytes = der.subarray(i, i + len);
    i += len;
    return BigInt(bytesToHex(bytes));
  };
  expect(0x30);
  readLen();
  const r = readInt();
  const s = readInt();
  if (r <= 0n || r >= SECP256K1_N || s <= 0n || s >= SECP256K1_N) throw new Error("signature out of range");
  return { r, s };
}

/** The uncompressed public key is the last 65 bytes of the SubjectPublicKeyInfo DER. */
export function publicKeyFromSpki(spki: Uint8Array): Hex {
  const key = spki.subarray(spki.length - 65);
  if (key[0] !== 0x04) throw new Error("expected an uncompressed secp256k1 public key");
  return bytesToHex(key);
}

const toHex32 = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;

export async function kmsAccount(kms: KmsLike, keyId: string): Promise<LocalAccount> {
  const pub = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!pub.PublicKey) throw new Error("KMS returned no public key");
  const address: Address = publicKeyToAddress(publicKeyFromSpki(pub.PublicKey));

  const signHash = async (hash: Hex) => {
    const out = await kms.send(
      new SignCommand({
        KeyId: keyId,
        Message: hexToBytes(hash),
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    );
    if (!out.Signature) throw new Error("KMS returned no signature");
    let { r, s } = parseDerSignature(out.Signature);
    if (s > HALF_N) s = SECP256K1_N - s; // Ethereum requires low-s
    for (const yParity of [0, 1] as const) {
      const signature = { r: toHex32(r), s: toHex32(s), yParity, v: BigInt(27 + yParity) };
      if ((await recoverAddress({ hash, signature })).toLowerCase() === address.toLowerCase()) return signature;
    }
    throw new Error("could not recover the KMS signer address");
  };
  const flat = (sig: { r: Hex; s: Hex; yParity: number }): Hex =>
    `0x${sig.r.slice(2)}${sig.s.slice(2)}${(27 + sig.yParity).toString(16)}`;

  const account = toAccount({
    address,
    async signMessage({ message }) {
      return flat(await signHash(hashMessage(message)));
    },
    async signTypedData(typedData) {
      return flat(await signHash(hashTypedData(typedData as never)));
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      const hash = keccak256(await serializer(transaction));
      const signature = await signHash(hash);
      return serializer(transaction, signature);
    },
  });
  return account as LocalAccount;
}

export function kmsClient(region: string): KmsLike {
  return new KMSClient({ region }) as unknown as KmsLike;
}

export interface RemoteSignerOptions {
  /** The signer's private-network address, e.g. http://signer.railway.internal:8080 */
  url: string;
  token: string;
  /** What this API is configured for; the signer must be bound to the same chain and contracts. */
  chainId: number;
  distributor: Address;
  faucet?: Address;
  fetch?: typeof fetch;
}

export interface RemoteAccounts {
  publisher?: LocalAccount;
  relayer?: LocalAccount;
  faucetSigner?: LocalAccount;
  watch?: LocalAccount;
}

const VOUCHER_FIELDS = "recipient:address,amount:uint256,nonce:uint256,deadline:uint256";
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const sameAddress = (a: unknown, b: Address): boolean =>
  typeof a === "string" && HEX_ADDRESS.test(a) && a.toLowerCase() === b.toLowerCase();

/**
 * Accounts whose keys live in the signer service. Reads the signer's addresses once and refuses to
 * start if the signer is bound to another chain or other contracts than this API.
 */
export async function remoteAccounts(o: RemoteSignerOptions): Promise<RemoteAccounts> {
  const send = o.fetch ?? fetch;
  const base = o.url.replace(/\/+$/, "");

  const request = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const res = await send(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${o.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new Error(`the signer refused ${path}: ${typeof json?.error === "string" ? json.error : res.status}`);
    if (!json || typeof json !== "object") throw new Error(`the signer gave no answer for ${path}`);
    return json;
  };

  const info = await request("/v1/accounts");
  if (info.chainId !== o.chainId) throw new Error(`the signer is bound to chain ${String(info.chainId)}, not ${o.chainId}`);
  if (!sameAddress(info.distributor, o.distributor)) throw new Error("the signer is bound to a different distributor");
  if (o.faucet && !sameAddress(info.faucet, o.faucet)) throw new Error("the signer is bound to a different faucet");

  const refuse = (what: string) => async (): Promise<never> => {
    throw new Error(`the signer does not sign ${what}`);
  };

  const transactionAccount = (role: "publisher" | "relayer" | "watch", address: Address): LocalAccount =>
    toAccount({
      address,
      signMessage: refuse("messages"),
      signTypedData: refuse("typed data with this key"),
      async signTransaction(transaction, options) {
        const t = transaction as TransactionSerializable & { type?: string };
        if (t.accessList?.length || t.blobs || t.blobVersionedHashes || t.authorizationList || t.sidecars) {
          throw new Error("the signer signs only plain transactions");
        }
        const type = t.type ?? (t.gasPrice !== undefined ? "legacy" : "eip1559");
        if (type !== "legacy" && type !== "eip1559") throw new Error(`the signer does not sign ${type} transactions`);
        if (!t.to || t.data === undefined || t.gas === undefined || t.nonce === undefined) throw new Error("incomplete transaction");
        if ((t.value ?? 0n) !== 0n) throw new Error("the signer does not send value");
        if (t.chainId !== o.chainId) throw new Error("transaction for another chain");
        const fees: Record<string, bigint | undefined> =
          type === "legacy"
            ? { gasPrice: t.gasPrice }
            : { maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas };
        if (Object.values(fees).some((v) => v === undefined)) throw new Error("incomplete transaction fees");
        const asked = { type, chainId: o.chainId, to: t.to, data: t.data, value: 0n, nonce: t.nonce, gas: t.gas, ...fees } as TransactionSerializable;

        const out = await request("/v1/sign/transaction", {
          role,
          transaction: {
            type,
            chainId: o.chainId,
            to: t.to,
            data: t.data,
            value: "0",
            nonce: t.nonce,
            gas: t.gas.toString(),
            ...Object.fromEntries(Object.entries(fees).map(([k, v]) => [k, v!.toString()])),
          },
        });
        // Trust nothing that comes back: it must be exactly the transaction asked for, signed by this address.
        const signed = out.signedTransaction as TransactionSerialized;
        if (typeof signed !== "string" || !/^0x[0-9a-f]+$/i.test(signed)) throw new Error("the signer returned no transaction");
        const { r, s, v, yParity } = parseTransaction(signed);
        if (!r || !s) throw new Error("the signer returned an unsigned transaction");
        const serializer = options?.serializer ?? serializeTransaction;
        const expected = await serializer(asked as never, { r, s, v, yParity } as never);
        if (expected.toLowerCase() !== signed.toLowerCase()) throw new Error("the signer returned a different transaction");
        const signedBy = await recoverTransactionAddress({ serializedTransaction: signed });
        if (!isAddressEqual(signedBy, address)) throw new Error("the signer signed with another key");
        return signed as never;
      },
    }) as LocalAccount;

  const voucherAccount = (address: Address): LocalAccount =>
    toAccount({
      address,
      signMessage: refuse("messages"),
      signTransaction: refuse("transactions with this key"),
      async signTypedData(typedData) {
        const td = typedData as unknown as {
          domain?: { name?: string; version?: string; chainId?: number | bigint; verifyingContract?: string; salt?: string };
          types?: Record<string, readonly { name: string; type: string }[]>;
          primaryType?: string;
          message?: { recipient?: unknown; amount?: unknown; nonce?: unknown; deadline?: unknown };
        };
        const { domain, types, message } = td;
        const customTypes = Object.keys(types ?? {}).filter((k) => k !== "EIP712Domain");
        if (
          !o.faucet ||
          td.primaryType !== "Voucher" ||
          customTypes.length !== 1 ||
          types!.Voucher?.map((f) => `${f.name}:${f.type}`).join(",") !== VOUCHER_FIELDS ||
          domain?.name !== "LONGYU Faucet" ||
          domain.version !== "1" ||
          domain.salt !== undefined ||
          Number(domain.chainId) !== o.chainId ||
          !sameAddress(domain.verifyingContract, o.faucet)
        ) {
          throw new Error("the signer signs only this faucet's vouchers");
        }
        const { recipient, amount, nonce, deadline } = message ?? {};
        if (typeof recipient !== "string" || typeof amount !== "bigint" || typeof nonce !== "bigint" || typeof deadline !== "bigint") {
          throw new Error("incomplete voucher");
        }
        const out = await request("/v1/sign/voucher", { recipient, amount: amount.toString(), nonce: nonce.toString(), deadline: deadline.toString() });
        const signature = out.signature as Hex;
        if (typeof signature !== "string" || !/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error("the signer returned no signature");
        const signedBy = await recoverTypedDataAddress({ ...(typedData as never as Parameters<typeof recoverTypedDataAddress>[0]), signature });
        if (!isAddressEqual(signedBy, address)) throw new Error("the signer signed with another key");
        return signature;
      },
    }) as LocalAccount;

  const address = (value: unknown, what: string): Address | undefined => {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "string" || !HEX_ADDRESS.test(value)) throw new Error(`the signer reported no valid ${what} address`);
    return value as Address;
  };
  const publisher = address(info.publisher, "publisher");
  const relayer = address(info.relayer, "relayer");
  const faucetSigner = address(info.faucetSigner, "faucet signer");
  const watch = address(info.watch, "watch");
  return {
    publisher: publisher && transactionAccount("publisher", publisher),
    relayer: relayer && transactionAccount("relayer", relayer),
    faucetSigner: faucetSigner && voucherAccount(faucetSigner),
    watch: watch && transactionAccount("watch", watch),
  };
}
