/**
 * Starts LONGYU Scan: checks the node is the configured chain, prepares the database, runs the
 * indexer in the background and serves the site. One instance runs the indexer.
 */
import { loadConfig } from "./config.ts";
import { createPgDb, createPgliteDb, ensureDatabase, migrate } from "./db.ts";
import { Indexer, runIndexer } from "./indexer.ts";
import { httpRpc, type Hex } from "./rpc.ts";
import { buildApp } from "./app.ts";

const config = loadConfig();
const rpc = httpRpc(config.RPC_URL);
const chainId = BigInt(await rpc.call<Hex>("eth_chainId", []));
if (chainId !== config.CHAIN_ID) throw new Error(`RPC_URL serves chain ${chainId}, not CHAIN_ID ${config.CHAIN_ID}`);

const url = config.DATABASE_URL && config.EXPLORER_DATABASE ? await ensureDatabase(config.DATABASE_URL, config.EXPLORER_DATABASE) : config.DATABASE_URL;
const db = url ? createPgDb(url) : await createPgliteDb(config.PGLITE_DIR);
const applied = await migrate(db);
if (applied.length) console.log(`explorer: applied ${applied.join(", ")}`);

const app = await buildApp({ db, rpc, config });
const stop = config.RUN_INDEXER
  ? runIndexer(new Indexer(db, rpc, { startBlock: config.START_BLOCK, batchSize: config.BATCH_SIZE, log: (m) => app.log.warn(m) }), config.POLL_MS, (m) => app.log.warn(m), config.PRUNE_EMPTY_AFTER_HOURS * 3600)
  : () => undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    stop();
    await app.close();
    await db.close();
    process.exit(0);
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
console.log(`LONGYU Scan on :${config.PORT} for chain ${chainId}`);
