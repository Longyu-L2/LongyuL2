/**
 * LONGYU's watchtower: runs apart from the API and the chain's own services, with keys of its own.
 * Every POLL_SECONDS it checks the state roots on BSC (challenger.ts) and the mining roots on LONGYU
 * (mining.ts), and serves the result at GET /health (503 while anything is critical).
 */
import { createServer } from "node:http";
import { addressOf, loadConfig } from "./config.ts";
import { dataFetcher, distributorView, oracleView, rpcRebuildView, verifierView } from "./chain.ts";
import { checkOutputs } from "./challenger.ts";
import { checkMining } from "./mining.ts";
import { fileCheckedSet, fileRootStore } from "./store.ts";
import { worst, type Check, type Log } from "./checks.ts";

const config = loadConfig();
const log: Log = (event, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
const now = () => BigInt(Math.floor(Date.now() / 1000));

const verifier = verifierView(config.VERIFIER_NODE_URL);
const fallback = config.FALLBACK_RPC_URL ? rpcRebuildView(config.FALLBACK_RPC_URL) : undefined;
const oracle = oracleView(config);
const distributor = config.DISTRIBUTOR_ADDRESS ? distributorView(config, config.DISTRIBUTOR_ADDRESS) : null;
const checked = fileCheckedSet(config.STATE_DIR);
const store = fileRootStore(config.STATE_DIR);
const fetchText = dataFetcher(config.DATA_ORIGINS, config.MAX_DATA_BYTES);

/** Settings that can be wrong only through a mistake: refuse to run rather than guard the wrong thing. */
async function preflight(): Promise<Check[]> {
  const checks: Check[] = [];
  const ids = await verifier.chainIds();
  if (ids.l1 !== config.L1_CHAIN_ID || ids.l2 !== config.L2_CHAIN_ID) {
    throw new Error(`the node follows ${ids.l2} on ${ids.l1}, not ${config.L2_CHAIN_ID} on ${config.L1_CHAIN_ID}`);
  }
  const challenger = addressOf(config.CHALLENGER_KEY);
  const onChain = await oracle.challenger();
  if (challenger && challenger.toLowerCase() !== onChain.toLowerCase()) throw new Error(`CHALLENGER_KEY is ${challenger}, but the oracle's challenger is ${onChain}`);
  if (!challenger) checks.push({ name: "challenger key", status: "warning", detail: `Not set: wrong state roots are reported, not deleted (the oracle's challenger is ${onChain}).` });
  if (distributor) {
    const ready = await distributor.guardianReady();
    if (ready === false) throw new Error(`GUARDIAN_KEY (${addressOf(config.GUARDIAN_KEY)}) does not hold the distributor's guardian role`);
    if (ready === null) checks.push({ name: "guardian key", status: "warning", detail: "Not set: wrong mining roots are reported, not vetoed." });
  } else {
    checks.push({ name: "mining roots", status: "warning", detail: "DISTRIBUTOR_ADDRESS is not set: the mining watch is off." });
  }
  return checks;
}

const failures = new Map<string, number>();
/** A check that throws is a warning at first and critical after five minutes of failing. */
async function guarded(name: string, run: () => Promise<Check>): Promise<Check> {
  try {
    const c = await run();
    failures.delete(name);
    return c;
  } catch (e) {
    const n = (failures.get(name) ?? 0) + 1;
    failures.set(name, n);
    const detail = `Could not check: ${e instanceof Error ? e.message : String(e)}`;
    log("check_failed", { name, n, detail });
    return { name, status: n * config.POLL_SECONDS >= 300 ? "critical" : "warning", detail };
  }
}

let notes: Check[] = [];
let report: { status: string; checkedAt: string | null; checks: Check[] } = { status: "warning", checkedAt: null, checks: [{ name: "watchtower", status: "warning", detail: "Starting." }] };

async function tick(): Promise<void> {
  const checks = [
    await guarded("state roots on BSC", () => checkOutputs({ oracle, verifier, fallback, now, checked: checked.set, lateSeconds: config.OUTPUT_LATE_SECONDS, log })),
  ];
  checked.save();
  if (distributor) {
    checks.push(await guarded("mining roots", () => checkMining({
      distributor, store, fetchText, now, marginSeconds: config.VETO_MARGIN_SECONDS,
      newAccountsPerDay: config.NEW_ACCOUNTS_PER_DAY, freezesPerRoot: config.FREEZES_PER_ROOT, log,
    })));
    if (distributor.readsFromFallback()) {
      checks.push({ name: "mining reads", status: "warning", detail: "This node has not reached the distributor yet: the mining roots are read from the LONGYU RPC." });
    }
  }
  const all = [...notes, ...checks];
  const status = worst(all);
  if (status !== report.status) log("status", { status, checks: all.filter((c) => c.status !== "ok") });
  report = { status, checkedAt: new Date().toISOString(), checks: all };
}

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    res.writeHead(report.status === "critical" ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(report));
    return;
  }
  res.writeHead(404).end();
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

/** A setting that is wrong, as opposed to a node or endpoint not answering yet. */
const isMistake = (e: unknown) => e instanceof Error && /^(the node follows|CHALLENGER_KEY is|GUARDIAN_KEY \()/.test(e.message);

async function main(): Promise<void> {
  server.listen(config.PORT, config.HOST);
  // Its own node may still be starting: wait for it, and report that meanwhile.
  for (;;) {
    try {
      notes = await preflight();
      break;
    } catch (e) {
      if (isMistake(e)) throw e;
      const detail = `Waiting for its node or BSC: ${e instanceof Error ? e.message : String(e)}`;
      report = { status: "critical", checkedAt: new Date().toISOString(), checks: [{ name: "watchtower", status: "critical", detail }] };
      log("preflight_waiting", { detail });
      await new Promise((r) => setTimeout(r, config.POLL_SECONDS * 1000));
    }
  }
  log("listening", {
    port: config.PORT, l1: config.L1_CHAIN_ID, l2: config.L2_CHAIN_ID, oracle: config.L1_OUTPUT_ORACLE,
    distributor: config.DISTRIBUTOR_ADDRESS ?? null, challenger: addressOf(config.CHALLENGER_KEY), guardian: addressOf(config.GUARDIAN_KEY),
  });
  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, config.POLL_SECONDS * 1000));
  }
}

main().catch((e) => {
  log("fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
