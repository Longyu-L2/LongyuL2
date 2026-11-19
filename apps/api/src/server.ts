import { mkdirSync } from "node:fs";
import type { Address, Hex, LocalAccount } from "viem";
import { TESTNET_LAUNCH_PARAMS } from "@longyu/reward-engine";
import { buildApp } from "./app.ts";
import { loadConfig, type Config } from "./config.ts";
import type { Deps } from "./context.ts";
import { createPgDb, createPgliteDb } from "./db/index.ts";
import { migrate } from "./db/migrate.ts";
import { startJobs } from "./jobs/runner.ts";
import { systemClock } from "./lib/util.ts";
import { androidKeyAttestation, googleRevocationList } from "./services/android-attestation.ts";
import { createAttestation, PlayIntegrity } from "./services/attestation.ts";
import { createViemChain } from "./services/chain.ts";
import {
  DevX, devCaptcha, expoPush, localFileStore, logNotifier, noX, s3Client, s3FileStore, telegramNotifier, turnstile, xOAuth,
  type FileStore, type XProvider,
} from "./services/external.ts";
import { kmsAccount, kmsClient, localAccount, remoteAccounts, type RemoteAccounts } from "./services/signer.ts";
import { createL1Watch, parseL1Watch } from "./services/l1.ts";
import { createPaymentChain, paymentConfig } from "./services/payments.ts";

async function signer(config: Config, key: Hex | undefined, kmsKeyId: string | undefined): Promise<LocalAccount | undefined> {
  if (kmsKeyId) {
    if (!config.KMS_REGION) throw new Error("KMS_REGION is required with KMS keys");
    return kmsAccount(kmsClient(config.KMS_REGION), kmsKeyId);
  }
  if (key && config.NODE_ENV === "production") throw new Error("raw private keys are not allowed in production; use the signer service or KMS");
  return key ? localAccount(key) : undefined;
}

/**
 * The publisher, relayer and faucet-signer accounts. With SIGNER_URL they are the signer service's:
 * it holds the keys and must be bound to this chain, distributor and faucet, or the API does not
 * start. Otherwise KMS keys, or raw keys outside production.
 */
export async function signers(config: Config, fetchImpl?: typeof fetch): Promise<RemoteAccounts> {
  if (config.SIGNER_URL || config.SIGNER_TOKEN) {
    if (!config.SIGNER_URL || !config.SIGNER_TOKEN) throw new Error("SIGNER_URL and SIGNER_TOKEN are set together");
    if (config.PUBLISHER_KEY || config.RELAYER_KEY || config.FAUCET_SIGNER_KEY) throw new Error("SIGNER_URL replaces the signing keys");
    return remoteAccounts({
      url: config.SIGNER_URL,
      token: config.SIGNER_TOKEN,
      chainId: Number(config.CHAIN_ID),
      distributor: config.DISTRIBUTOR_ADDRESS as Address,
      faucet: config.FAUCET_ADDRESS as Address | undefined,
      fetch: fetchImpl,
    });
  }
  return {
    publisher: await signer(config, config.PUBLISHER_KEY as Hex | undefined, config.KMS_PUBLISHER_KEY_ID),
    relayer: await signer(config, config.RELAYER_KEY as Hex | undefined, config.KMS_RELAYER_KEY_ID),
    faucetSigner: await signer(config, config.FAUCET_SIGNER_KEY as Hex | undefined, config.KMS_FAUCET_SIGNER_KEY_ID),
  };
}

export async function createDeps(config: Config): Promise<Deps> {
  const db = config.DATABASE_URL ? createPgDb(config.DATABASE_URL) : await createPgliteDb(config.PGLITE_DIR);
  await migrate(db, systemClock.now());

  const chain = createViemChain({
    rpcUrl: config.RPC_URL,
    chainId: config.CHAIN_ID,
    chainName: config.CHAIN_NAME,
    nativeSymbol: config.NATIVE_SYMBOL,
    distributor: config.DISTRIBUTOR_ADDRESS as Address,
    faucet: config.FAUCET_ADDRESS as Address | undefined,
    ...(await signers(config)),
    bscRpcUrl: config.BSC_RPC_URL,
    babtAddress: config.BABT_ADDRESS as Address,
  });

  const playIntegrity = config.GOOGLE_SERVICE_ACCOUNT_JSON
    ? new PlayIntegrity(config.ANDROID_PACKAGE, JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_JSON))
    : undefined;
  const appAttest = config.APPLE_TEAM_ID
    ? { teamId: config.APPLE_TEAM_ID, bundleId: config.APPLE_BUNDLE_ID, allowDevelopment: config.NODE_ENV !== "production" }
    : undefined;

  return {
    config,
    db,
    clock: systemClock,
    chain,
    schedule: await chain.readSchedule(),
    rewards: TESTNET_LAUNCH_PARAMS,
    attestation: createAttestation({ allowDev: config.ALLOW_DEV_ATTESTATION, playIntegrity, androidKey: androidKey(config), appAttest }),
    captcha: config.TURNSTILE_SECRET ? turnstile(config.TURNSTILE_SECRET) : devCaptcha,
    x: xProvider(config),
    notifier: config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID ? telegramNotifier(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID) : logNotifier,
    push: expoPush(),
    files: fileStore(config),
    payments: payments(config),
    l1: config.L1_RPC_URL && config.L1_WATCH ? createL1Watch({ rpcUrl: config.L1_RPC_URL, accounts: parseL1Watch(config.L1_WATCH) }) : undefined,
  };
}

/**
 * X itself when its settings are present. The development stand-in only when asked for by name and
 * never in production; with neither, sign-in is refused rather than quietly replaced.
 */
export function xProvider(config: Config): XProvider {
  if (config.X_CLIENT_ID && config.X_CLIENT_SECRET && config.X_REDIRECT_URI) {
    return xOAuth({ clientId: config.X_CLIENT_ID, clientSecret: config.X_CLIENT_SECRET, redirectUri: config.X_REDIRECT_URI });
  }
  if (config.NODE_ENV === "production") throw new Error("X sign-in is not configured");
  if (config.ALLOW_DEV_X_LOGIN) return new DevX(config.X_REDIRECT_URI ?? `http://localhost:${config.PORT}/v1/auth/x/callback`);
  return noX;
}

function androidKey(config: Config) {
  if (!config.ANDROID_SIGNING_CERT_SHA256) return undefined;
  return androidKeyAttestation({
    packageName: config.ANDROID_PACKAGE,
    signingCertDigests: config.ANDROID_SIGNING_CERT_SHA256.split(","),
    revocation: googleRevocationList(),
  });
}

function payments(config: Config) {
  const cfg = paymentConfig(config);
  return cfg ? createPaymentChain({ rpcUrl: config.PAYMENT_RPC_URL ?? config.BSC_RPC_URL, chainId: cfg.chainId, finality: cfg.finality }) : undefined;
}

export function fileStore(config: Config): FileStore {
  if (config.STORAGE_BUCKET) {
    const client = s3Client({
      bucket: config.STORAGE_BUCKET,
      region: config.STORAGE_REGION,
      endpoint: config.STORAGE_ENDPOINT,
      accessKeyId: config.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
    });
    return s3FileStore(client, config.STORAGE_BUCKET, config.PUBLIC_DATA_BASE_URL);
  }
  mkdirSync(config.DATA_DIR, { recursive: true });
  return localFileStore(config.DATA_DIR, config.PUBLIC_DATA_BASE_URL);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = await createDeps(config);
  const app = await buildApp(deps, { logger: true });
  if (deps.x === noX) app.log.warn("X_CLIENT_ID, X_CLIENT_SECRET and X_REDIRECT_URI are not set: nobody can sign in");
  if (deps.x instanceof DevX) app.log.warn("ALLOW_DEV_X_LOGIN is on: anyone can sign in as any X account");
  if (config.RUN_JOBS) startJobs(deps, (msg, err) => app.log.error({ err }, msg));
  await app.listen({ host: "0.0.0.0", port: config.PORT });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
