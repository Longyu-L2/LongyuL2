/**
 * Local devnet: starts Anvil, deploys the mining contracts and writes apps/api/.env.devnet.
 *
 *   npx tsx scripts/devnet.ts          # from apps/api; leaves Anvil running
 *   node --env-file=.env.devnet --import tsx src/server.ts
 *
 * Then point the app at the API: EXPO_PUBLIC_API_URL=http://<your LAN IP>:8080 and
 * EXPO_PUBLIC_DEV_ATTESTATION=true. Development keys below are generated fresh each run and are
 * only for this local chain.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Abi, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  emissionScheduleAbi, emissionScheduleBytecode, faucetAbi, faucetBytecode, longTokenAbi, longTokenBytecode,
  miningDistributorAbi, miningDistributorBytecode, miningVaultAbi, miningVaultBytecode,
} from "@longyu/abis";

const E18 = 10n ** 18n;

export async function startDevnet(opts: { port?: number; host?: string } = {}): Promise<{ env: Record<string, string>; stop: () => void }> {
  const PORT = opts.port ?? 8545;
  const RPC = `http://127.0.0.1:${PORT}`;
  const anvil = spawn("anvil", ["--port", String(PORT), "--host", opts.host ?? "127.0.0.1", "--silent"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  const stop = () => {
    if (!anvil.pid) return;
    // On Windows anvil runs under a shell; kill the whole process tree, not just the shell.
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(anvil.pid), "/T", "/F"], { stdio: "ignore" });
    else anvil.kill();
    anvil.unref();
  };
  try {
    return { env: await deployDevnet(RPC), stop };
  } catch (e) {
    stop();
    throw e;
  }
}

async function deployDevnet(RPC: string): Promise<Record<string, string>> {
  const transport = http(RPC);
  const pub = createPublicClient({ chain: foundry, transport });
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport });
  for (let i = 0; ; i++) {
    try {
      await pub.getBlockNumber({ cacheTime: 0 });
      break;
    } catch {
      if (i > 100) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const keys = { admin: generatePrivateKey(), publisher: generatePrivateKey(), relayer: generatePrivateKey(), faucetSigner: generatePrivateKey() };
  const accounts = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<keyof typeof keys, ReturnType<typeof privateKeyToAccount>>;
  for (const a of Object.values(accounts)) await testClient.setBalance({ address: a.address, value: parseEther("1000") });
  const admin = createWalletClient({ account: accounts.admin, chain: foundry, transport });
  const deploy = async (abi: Abi, bytecode: Hex, args: unknown[]): Promise<Address> => {
    const hash = await admin.deployContract({ abi, bytecode, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const write = async (address: Address, abi: Abi, functionName: string, args: unknown[]) => {
    await pub.waitForTransactionReceipt({ hash: await admin.writeContract({ address, abi, functionName, args } as never) });
  };

  const zero = "0x0000000000000000000000000000000000000000";
  const now = (await pub.getBlock()).timestamp;
  const start = (now / 86_400n) * 86_400n; // today, UTC midnight
  // As on LONGYU: rewards in a tLONG token, gas and faucet drips in the native token (BNB there).
  const tlong = await deploy(longTokenAbi, longTokenBytecode, ["LONGYU Testnet Token", "tLONG", 4_000_000_000n * E18, accounts.admin.address]);
  const schedule = await deploy(emissionScheduleAbi, emissionScheduleBytecode, [start, 12_000_000n * E18, 30n, 0n, 4_000_000_000n * E18]);
  const vault = await deploy(miningVaultAbi, miningVaultBytecode, [tlong, schedule, accounts.admin.address]);
  const distributor = await deploy(miningDistributorAbi, miningDistributorBytecode, [
    tlong, schedule, 90n * E18, 3600n, 24_000_000n * E18, accounts.admin.address, accounts.publisher.address, accounts.admin.address, zero,
  ]);
  const faucet = await deploy(faucetAbi, faucetBytecode, [zero, accounts.admin.address, accounts.faucetSigner.address, accounts.admin.address, parseEther("0.001"), 86_400n, parseEther("10")]);
  await write(vault, miningVaultAbi, "setDistributor", [distributor]);
  await write(distributor, miningDistributorAbi, "setVault", [vault]);
  await write(tlong, longTokenAbi, "transfer", [vault, 1_000_000_000n * E18]);
  await testClient.setBalance({ address: faucet, value: parseEther("100") });

  const env: Record<string, string> = {
    NODE_ENV: "development",
    PORT: "8080",
    PGLITE_DIR: "./.devnet-db",
    JWT_SECRET: randomBytes(32).toString("hex"),
    RPC_URL: RPC,
    CHAIN_ID: "31337",
    DISTRIBUTOR_ADDRESS: distributor,
    FAUCET_ADDRESS: faucet,
    PUBLISHER_KEY: keys.publisher,
    RELAYER_KEY: keys.relayer,
    FAUCET_SIGNER_KEY: keys.faucetSigner,
    ALLOW_DEV_ATTESTATION: "true",
    ALLOW_DEV_VERIFICATION: "true",
    ALLOW_DEV_X_LOGIN: "true",
    RUN_JOBS: "true",
    DATA_DIR: "./.devnet-data",
    PUBLIC_DATA_BASE_URL: "http://localhost:8080/data",
    EXPLORER_URL: "http://localhost:4000",
  };
  return env;
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/devnet.ts");
if (isMain) {
  const { env } = await startDevnet({ port: Number(process.env.DEVNET_PORT ?? 8545), host: "0.0.0.0" });
  const file = fileURLToPath(new URL("../.env.devnet", import.meta.url));
  writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  console.log(`Devnet ready on ${env.RPC_URL}. Distributor ${env.DISTRIBUTOR_ADDRESS}. Wrote ${file}.`);
  console.log("Start the API: node --env-file=.env.devnet --import tsx src/server.ts");
  console.log("Anvil keeps running; press Ctrl+C to stop.");
}
