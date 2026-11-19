/**
 * Local demo for design work: starts Anvil, makes some activity (a token, transfers, a failed call,
 * payments), and serves LONGYU Scan on http://127.0.0.1:4000 with the indexer running.
 *
 *   npx tsx scripts/demo.ts        # from apps/explorer; Ctrl+C stops both
 *
 * Requires Foundry's `anvil` on PATH. Uses throwaway keys on a throwaway chain.
 */
import { spawn } from "node:child_process";
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, parseEther, type Hex } from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { longTokenAbi, longTokenBytecode } from "@longyu/abis";
import { buildApp } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { createPgliteDb, migrate } from "../src/db.ts";
import { Indexer, runIndexer } from "../src/indexer.ts";
import { httpRpc } from "../src/rpc.ts";

const PORT = Number(process.env.DEMO_ANVIL_PORT ?? 8551);
const RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn("anvil", ["--port", String(PORT), "--silent", "--block-time", "2"], { stdio: "ignore", shell: process.platform === "win32" });
const stopAnvil = () => (process.platform === "win32" ? spawn("taskkill", ["/pid", String(anvil.pid), "/T", "/F"]) : anvil.kill());
process.once("SIGINT", () => {
  stopAnvil();
  process.exit(0);
});

const transport = http(RPC);
const pub = createPublicClient({ chain: foundry, transport });
for (let i = 0; ; i++) {
  try {
    await pub.getBlockNumber({ cacheTime: 0 });
    break;
  } catch {
    if (i > 100) throw new Error("anvil did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}
const test = createTestClient({ chain: foundry, mode: "anvil", transport });
const people = Array.from({ length: 6 }, () => privateKeyToAccount(generatePrivateKey()));
for (const p of people) await test.setBalance({ address: p.address, value: parseEther("25") });
const wallets = people.map((account) => createWalletClient({ account, chain: foundry, transport }));
const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash });

const tlong = (await wait(await wallets[0]!.deployContract({ abi: longTokenAbi, bytecode: longTokenBytecode, args: ["LONGYU Testnet Token", "tLONG", 4_000_000_000n * 10n ** 18n, people[0]!.address] }))).contractAddress!;
const usd = (await wait(await wallets[1]!.deployContract({ abi: longTokenAbi, bytecode: longTokenBytecode, args: ["Test Dollar", "TUSD", 1_000_000n * 10n ** 18n, people[1]!.address] }))).contractAddress!;
for (let i = 1; i < people.length; i++) {
  await wait(await wallets[0]!.writeContract({ address: tlong, abi: longTokenAbi, functionName: "transfer", args: [people[i]!.address, BigInt(1000 * i + 237) * 10n ** 18n] }));
  await wait(await wallets[i]!.sendTransaction({ to: people[(i + 1) % people.length]!.address, value: parseEther(`0.${i}5`) }));
}
await wait(await wallets[1]!.writeContract({ address: usd, abi: longTokenAbi, functionName: "transfer", args: [people[2]!.address, 420n * 10n ** 18n] }));
await wait(await wallets[3]!.sendTransaction({ to: tlong, gas: 100_000n, data: encodeFunctionData({ abi: longTokenAbi, functionName: "transfer", args: [people[4]!.address, 10n ** 40n] }) }));

const db = await createPgliteDb();
await migrate(db);
const rpc = httpRpc(RPC);
const config = ConfigSchema.parse({
  RPC_URL: RPC, CHAIN_ID: "31337", CHAIN_NAME: "LONGYU Testnet", NODE_ENV: "development",
  KNOWN_ADDRESSES: `${tlong}:tLONG token,${usd}:Test Dollar`, PUBLIC_RPC_URL: "https://rpc-testnet.longyu.network",
});
runIndexer(new Indexer(db, rpc, { startBlock: 0n, batchSize: 50 }), 1000, (m) => console.error(m));
const app = await buildApp({ db, rpc, config });
await app.listen({ port: 4000, host: "127.0.0.1" });
console.log(JSON.stringify({ url: "http://127.0.0.1:4000", tlong: tlong.toLowerCase(), usd: usd.toLowerCase(), alice: people[0]!.address.toLowerCase() }));
