/**
 * The API's side of the signer service, against the real signer (apps/signer) over HTTP:
 * what the API sends through viem is what the signer's policy accepts, and nothing a
 * misbehaving signer returns is passed on.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { faucetAbi, miningDistributorAbi } from "@longyu/abis";
import {
  createWalletClient, custom, decodeFunctionData, defineChain, encodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress,
  type Address, type Hex, type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../../signer/src/app.ts";
import { loadConfig as loadSignerConfig } from "../../signer/src/config.ts";
import { loadConfig } from "../src/config.ts";
import { signers } from "../src/server.ts";
import { remoteAccounts, type RemoteSignerOptions } from "../src/services/signer.ts";

const key = (n: string) => `0x${n.repeat(64)}` as Hex;
const TOKEN = "remote-signer-test-token-0123456789";
const CHAIN_ID = 668801;
const DISTRIBUTOR: Address = "0x1111111111111111111111111111111111111111";
const FAUCET: Address = "0x2222222222222222222222222222222222222222";
const USER: Address = "0x4444444444444444444444444444444444444444";
const WORD = `0x${"ab".repeat(32)}` as Hex;
const PUBLISHER = privateKeyToAccount(key("1"));
const RELAYER = privateKeyToAccount(key("2"));
const FAUCET_SIGNER = privateKeyToAccount(key("3"));

let server: Server;
let url: string;
const options = (over: Partial<RemoteSignerOptions> = {}): RemoteSignerOptions => ({ url, token: TOKEN, chainId: CHAIN_ID, distributor: DISTRIBUTOR, faucet: FAUCET, ...over });

before(async () => {
  const config = loadSignerConfig({
    SIGNER_TOKEN: TOKEN,
    CHAIN_ID: String(CHAIN_ID),
    DISTRIBUTOR_ADDRESS: DISTRIBUTOR,
    FAUCET_ADDRESS: FAUCET,
    PUBLISHER_KEY: key("1"),
    RELAYER_KEY: key("2"),
    FAUCET_SIGNER_KEY: key("3"),
  });
  server = createServer(createApp(config, { log: () => {} }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** A node that answers what viem asks before sending, and keeps what was sent. */
function fakeNode() {
  const sent: TransactionSerialized[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_chainId": return `0x${CHAIN_ID.toString(16)}`;
        case "eth_getTransactionCount": return "0x5";
        case "eth_estimateGas": return "0x493e0";
        case "eth_maxPriorityFeePerGas": return "0x3e8";
        case "eth_gasPrice": return "0x7d0";
        case "eth_getBlockByNumber":
          return {
            number: "0x10", hash: WORD, parentHash: WORD, timestamp: "0x6553f100", baseFeePerGas: "0x3e8", gasLimit: "0x1c9c380", gasUsed: "0x0",
            transactions: [], uncles: [], difficulty: "0x0", totalDifficulty: "0x0", size: "0x0", nonce: "0x0000000000000000", logsBloom: "0x", miner: USER,
            extraData: "0x", mixHash: WORD, sha3Uncles: WORD, stateRoot: WORD, receiptsRoot: WORD, transactionsRoot: WORD,
          };
        case "eth_sendRawTransaction":
          sent.push((params as [TransactionSerialized])[0]);
          return keccak256((params as [Hex])[0]);
        default:
          throw Object.assign(new Error(`method ${method} not found`), { code: -32601 });
      }
    },
  });
  return { sent, transport };
}

const chain = defineChain({ id: CHAIN_ID, name: "LONGYU Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: ["http://unused.invalid"] } } });

test("the accounts are the signer's keys, and a signer bound elsewhere is refused at start", async () => {
  const accounts = await remoteAccounts(options());
  assert.deepEqual([accounts.publisher?.address, accounts.relayer?.address, accounts.faucetSigner?.address], [PUBLISHER.address, RELAYER.address, FAUCET_SIGNER.address]);
  // Letter case in the configured addresses makes no difference.
  await remoteAccounts(options({ distributor: DISTRIBUTOR.toUpperCase().replace("0X", "0x") as Address, url: `${url}/` }));
  await assert.rejects(remoteAccounts(options({ chainId: 97 })), /bound to chain 668801, not 97/);
  await assert.rejects(remoteAccounts(options({ distributor: FAUCET })), /different distributor/);
  await assert.rejects(remoteAccounts(options({ faucet: DISTRIBUTOR })), /different faucet/);
  await assert.rejects(remoteAccounts(options({ token: `${TOKEN}x` })), /unauthorized/);
  await assert.rejects(remoteAccounts(options({ url: "http://127.0.0.1:1" })));
});

test("a root proposal sent through viem is signed by the signer's publisher key", async () => {
  const { publisher } = await remoteAccounts(options());
  const node = fakeNode();
  const wallet = createWalletClient({ account: publisher!, chain, transport: node.transport });
  const args = [3n, WORD, 1000n, WORD, "https://data.example/roots/day-3.json"] as const;
  const hash = await wallet.writeContract({ address: DISTRIBUTOR, abi: miningDistributorAbi, functionName: "proposeRoot", args, account: publisher!, chain });
  assert.equal(node.sent.length, 1);
  assert.equal(hash, keccak256(node.sent[0]!));
  assert.equal(await recoverTransactionAddress({ serializedTransaction: node.sent[0]! }), PUBLISHER.address);
  const tx = parseTransaction(node.sent[0]!);
  assert.deepEqual([tx.chainId, tx.to?.toLowerCase(), tx.nonce, tx.value ?? 0n], [CHAIN_ID, DISTRIBUTOR, 5, 0n]);
  assert.deepEqual(decodeFunctionData({ abi: miningDistributorAbi, data: tx.data! }), { functionName: "proposeRoot", args });
});

test("claims and faucet drips sent through viem are signed by the relayer key", async () => {
  const { relayer } = await remoteAccounts(options());
  const node = fakeNode();
  const wallet = createWalletClient({ account: relayer!, chain, transport: node.transport });
  await wallet.writeContract({ address: DISTRIBUTOR, abi: miningDistributorAbi, functionName: "claimMany", args: [[USER], [5n], [[WORD]]], account: relayer!, chain });
  await wallet.writeContract({ address: FAUCET, abi: faucetAbi, functionName: "drip", args: [USER, 1n, 2n, 3n, "0x1234"], account: relayer!, chain });
  // A legacy-priced transaction is signed as one.
  await wallet.writeContract({ address: DISTRIBUTOR, abi: miningDistributorAbi, functionName: "claimMany", args: [[USER], [5n], [[WORD]]], account: relayer!, chain, gasPrice: 2000n });
  assert.equal(node.sent.length, 3);
  for (const raw of node.sent) assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), RELAYER.address);
  assert.deepEqual(node.sent.map((raw) => parseTransaction(raw).type), ["eip1559", "eip1559", "legacy"]);
});

test("what the signer's policy refuses is never sent", async () => {
  const { publisher, relayer, faucetSigner } = await remoteAccounts(options());
  const node = fakeNode();
  const wallet = createWalletClient({ account: publisher!, chain, transport: node.transport });
  // The publisher key cannot relay claims, call another contract or pause.
  await assert.rejects(wallet.writeContract({ address: DISTRIBUTOR, abi: miningDistributorAbi, functionName: "claimMany", args: [[USER], [5n], [[WORD]]], account: publisher!, chain }), /call_not_allowed/);
  await assert.rejects(wallet.writeContract({ address: USER, abi: miningDistributorAbi, functionName: "proposeRoot", args: [3n, WORD, 1n, WORD, "x"], account: publisher!, chain }), /target_not_allowed/);
  await assert.rejects(wallet.writeContract({ address: DISTRIBUTOR, abi: miningDistributorAbi, functionName: "pause", account: publisher!, chain }), /call_not_allowed/);
  // Plain transfers, value and access lists stop in the API, before the signer is asked.
  const plain = { chainId: CHAIN_ID, type: "eip1559", to: DISTRIBUTOR, data: "0x", nonce: 1, gas: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n } as const;
  await assert.rejects(relayer!.signTransaction({ ...plain, value: 1n }), /does not send value/);
  await assert.rejects(relayer!.signTransaction({ ...plain, accessList: [{ address: USER, storageKeys: [] }] }), /only plain transactions/);
  await assert.rejects(relayer!.signTransaction({ ...plain, chainId: 97 }), /another chain/);
  await assert.rejects(relayer!.signTransaction({ ...plain, to: undefined }), /incomplete transaction/);
  await assert.rejects(relayer!.signTransaction(plain), /call_not_allowed/);
  // No key signs a message, and each key signs only its own kind of thing.
  for (const account of [publisher!, relayer!, faucetSigner!]) await assert.rejects(account.signMessage({ message: "LONGYU" }), /does not sign messages/);
  await assert.rejects(faucetSigner!.signTransaction(plain), /does not sign transactions/);
  await assert.rejects(publisher!.signTypedData(voucher()), /does not sign typed data/);
  assert.equal(node.sent.length, 0);
});

const voucher = (over: { domain?: Record<string, unknown>; message?: Record<string, unknown>; types?: Record<string, unknown>; primaryType?: string } = {}) =>
  ({
    domain: { name: "LONGYU Faucet", version: "1", chainId: CHAIN_ID, verifyingContract: FAUCET, ...over.domain },
    types: over.types ?? {
      Voucher: [
        { name: "recipient", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: over.primaryType ?? "Voucher",
    message: { recipient: USER, amount: 10n ** 15n, nonce: 77n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600), ...over.message },
  }) as never;

test("the faucet signer signs this faucet's voucher and nothing else", async () => {
  const { faucetSigner } = await remoteAccounts(options());
  const typed = voucher();
  const signature = await faucetSigner!.signTypedData(typed);
  assert.equal(await recoverTypedDataAddress({ ...(typed as object), signature } as never), FAUCET_SIGNER.address);

  for (const other of [
    voucher({ domain: { verifyingContract: DISTRIBUTOR } }),
    voucher({ domain: { chainId: 97 } }),
    voucher({ domain: { name: "Other" } }),
    voucher({ domain: { version: "2" } }),
    voucher({ domain: { salt: WORD } }),
    voucher({ primaryType: "Permit", types: { Permit: [{ name: "recipient", type: "address" }] } }),
    voucher({ types: { Voucher: [{ name: "recipient", type: "address" }, { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }] } }),
  ]) {
    await assert.rejects(faucetSigner!.signTypedData(other), /only this faucet's vouchers/);
  }
  await assert.rejects(faucetSigner!.signTypedData(voucher({ message: { amount: undefined } })), /incomplete voucher/);
  // The signer's own limits still apply.
  await assert.rejects(faucetSigner!.signTypedData(voucher({ message: { amount: 10n ** 15n + 1n } })), /amount_out_of_range/);
  await assert.rejects(faucetSigner!.signTypedData(voucher({ message: { deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) } })), /deadline_out_of_range/);
  // An API without a faucet has no voucher to sign.
  const noFaucet = await remoteAccounts(options({ faucet: undefined }));
  await assert.rejects(noFaucet.faucetSigner!.signTypedData(typed), /only this faucet's vouchers/);
});

test("nothing a misbehaving signer returns is passed on", async () => {
  const asked = { chainId: CHAIN_ID, type: "eip1559", to: DISTRIBUTOR, data: "0x1234", nonce: 9, gas: 100_000n, maxFeePerGas: 2000n, maxPriorityFeePerGas: 1000n } as const;
  const accounts = { chainId: CHAIN_ID, distributor: DISTRIBUTOR, faucet: FAUCET, publisher: PUBLISHER.address, relayer: RELAYER.address, faucetSigner: FAUCET_SIGNER.address };
  /** A signer that reports the right addresses and answers every signing request with `reply`. */
  const lying = (reply: unknown, status = 200) =>
    remoteAccounts(
      options({
        fetch: (async (input: string | URL | Request) => {
          const body = String(input).endsWith("/v1/accounts") ? accounts : reply;
          return new Response(JSON.stringify(body), { status: String(input).endsWith("/v1/accounts") ? 200 : status, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
      }),
    );

  const honest = await PUBLISHER.signTransaction(asked);
  assert.equal(await (await lying({ signedTransaction: honest })).publisher!.signTransaction(asked), honest);

  // The right transaction, signed by another key.
  const otherKey = await (await lying({ signedTransaction: await RELAYER.signTransaction(asked) })).publisher!.signTransaction(asked).catch((e: Error) => e.message);
  assert.match(String(otherKey), /another key/);
  // The right key, another transaction: target, call data, nonce, gas, fee, value, chain or type.
  for (const change of [{ to: USER }, { data: "0x5678" }, { nonce: 10 }, { gas: 100_001n }, { maxFeePerGas: 2001n }, { maxPriorityFeePerGas: 999n }, { value: 1n }, { chainId: 97 }, { accessList: [{ address: USER, storageKeys: [] }] }] as const) {
    const forged = await PUBLISHER.signTransaction({ ...asked, ...change } as never);
    await assert.rejects((await lying({ signedTransaction: forged })).publisher!.signTransaction(asked), /different transaction/, JSON.stringify(Object.keys(change)));
  }
  const legacy = await PUBLISHER.signTransaction({ chainId: CHAIN_ID, type: "legacy", to: DISTRIBUTOR, data: "0x1234", nonce: 9, gas: 100_000n, gasPrice: 2000n });
  await assert.rejects((await lying({ signedTransaction: legacy })).publisher!.signTransaction(asked), /different transaction/);
  // Not a signed transaction at all.
  await assert.rejects((await lying({})).publisher!.signTransaction(asked), /returned no transaction/);
  await assert.rejects((await lying({ signedTransaction: "0xzz" })).publisher!.signTransaction(asked), /returned no transaction/);
  await assert.rejects((await lying({ signedTransaction: "0x02c0" })).publisher!.signTransaction(asked));
  await assert.rejects((await lying({ error: "fee_too_high" }, 403)).publisher!.signTransaction(asked), /fee_too_high/);
  await assert.rejects((await lying("nonsense", 500)).publisher!.signTransaction(asked), /500/);

  // Vouchers: a signature by another key, or none.
  const typed = voucher();
  const good = await FAUCET_SIGNER.signTypedData(typed);
  assert.equal(await (await lying({ signature: good })).faucetSigner!.signTypedData(typed), good);
  await assert.rejects((await lying({ signature: await RELAYER.signTypedData(typed) })).faucetSigner!.signTypedData(typed), /another key/);
  await assert.rejects((await lying({ signature: await FAUCET_SIGNER.signTypedData(voucher({ message: { amount: 5n } })) })).faucetSigner!.signTypedData(typed), /another key/);
  await assert.rejects((await lying({ signature: "0x1234" })).faucetSigner!.signTypedData(typed), /returned no signature/);
  await assert.rejects((await lying({})).faucetSigner!.signTypedData(typed), /returned no signature/);
});

test("a signer that reports the wrong things at start is refused", async () => {
  const reports = (body: unknown) =>
    remoteAccounts(options({ fetch: (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch }));
  const good = { chainId: CHAIN_ID, distributor: DISTRIBUTOR, faucet: FAUCET, publisher: PUBLISHER.address, relayer: null, faucetSigner: null };
  const accounts = await reports(good);
  assert.deepEqual([accounts.publisher?.address, accounts.relayer, accounts.faucetSigner], [PUBLISHER.address, undefined, undefined]);
  await assert.rejects(reports({ ...good, chainId: String(CHAIN_ID) }), /bound to chain/);
  await assert.rejects(reports({ ...good, distributor: null }), /different distributor/);
  await assert.rejects(reports({ ...good, faucet: null }), /different faucet/);
  await assert.rejects(reports({ ...good, publisher: "0x1234" }), /no valid publisher address/);
  await assert.rejects(reports({ ...good, relayer: 5 }), /no valid relayer address/);
  await assert.rejects(reports(null), /no answer/);
});

// ---------------------------------------------------------------- settings

const DEV = { JWT_SECRET: "x".repeat(40), RPC_URL: "http://127.0.0.1:8545", CHAIN_ID: String(CHAIN_ID), DISTRIBUTOR_ADDRESS: DISTRIBUTOR, FAUCET_ADDRESS: FAUCET };
const PROD = {
  ...DEV, NODE_ENV: "production", DATABASE_URL: "postgres://u:p@db/x", TURNSTILE_SECRET: "t", STORAGE_BUCKET: "d", PUBLIC_DATA_BASE_URL: "https://api.longyu.network/data",
  X_CLIENT_ID: "client-id", X_CLIENT_SECRET: "client-secret", X_REDIRECT_URI: "https://api.longyu.network/v1/auth/x/callback",
  ORIGIN_SECRET: "o".repeat(40), PUBLIC_RPC_URL: "https://rpc-testnet.longyu.network",
};
const REMOTE = { SIGNER_URL: "http://signer.railway.internal:8080", SIGNER_TOKEN: TOKEN };
const KMS = { KMS_REGION: "ap-southeast-1", KMS_PUBLISHER_KEY_ID: "publisher-key", KMS_RELAYER_KEY_ID: "relayer-key" };

test("settings: production names who signs, and never holds a raw key", () => {
  assert.equal(loadConfig({ ...PROD, ...REMOTE }).SIGNER_URL, REMOTE.SIGNER_URL);
  assert.equal(loadConfig({ ...PROD, ...KMS }).KMS_PUBLISHER_KEY_ID, "publisher-key");
  assert.throws(() => loadConfig(PROD), /SIGNER_URL and SIGNER_TOKEN \(or KMS key IDs for the publisher and relayer\) are required in production/);
  assert.throws(() => loadConfig({ ...PROD, KMS_PUBLISHER_KEY_ID: "publisher-key" }), /required in production/, "half of the KMS keys");
  for (const name of ["PUBLISHER_KEY", "RELAYER_KEY", "FAUCET_SIGNER_KEY"]) {
    assert.throws(() => loadConfig({ ...PROD, ...KMS, [name]: key("1") }), /raw signing keys are not allowed in production/, name);
    assert.throws(() => loadConfig({ ...PROD, [name]: key("1") }), /raw signing keys are not allowed in production/, name);
  }
  // Outside production raw keys still work, for the devnet and tests.
  assert.equal(loadConfig({ ...DEV, PUBLISHER_KEY: key("1") }).PUBLISHER_KEY, key("1"));
});

test("settings: the signer service comes whole, alone and over a link nobody else can read", () => {
  for (const env of [DEV, PROD]) {
    assert.throws(() => loadConfig({ ...env, SIGNER_URL: REMOTE.SIGNER_URL }), /SIGNER_URL and SIGNER_TOKEN are set together/);
    assert.throws(() => loadConfig({ ...env, SIGNER_TOKEN: TOKEN }), /SIGNER_URL and SIGNER_TOKEN are set together/);
    assert.throws(() => loadConfig({ ...env, ...REMOTE, SIGNER_TOKEN: "short" }));
    // One place holds the keys.
    for (const extra of [{ PUBLISHER_KEY: key("1") }, { RELAYER_KEY: key("2") }, { FAUCET_SIGNER_KEY: key("3") }, { KMS_PUBLISHER_KEY_ID: "k" }, { KMS_FAUCET_SIGNER_KEY_ID: "k" }, KMS]) {
      assert.throws(() => loadConfig({ ...env, ...REMOTE, ...extra }), /SIGNER_URL replaces the signing keys/, JSON.stringify(Object.keys(extra)));
    }
    for (const good of ["http://signer.railway.internal:8080", "http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080", "https://signer.longyu.network"]) {
      assert.equal(loadConfig({ ...env, ...REMOTE, SIGNER_URL: good }).SIGNER_URL, good);
    }
    // The token would cross the open internet in the clear, or the name only looks private.
    for (const open of ["http://signer.longyu.network:8080", "http://203.0.113.7:8080", "http://signer.internal.example.com", "http://internal:8080", "ftp://signer.railway.internal"]) {
      assert.throws(() => loadConfig({ ...env, ...REMOTE, SIGNER_URL: open }), /SIGNER_URL must be https, or http on a private network name/, open);
    }
    for (const odd of ["https://user:pw@signer.longyu.network", "https://signer.longyu.network/?token=1", "https://signer.longyu.network/#x"]) {
      assert.throws(() => loadConfig({ ...env, ...REMOTE, SIGNER_URL: odd }), /SIGNER_URL must be a plain address/, odd);
    }
    assert.throws(() => loadConfig({ ...env, ...REMOTE, SIGNER_URL: "signer.railway.internal:8080" }));
  }
});

test("at start the API takes its three accounts from the signer service, or from its own keys outside production", async () => {
  const remote = await signers(loadConfig({ ...DEV, SIGNER_URL: url, SIGNER_TOKEN: TOKEN }));
  assert.deepEqual([remote.publisher?.address, remote.relayer?.address, remote.faucetSigner?.address], [PUBLISHER.address, RELAYER.address, FAUCET_SIGNER.address]);
  // They sign through the service: the relayer's key is not in this process.
  const signed = await remote.relayer!.signTransaction({
    chainId: CHAIN_ID, type: "eip1559", to: FAUCET, nonce: 1, gas: 100_000n, maxFeePerGas: 2000n, maxPriorityFeePerGas: 1000n,
    data: encodeFunctionData({ abi: faucetAbi, functionName: "drip", args: [USER, 1n, 2n, 3n, "0x1234"] }),
  });
  assert.equal(await recoverTransactionAddress({ serializedTransaction: signed as TransactionSerialized }), RELAYER.address);

  // A signer bound to other contracts, another chain, or another token: the API does not start.
  const other = "0x3333333333333333333333333333333333333333";
  await assert.rejects(signers(loadConfig({ ...DEV, DISTRIBUTOR_ADDRESS: other, SIGNER_URL: url, SIGNER_TOKEN: TOKEN })), /different distributor/);
  await assert.rejects(signers(loadConfig({ ...DEV, FAUCET_ADDRESS: other, SIGNER_URL: url, SIGNER_TOKEN: TOKEN })), /different faucet/);
  await assert.rejects(signers(loadConfig({ ...DEV, CHAIN_ID: "97", SIGNER_URL: url, SIGNER_TOKEN: TOKEN })), /bound to chain 668801, not 97/);
  await assert.rejects(signers(loadConfig({ ...DEV, SIGNER_URL: url, SIGNER_TOKEN: "w".repeat(40) })), /the signer refused \/v1\/accounts/);
  // The request goes where the settings say, with the token and nothing else of ours.
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: init?.headers as Record<string, string> });
    return fetch(input, init);
  }) as typeof fetch;
  await signers(loadConfig({ ...DEV, SIGNER_URL: `${url}/`, SIGNER_TOKEN: TOKEN }), spy);
  assert.deepEqual(seen, [{ url: `${url}/v1/accounts`, headers: { authorization: `Bearer ${TOKEN}` } }]);

  // Without the service: this process's own keys, and only the ones it was given.
  const local = await signers(loadConfig({ ...DEV, PUBLISHER_KEY: key("1"), RELAYER_KEY: key("2") }));
  assert.deepEqual([local.publisher?.address, local.relayer?.address, local.faucetSigner], [PUBLISHER.address, RELAYER.address, undefined]);
  const none = await signers(loadConfig(DEV));
  assert.deepEqual([none.publisher, none.relayer, none.faucetSigner], [undefined, undefined, undefined]);
  // Settings that slipped past loadConfig are still refused here.
  await assert.rejects(signers({ ...loadConfig(DEV), SIGNER_URL: url }), /set together/);
  await assert.rejects(signers({ ...loadConfig({ ...DEV, PUBLISHER_KEY: key("1") }), SIGNER_URL: url, SIGNER_TOKEN: TOKEN }), /SIGNER_URL replaces the signing keys/);
  await assert.rejects(signers({ ...loadConfig({ ...DEV, PUBLISHER_KEY: key("1") }), NODE_ENV: "production" }), /raw private keys are not allowed in production/);
});
