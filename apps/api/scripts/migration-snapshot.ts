/**
 * Builds the testnet-to-mainnet migration snapshot from the API database.
 *
 *   SNAPSHOT_DAY=120 MIGRATION_CHAIN_ID=668800 MIGRATION_DISTRIBUTOR=0x... \
 *   DATABASE_URL=postgres://... npx tsx scripts/migration-snapshot.ts
 *
 * Optional: POOL (wei, default 500,000,000 LONG), MIN_DAYS (default 30), EXCLUDED_COUNTRIES
 * (default CN,KP,IR,CU,SY), KYC_THRESHOLD (wei). BSC_RPC_URL and BABT_ADDRESS are read as the API
 * reads them: an account verified with a BABT counts only while its address still holds one, so the
 * snapshot reads BSC and stops if a read fails. Writes migration-day-N.json and prints the values
 * the admin multisig passes to MigrationDistributor.setRoot(root, totalAllocation, dataHash).
 * The deployed distributor's address is part of every leaf, so deploy it first.
 */
import { writeFileSync } from "node:fs";
import { getAddress, isAddress } from "viem";
import { ConfigSchema } from "../src/config.ts";
import { createPgDb, createPgliteDb } from "../src/db/index.ts";
import { computeMigration } from "../src/jobs/migration.ts";
import { createBabtReader } from "../src/services/chain.ts";
import type { Address } from "@longyu/reward-engine";

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const distributor = need("MIGRATION_DISTRIBUTOR");
if (!isAddress(distributor)) throw new Error("MIGRATION_DISTRIBUTOR is not an address");
const bsc = ConfigSchema.pick({ BSC_RPC_URL: true, BABT_ADDRESS: true }).parse(process.env);
const db = process.env.DATABASE_URL ? createPgDb(process.env.DATABASE_URL) : await createPgliteDb(process.env.PGLITE_DIR);
try {
  const result = await computeMigration(
    db,
    {
      snapshotDay: BigInt(need("SNAPSHOT_DAY")),
      pool: BigInt(process.env.POOL ?? (500_000_000n * 10n ** 18n).toString()),
      minMiningDays: Number(process.env.MIN_DAYS ?? 30),
      excludedCountries: (process.env.EXCLUDED_COUNTRIES ?? "CN,KP,IR,CU,SY").split(",").map((c) => c.trim()).filter(Boolean),
      kycThreshold: process.env.KYC_THRESHOLD ? BigInt(process.env.KYC_THRESHOLD) : null,
    },
    { chainId: BigInt(need("MIGRATION_CHAIN_ID")), distributor: getAddress(distributor) as Address },
    createBabtReader({ bscRpcUrl: bsc.BSC_RPC_URL, babtAddress: getAddress(bsc.BABT_ADDRESS) }),
  );
  const file = `migration-day-${result.rules.snapshotDay}.json`;
  writeFileSync(file, result.dataJson);
  console.log(`eligible: ${result.entries.length}, held for KYC: ${result.heldForKyc.length}`);
  console.log("excluded:", result.excluded);
  console.log(`setRoot(${result.root}, ${result.totalAllocated}, ${result.dataHash})`);
  console.log(`data file: ${file} (publish it before claims open)`);
} finally {
  await db.close();
}
