import type { L1Watch } from "../src/services/l1.ts";
import type { PaymentChain } from "../src/services/payments.ts";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import type { FastifyInstance } from "fastify";
import { LEAF_ENCODING, TESTNET_LAUNCH_PARAMS, type RewardParams, type ScheduleParams } from "@longyu/reward-engine";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { Deps } from "../src/context.ts";
import { createPgliteDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { sha256PlainHex, toBig } from "../src/lib/util.ts";
import { createAttestation } from "../src/services/attestation.ts";
import { TxError, type ChainGateway, type ChainHealth, type ClaimItem, type DistributorEvent, type RewardToken, type RewardTransfer, type RootInfo, type TxOutcome } from "../src/services/chain.ts";
import { DevX, devCaptcha, localFileStore, pkceChallenge, type Notifier, type PushSender, type XAccount } from "../src/services/external.ts";
import { X_ACCOUNT_COOLOFF } from "../src/modules/auth.ts";
import { clearRootCache } from "../src/modules/mining.ts";

export const E18 = 10n ** 18n;
export const DAY = 86_400n;
export const START = 20_000n * DAY;
export const DISTRIBUTOR = getAddress("0x000000000000000000000000000000000000D157");
export const FAUCET = getAddress("0x000000000000000000000000000000000000FA0C");
/** Where the development X provider sends the browser back. */
export const X_CALLBACK = "http://localhost/v1/auth/x/callback";
export const ADMIN_KEYS = { alice: "alice-admin-key-0001", bob: "bob-admin-key-00002" };

export class FakeClock {
  constructor(public t: bigint, private readonly start: bigint = START) {}
  now = (): bigint => this.t;
  advance(seconds: bigint): void {
    this.t += seconds;
  }
  /** Moves to `seconds` after the start of mining day `day`. */
  at(day: bigint, seconds: bigint): void {
    this.t = this.start + day * DAY + seconds;
  }
}

/** In-memory distributor with the same rules that matter to the backend, checking real proofs. */
export class FakeChain implements ChainGateway {
  readonly chainId = 31337n;
  readonly distributor = DISTRIBUTOR;
  readonly balances = new Map<string, bigint>();
  readonly claimed = new Map<string, bigint>();
  readonly babt = new Map<string, bigint>();
  readonly drips: { recipient: Address; amount: bigint }[] = [];
  readonly events: DistributorEvent[] = [];
  active: RootInfo | null = null;
  pending: RootInfo | null = null;
  block = 1n;
  challengeDelay = 12n * 3600n;
  /** Receipts by transaction hash, as sentTx reads them. A hash that is not here has no receipt. */
  readonly receipts = new Map<string, TxOutcome>();
  /**
   * How the next claimMany goes wrong, once. "down": the RPC fails before anything is sent.
   * "refused": the contract refuses it before it is sent. "reverted": sent and reverted.
   * "unconfirmed": sent and mined, but the wait for the receipt times out. "lost": sent, never mined.
   */
  nextClaim: "down" | "refused" | "reverted" | "unconfirmed" | "lost" | null = null;
  /** Errors the next drips throw, in order, instead of paying. */
  readonly dripErrors: Error[] = [];

  constructor(private readonly clock: FakeClock, private readonly schedule: ScheduleParams) {}

  private promote(): void {
    if (this.pending && this.clock.now() >= this.pending.postedAt + this.challengeDelay) {
      this.active = this.pending;
      this.pending = null;
      this.events.push({ kind: "activated", day: this.active.day, root: this.active.root, block: ++this.block });
    }
  }

  async readSchedule() {
    return this.schedule;
  }
  async readDistributorConfig() {
    return { maxRewardPerDay: 90n * E18, maxDailyIncrease: 24_000_000n * E18, challengeDelay: this.challengeDelay };
  }
  async readRoots() {
    this.promote();
    return { active: this.active, pending: this.pending };
  }
  async proposeRoot(day: bigint, root: Hex, total: bigint, dataHash: Hex): Promise<Hex> {
    this.promote();
    if (this.pending) throw new Error("RootPending");
    if (this.active && day <= this.active.day) throw new Error("DayNotIncreasing");
    this.pending = { root, day, postedAt: this.clock.now(), totalEntitled: total, dataHash };
    this.events.push({ kind: "proposed", day, root, block: ++this.block });
    return `0x${"ab".repeat(32)}` as Hex;
  }
  async claimMany(items: ClaimItem[], onSent?: (txHash: Hex) => Promise<void>) {
    this.promote();
    const fault = this.nextClaim;
    this.nextClaim = null;
    if (fault === "down") throw new Error("rpc down");
    if (fault === "refused") throw new TxError("refused", "EnforcedPause");
    const txHash = `0x${this.block.toString(16).padStart(64, "0")}` as Hex;
    await onSent?.(txHash);
    if (fault === "lost") throw new TxError("unconfirmed", `no receipt for ${txHash}`, txHash);
    if (fault === "reverted") {
      this.receipts.set(txHash, { success: false, events: [] });
      throw new TxError("reverted", `transaction ${txHash} reverted`, txHash);
    }
    const out: DistributorEvent[] = [];
    const block = ++this.block;
    for (const i of items) {
      const ok =
        this.active !== null &&
        StandardMerkleTree.verify(this.active.root, [...LEAF_ENCODING], [this.chainId.toString(), this.distributor, getAddress(i.account), i.cumulative.toString()], i.proof);
      const already = this.claimed.get(i.account.toLowerCase()) ?? 0n;
      if (!ok || i.cumulative <= already) {
        out.push({ kind: "skipped", account: i.account, cumulative: i.cumulative, reason: ok ? 4 : 2, block, txHash });
        continue;
      }
      this.claimed.set(i.account.toLowerCase(), i.cumulative);
      this.balances.set(i.account.toLowerCase(), (this.balances.get(i.account.toLowerCase()) ?? 0n) + i.cumulative - already);
      out.push({ kind: "claimed", account: i.account, amount: i.cumulative - already, cumulative: i.cumulative, day: this.active!.day, block, txHash });
    }
    this.events.push(...out);
    this.receipts.set(txHash, { success: true, events: out });
    if (fault === "unconfirmed") throw new TxError("unconfirmed", `no receipt for ${txHash}`, txHash);
    return { txHash, events: out };
  }
  async sentTx(hash: Hex): Promise<TxOutcome | null> {
    return this.receipts.get(hash) ?? null;
  }
  async dripFaucet(recipient: Address, amount: bigint): Promise<Hex> {
    const fault = this.dripErrors.shift();
    if (fault) throw fault;
    this.drips.push({ recipient, amount });
    return `0x${"cd".repeat(32)}` as Hex;
  }
  async latestBlock() {
    return this.block;
  }
  async distributorEvents(from: bigint, to: bigint) {
    return this.events.filter((e) => e.block >= from && e.block <= to);
  }
  async babtBalance(address: Address) {
    return this.babt.get(address.toLowerCase()) ?? 0n;
  }
  async verifySignature(address: Address, message: string, signature: Hex) {
    return verifyMessage({ address, message, signature });
  }
  health: ChainHealth = {
    block: 0n, blockTime: 0n, paused: false, publisherBalance: 5n * E18, relayerBalance: 5n * E18, vaultBalance: 1_000_000_000n * E18, faucetBalance: 10_000n * E18,
  };
  transfers: RewardTransfer[] = [];
  failedTxs = new Set<string>();
  contracts = new Set<string>();
  async rewardTransfers(from: bigint, to: bigint) {
    return this.transfers.filter((t) => t.block >= from && t.block <= to);
  }
  async transactionSucceeded(hash: Hex) {
    return !this.failedTxs.has(hash);
  }
  async isContract(address: Address) {
    return this.contracts.has(address.toLowerCase());
  }
  rewardTokenInfo: RewardToken | null = { address: "0x00000000000000000000000000000000000071c0", name: "LONGYU Testnet Token", symbol: "tLONG", decimals: 18 };
  async rewardToken() {
    return this.rewardTokenInfo;
  }
  async healthSnapshot(): Promise<ChainHealth> {
    return { ...this.health, block: this.block, blockTime: this.health.blockTime || this.clock.now() };
  }
}

export const SCHEDULE: ScheduleParams = {
  startTime: START,
  initialDailyBudget: 12_000_000n * E18,
  periodDays: 30n,
  decayBps: 0n,
  totalCap: 4_000_000_000n * E18,
};

export interface TestEnv {
  app: FastifyInstance;
  deps: Deps;
  clock: FakeClock;
  chain: FakeChain;
  x: DevX;
  /** Ops notices sent so far, oldest first. */
  notices: { subject: string; text: string }[];
  pushes: { to: string; title: string; body: string }[];
  close(): Promise<void>;
}

export async function makeEnv(
  opts: { clock?: FakeClock; chain?: ChainGateway; schedule?: ScheduleParams; rewards?: RewardParams; env?: Record<string, string>; payments?: PaymentChain; l1?: L1Watch } = {},
): Promise<TestEnv> {
  const clock = opts.clock ?? new FakeClock(START + 3600n);
  const schedule = opts.schedule ?? SCHEDULE;
  const chain = (opts.chain ?? new FakeChain(clock, schedule)) as FakeChain;
  const x = new DevX(X_CALLBACK);
  const notices: TestEnv["notices"] = [];
  const notifier: Notifier = { notify: async (subject, text) => void notices.push({ subject, text }) };
  const pushes: TestEnv["pushes"] = [];
  const push: PushSender = { send: async (m) => void pushes.push(...m) };
  const dataDir = mkdtempSync(join(tmpdir(), "longyu-api-"));
  const config = loadConfig({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret-0123456789-0123456789-xyz",
    ACCESS_TOKEN_TTL_SECONDS: String(30 * 86_400),
    RPC_URL: "http://127.0.0.1:1",
    CHAIN_ID: "31337",
    DISTRIBUTOR_ADDRESS: DISTRIBUTOR,
    FAUCET_ADDRESS: FAUCET,
    ALLOW_DEV_ATTESTATION: "true",
    ALLOW_DEV_VERIFICATION: "true",
    ALLOW_DEV_X_LOGIN: "true",
    VERIFICATION_WEBHOOK_SECRET: "whsec-0123456789abcdef",
    ADMIN_KEYS: `alice:${sha256PlainHex(ADMIN_KEYS.alice)},bob:${sha256PlainHex(ADMIN_KEYS.bob)}`,
    DATA_DIR: dataDir,
    ...opts.env,
  });
  const db = await createPgliteDb();
  await migrate(db, clock.now());
  const deps: Deps = {
    config,
    db,
    clock,
    chain,
    schedule,
    rewards: opts.rewards ?? TESTNET_LAUNCH_PARAMS,
    attestation: createAttestation({ allowDev: true }),
    captcha: devCaptcha,
    x,
    notifier,
    push,
    files: localFileStore(dataDir, "http://localhost/data"),
    payments: opts.payments,
    l1: opts.l1,
  };
  clearRootCache();
  const app = await buildApp(deps, { rateLimit: false });
  return { app, deps, clock, chain, x, notices, pushes, close: async () => { await app.close(); await db.close(); } };
}

export interface TestUser {
  /** The X username the user signed in with. */
  name: string;
  xId: string;
  token: string;
  refresh: string;
  wallet: ReturnType<typeof privateKeyToAccount>;
  installId: string;
}

export async function call<T = Record<string, unknown>>(
  env: TestEnv,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: T }> {
  const res = await env.app.inject({ method, url, payload: body as never, headers: { "content-type": "application/json", ...headers } });
  return { status: res.statusCode, json: (res.body ? JSON.parse(res.body) : {}) as T };
}

/** A GET whose answer is not JSON (the sign-in callback): status, headers and the body as text. */
export async function raw(env: TestEnv, url: string, headers: Record<string, string> = {}) {
  const res = await env.app.inject({ method: "GET", url, headers });
  return { status: res.statusCode, headers: res.headers, body: res.body };
}

export const auth = (u: { token: string }) => ({ authorization: `Bearer ${u.token}` });

/** The X account behind a test user's name: the id is derived from the name. */
export const xAccount = (name: string): XAccount => ({
  id: (BigInt(`0x${createHash("sha256").update(name).digest("hex").slice(0, 12)}`) + 1n).toString(),
  username: name,
  avatar: null,
});

/** Starts a sign-in with X as the app does: keeps a random verifier and sends only its hash. */
export async function startX(env: TestEnv, purpose: "sign-in" | "wallet-change" = "sign-in", headers: Record<string, string> = {}) {
  const appVerifier = randomBytes(32).toString("base64url");
  const r = await call<{ authorizeUrl: string }>(env, "POST", "/v1/auth/x/start", { appChallenge: pkceChallenge(appVerifier), purpose }, headers);
  if (r.status !== 200) throw new Error(`start failed: ${JSON.stringify(r.json)}`);
  return { appVerifier, authorizeUrl: r.json.authorizeUrl, state: new URL(r.json.authorizeUrl).searchParams.get("state")! };
}

/** The browser coming back from X to the callback: approved as `account`, or with X's error. */
export async function xCallback(env: TestEnv, state: string, account: Pick<XAccount, "id" | "username"> | { error: string }) {
  const query = "error" in account
    ? `error=${encodeURIComponent(account.error)}`
    : `code=${encodeURIComponent(`dev:${account.id}:${account.username}`)}`;
  const res = await raw(env, `/v1/auth/x/callback?state=${encodeURIComponent(state)}&${query}`);
  const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
  return { ...res, location, ticket: (location && new URL(location).searchParams.get("ticket")) || undefined };
}

/**
 * Start and callback together: what the app holds once X has approved `account`. An account that
 * signed in a moment ago waits out the cool-off first (the clock moves), as a person would.
 */
export async function xTicket(
  env: TestEnv,
  account: Pick<XAccount, "id" | "username">,
  purpose: "sign-in" | "wallet-change" = "sign-in",
  headers: Record<string, string> = {},
): Promise<{ ticket: string; appVerifier: string }> {
  const last = (await env.deps.db.query<{ at: bigint | null }>(
    "SELECT max(consumed_at) AS at FROM x_logins WHERE x_id = $1 AND purpose = $2",
    [account.id, purpose],
  )).rows[0]?.at ?? null;
  if (last !== null && env.clock.now() < toBig(last) + X_ACCOUNT_COOLOFF) env.clock.t = toBig(last) + X_ACCOUNT_COOLOFF;
  const flow = await startX(env, purpose, headers);
  const back = await xCallback(env, flow.state, account);
  if (!back.ticket) throw new Error(`no ticket: ${back.status} ${back.location ?? back.body}`);
  return { ticket: back.ticket, appVerifier: flow.appVerifier };
}

/** Signs in with X as `name` (the development provider), creating the account the first time. */
export async function signUp(env: TestEnv, name: string, installId = `install-${name}`): Promise<TestUser> {
  const account = xAccount(name);
  const r = await call<{ accessToken: string; refreshToken: string }>(env, "POST", "/v1/auth/x/finish", {
    ...(await xTicket(env, account)), installId, platform: "android",
  });
  if (r.status !== 200) throw new Error(`sign-up failed: ${JSON.stringify(r.json)}`);
  return { name, xId: account.id, token: r.json.accessToken, refresh: r.json.refreshToken, wallet: privateKeyToAccount(generatePrivateKey()), installId };
}

export async function attest(env: TestEnv, u: TestUser): Promise<void> {
  const c = await call<{ challengeId: string; nonce: string }>(env, "POST", "/v1/device/challenge", {}, auth(u));
  const r = await call(env, "POST", "/v1/device/attest", { challengeId: c.json.challengeId, token: `dev:${c.json.nonce}` }, auth(u));
  if (!r.json.attested) throw new Error(`attest failed: ${JSON.stringify(r.json)}`);
}

export async function siwe(env: TestEnv, u: TestUser, account = u.wallet, chainId = 31337, path = "/v1/wallet/challenge") {
  const c = await call<{ nonce: string }>(env, "POST", path, {}, auth(u));
  const message = createSiweMessage({
    address: account.address,
    chainId,
    domain: "longyu.network",
    nonce: c.json.nonce,
    uri: "https://longyu.network",
    version: "1",
    issuedAt: new Date(Number(env.clock.now()) * 1000),
  });
  return { message, signature: await account.signMessage({ message }) };
}

export async function linkWallet(env: TestEnv, u: TestUser, account = u.wallet) {
  const s = await siwe(env, u, account);
  return call(env, "POST", "/v1/wallet/link", s, auth(u));
}

/** Changes an already-linked wallet: a fresh sign-in with X as the same account, then a signed SIWE message. */
export async function changeWallet(env: TestEnv, u: TestUser, account: ReturnType<typeof privateKeyToAccount>) {
  const appVerifier = randomBytes(32).toString("base64url");
  const start = await call<{ authorizeUrl: string }>(
    env, "POST", "/v1/auth/x/start", { appChallenge: pkceChallenge(appVerifier), purpose: "wallet-change" }, auth(u),
  );
  if (start.status !== 200) return start as { status: number; json: Record<string, unknown> };
  const back = await xCallback(env, new URL(start.json.authorizeUrl).searchParams.get("state")!, { id: u.xId, username: u.name });
  const s = await siwe(env, u, account);
  return call(env, "POST", "/v1/wallet/link", { ...s, reauthTicket: back.ticket, appVerifier }, auth(u));
}

export async function verifyDev(env: TestEnv, u: TestUser, key = u.name) {
  await call(env, "POST", "/v1/verification/session", {}, auth(u));
  return call<{ result: string }>(env, "POST", "/v1/verification/dev/approve", { uniqueKey: key }, auth(u));
}

export async function mine(env: TestEnv, u: TestUser): Promise<{ status: number; json: Record<string, unknown> }> {
  const c = await call<{ challengeId: string; nonce: string }>(env, "POST", "/v1/mining/challenge", {}, auth(u));
  if (c.status !== 200) return c;
  return call(env, "POST", "/v1/mining/start", {
    challengeId: c.json.challengeId,
    attestationToken: `dev:${c.json.nonce}`,
    captchaToken: "dev-pass",
  }, auth(u));
}

/** A user who is attested, has a wallet and (optionally) is verified to T2. */
export async function readyUser(env: TestEnv, name: string, verified = true, installId?: string): Promise<TestUser> {
  const u = await signUp(env, name, installId);
  await attest(env, u);
  const l = await linkWallet(env, u);
  if (l.status !== 200) throw new Error(`link failed: ${JSON.stringify(l.json)}`);
  if (verified) await verifyDev(env, u);
  return u;
}
