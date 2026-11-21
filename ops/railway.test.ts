/**
 * Checks the Railway project (.railway/railway.ts) and the chain entrypoints without Railway:
 * the program evaluates to a consistent graph, every build file exists, the API's settings are all
 * declared (an undeclared variable would be deleted on apply) and pass production validation, and
 * the entrypoint scripts refuse bad settings and start each program with the expected flags.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRailwayContext, project } from "railway/iac";
import program from "../.railway/railway.ts";
import { ConfigSchema, loadConfig } from "../apps/api/src/config.ts";
import { ConfigSchema as ExplorerConfigSchema, loadConfig as loadExplorerConfig } from "../apps/explorer/src/config.ts";
import { ConfigSchema as SignerConfigSchema, loadConfig as loadSignerConfig } from "../apps/signer/src/config.ts";
import { loadConfig as loadRpcConfig } from "../chain/railway/rpc/src/config.ts";
import { parseConfig as parseBridgeConfig } from "../apps/web/src/bridge-core.ts";
import { parseSwapConfig } from "../apps/web/src/swap-core.ts";
import { parseSafeConfig } from "../apps/web/src/safe-core.ts";
import { parseLandingConfig } from "../apps/web/src/landing-core.ts";
// @ts-expect-error a plain JavaScript module without type declarations
import { landingPage } from "../apps/web/build.mjs";
// @ts-expect-error a plain JavaScript module without type declarations
import { parseLandingHosts, parseRedirect } from "../apps/web/server.mjs";
// @ts-expect-error a plain JavaScript module without type declarations
import { contentPolicy } from "../apps/mobile/site/server.mjs";

const root = new URL("../", import.meta.url);
const repo = (p: string) => new URL(p, root);

type Node = {
  address: string;
  type: string;
  name: string;
  build?: { dockerfilePath?: string; builder?: string };
  variables?: Record<string, { type: string; resource?: string; output?: string; value?: string }>;
  volumeMounts?: Record<string, unknown>;
  [k: string]: unknown;
};

async function graph() {
  const def = await program(createRailwayContext({ environment: "production" }), project);
  return def.resources as unknown as Node[];
}
const svc = (nodes: Node[], name: string) => {
  const n = nodes.find((r) => r.type === "service" && r.name === name);
  assert.ok(n, `service ${name}`);
  return n;
};
const literal = (v: unknown) => (v as { type: string; value?: string }).type === "literal" ? (v as { value: string }).value : undefined;

test("railway: the project evaluates to a consistent graph", async () => {
  const nodes = await graph();
  const addresses = new Set<string>();
  for (const n of nodes) {
    assert.ok(!addresses.has(n.address), `duplicate ${n.address}`);
    addresses.add(n.address);
  }
  assert.deepEqual(nodes.filter((n) => n.type === "service").map((n) => n.name).sort(),
    ["api", "explorer", "mine", "monitor", "op-batcher", "op-geth", "op-node", "op-proposer", "rpc", "signer", "web"]);
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n.variables ?? {})) {
      if (v.type === "reference") assert.ok(addresses.has(v.resource!), `${n.name}.${k} references missing ${v.resource}`);
    }
    // Build files exist, and what each Dockerfile copies exists (or is a documented deployment output).
    const path = n.build?.dockerfilePath;
    if (path) {
      assert.equal(n.build?.builder, "DOCKERFILE");
      assert.ok(existsSync(repo(path)), path);
      for (const m of readFileSync(repo(path), "utf8").matchAll(/^COPY (?!--from)(\S+) /gm)) {
        const src = m[1]!;
        if (src === "chain/testnet/genesis.json" || src === "chain/testnet/rollup.json") {
          assert.match(readFileSync(repo("chain/testnet/README.md"), "utf8"), new RegExp(src.split("/").pop()!.replace(".", "\\.")));
        } else if (src !== "ops/monitor") {
          assert.ok(existsSync(repo(src)), `${path} copies missing ${src}`);
        }
      }
    }
  }
  // Volumes are declared resources of the project, each attached to exactly one service.
  const attached = nodes.flatMap((n) => Object.values((n.volumeAttachments ?? {}) as Record<string, { volume: string; mountPath: string }>));
  assert.deepEqual(attached.map((a) => [a.volume, a.mountPath]).sort(), [["volume.monitor-data", "/app/data"], ["volume.op-geth-data", "/db"]]);
  for (const a of attached) assert.ok(addresses.has(a.volume), `${a.volume} is not a project resource`);
  // Literal ${{name.VAR}} references name services or buckets that exist.
  for (const n of nodes) {
    for (const v of Object.values(n.variables ?? {})) {
      for (const m of (literal(v) ?? "").matchAll(/\$\{\{([a-z0-9-]+)\.[A-Z_]+\}\}/g)) {
        assert.ok(addresses.has(`service.${m[1]}`) || addresses.has(`bucket.${m[1]}`), m[0]);
      }
    }
  }
});

test("railway: the data files are in the project's own bucket, and only the API holds its keys", async () => {
  const nodes = await graph();
  const buckets = nodes.filter((n) => n.type === "bucket");
  assert.deepEqual(buckets.map((b) => [b.address, b.name, (b.config as { region?: string }).region]), [["bucket.longyu-data", "longyu-data", "iad"]]);
  const api = svc(nodes, "api");
  const refs = { STORAGE_BUCKET: "BUCKET", STORAGE_ENDPOINT: "ENDPOINT", STORAGE_ACCESS_KEY_ID: "ACCESS_KEY_ID", STORAGE_SECRET_ACCESS_KEY: "SECRET_ACCESS_KEY" };
  for (const [name, output] of Object.entries(refs)) assert.equal(literal(api.variables![name]), `\${{longyu-data.${output}}}`, name);
  // A Railway bucket is private: the API serves the files from its own address.
  assert.equal(literal(api.variables!.STORAGE_PUBLIC_READ), "false");
  assert.match(literal(api.variables!.PUBLIC_DATA_BASE_URL)!, /^https:\/\/[a-z0-9.-]+\/data$/);
  for (const n of nodes.filter((r) => r.type === "service" && r.name !== "api")) {
    for (const [k, v] of Object.entries(n.variables ?? {})) assert.ok(!(literal(v) ?? "").includes("longyu-data."), `${n.name}.${k} reads the bucket`);
  }
});

test("railway: the API declares every setting and its literals pass production validation", async () => {
  const api = svc(await graph(), "api");
  const declared = new Set(Object.keys(api.variables ?? {}));
  // Development-only or refused in production: deliberately absent, so apply removes them if set.
  // Signing is the signer service's job here, so the API gets neither raw keys nor KMS key IDs.
  const absent = new Set([
    "PGLITE_DIR", "DATA_DIR", "PUBLISHER_KEY", "RELAYER_KEY", "FAUCET_SIGNER_KEY", "WATCH_KEY",
    "KMS_REGION", "KMS_PUBLISHER_KEY_ID", "KMS_RELAYER_KEY_ID", "KMS_FAUCET_SIGNER_KEY_ID",
    "ALLOW_DEV_ATTESTATION", "ALLOW_DEV_VERIFICATION", "ALLOW_DEV_X_LOGIN",
  ]);
  for (const key of Object.keys(ConfigSchema.shape)) {
    assert.ok(declared.has(key) || absent.has(key), `${key} is not declared in .railway/railway.ts`);
  }
  for (const key of absent) assert.ok(!declared.has(key), `${key} must not be set on Railway`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(api.variables ?? {})) {
    const l = literal(v);
    if (l !== undefined) env[k] = l.replace(/\$\{\{[^}]+\}\}/g, "op-geth.railway.internal");
  }
  // Stand-ins for what the founders enter in Railway.
  Object.assign(env, {
    DATABASE_URL: "postgres://u:p@postgres.railway.internal:5432/railway",
    JWT_SECRET: "j".repeat(48), ORIGIN_SECRET: "s".repeat(40), TURNSTILE_SECRET: "t",
    DISTRIBUTOR_ADDRESS: "0x0000000000000000000000000000000000000001",
    STORAGE_BUCKET: "longyu-data-abc123", STORAGE_ENDPOINT: "https://t3.storageapi.dev", STORAGE_ACCESS_KEY_ID: "k", STORAGE_SECRET_ACCESS_KEY: "s",
    X_CLIENT_ID: "x-client", X_CLIENT_SECRET: "x-secret", X_REDIRECT_URI: "https://api-testnet.longyu.network/v1/auth/x/callback",
    SIGNER_TOKEN: "t".repeat(40),
  });
  const config = loadConfig(env);
  assert.equal(config.NODE_ENV, "production");
  assert.equal(config.REQUIRE_COUNTRY, true);
  assert.equal(config.RPC_URL, "http://op-geth.railway.internal:8545");
  assert.equal(config.SIGNER_URL, "http://op-geth.railway.internal:8080");
  // Production signs through the signer or KMS: without either, the API does not start.
  const { SIGNER_URL: _url, SIGNER_TOKEN: _token, ...unsigned } = env;
  assert.throws(() => loadConfig(unsigned), /SIGNER_URL/);
});

test("railway: the explorer's settings pass its production validation", async () => {
  const explorer = svc(await graph(), "explorer");
  const declared = new Set(Object.keys(explorer.variables ?? {}));
  // Tuning knobs keep their defaults; PGLITE_DIR is development only.
  const optional = new Set(["HOST", "START_BLOCK", "BATCH_SIZE", "POLL_MS", "RUN_INDEXER", "RATE_LIMIT", "PGLITE_DIR", "VERIFY_DAILY_BYTES", "COMPILER_CACHE_DIR"]);
  for (const key of Object.keys(ExplorerConfigSchema.shape)) {
    assert.ok(declared.has(key) || optional.has(key), `explorer: ${key} is not declared in .railway/railway.ts`);
  }
  assert.ok(!declared.has("PGLITE_DIR"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(explorer.variables ?? {})) {
    const l = literal(v);
    if (l !== undefined) env[k] = l.replace(/\$\{\{[^}]+\}\}/g, "op-geth.railway.internal");
  }
  Object.assign(env, { DATABASE_URL: "postgres://u:p@postgres.railway.internal:5432/railway", TRUST_PROXY: "173.245.48.0/20", KNOWN_ADDRESSES: "" });
  const config = loadExplorerConfig(env);
  assert.equal(config.NODE_ENV, "production");
  assert.equal(config.EXPLORER_DATABASE, "explorer_2");
  assert.equal(config.RPC_URL, "http://op-geth.railway.internal:8545");
});

test("railway: the public RPC gateway declares every setting, and only it faces the public for the chain", async () => {
  const nodes = await graph();
  const rpc = svc(nodes, "rpc");
  const declared = new Set(Object.keys(rpc.variables ?? {}));
  const source = readFileSync(repo("chain/railway/rpc/src/config.ts"), "utf8");
  const read = new Set([...source.matchAll(/env\.([A-Z_]+)|int\(env, "([A-Z_]+)"/g)].map((m) => m[1] ?? m[2]!));
  assert.ok(read.has("UPSTREAM_URL") && read.has("RATE_BURST"), "settings found in config.ts");
  for (const key of read) assert.ok(declared.has(key) || key === "HOST", `rpc: ${key} is not declared in .railway/railway.ts`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(rpc.variables ?? {})) {
    const l = literal(v);
    if (l !== undefined) env[k] = l.replace(/\$\{\{[^}]+\}\}/g, "op-geth.railway.internal");
  }
  const config = loadRpcConfig(env);
  assert.equal(config.upstreamUrl, "http://op-geth.railway.internal:8545/");
  assert.equal(config.chainId, 668801n);
  assert.equal(config.port, 8080);
  // The node's own HTTP port serves the same chain the gateway names.
  assert.equal(literal(svc(nodes, "op-geth").variables!.L2_CHAIN_ID), literal(rpc.variables!.CHAIN_ID));
});

test("railway: the web pages are built with the deployed bridge addresses and the live public addresses", async () => {
  const nodes = await graph();
  const web = svc(nodes, "web");
  const declared = new Set(Object.keys(web.variables ?? {}));
  // Every value the build reads reaches it: declared on Railway, and named as a build argument.
  const dockerfile = readFileSync(repo("apps/web/Dockerfile"), "utf8");
  const args = new Set([...dockerfile.matchAll(/^ARG ([A-Z0-9_]+)$/gm)].map((m) => m[1]!));
  const build = readFileSync(repo("apps/web/build.mjs"), "utf8");
  const read = new Set([...build.matchAll(/process\.env\.([A-Z0-9_]+)|env\("([A-Z0-9_]+)"\)/g)].map((m) => m[1] ?? m[2]!));
  assert.ok(read.has("L1_PORTAL") && read.has("API_URL"), "settings found in build.mjs");
  // The token's name and symbol keep the defaults in build.mjs.
  const defaults = new Set(["TOKEN_NAME", "TOKEN_SYMBOL"]);
  for (const key of read) {
    if (defaults.has(key)) continue;
    assert.ok(declared.has(key), `web: ${key} is not declared in .railway/railway.ts`);
    assert.ok(args.has(key), `web: ${key} is not a build argument in apps/web/Dockerfile`);
  }
  for (const key of args) assert.ok(read.has(key), `apps/web/Dockerfile names ${key}, which build.mjs does not read`);
  const value = (key: string) => literal(web.variables![key]) ?? "";
  // The bridge page accepts the settings, and its addresses are the deployed proxies.
  const parsed = parseBridgeConfig({
    l1Portal: value("L1_PORTAL"), l1OutputOracle: value("L1_OUTPUT_ORACLE"), l1StandardBridge: value("L1_STANDARD_BRIDGE"),
    l1Token: value("L1_TOKEN"), l2Token: value("L2_TOKEN"), l2RpcUrl: value("L2_RPC_URL"), l1RpcUrl: value("L1_RPC_URL"), explorerUrl: value("EXPLORER_URL"),
  });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.problems.join("; "));
  const deployed = JSON.parse(readFileSync(repo("chain/testnet/l1-deployments.json"), "utf8")) as Record<string, string>;
  assert.equal(value("L1_PORTAL"), deployed.OptimismPortalProxy);
  assert.equal(value("L1_OUTPUT_ORACLE"), deployed.L2OutputOracleProxy);
  assert.equal(value("L1_STANDARD_BRIDGE"), deployed.L1StandardBridgeProxy);
  const readme = readFileSync(repo("chain/testnet/README.md"), "utf8");
  for (const key of ["L1_TOKEN", "L2_TOKEN", "SWAP_ROUTER", "SWAP_FACTORY"]) assert.ok(readme.includes(value(key)), `${key} is not an address recorded in chain/testnet/README.md`);
  // The swap page accepts its settings too.
  const swap = parseSwapConfig({ router: value("SWAP_ROUTER"), factory: value("SWAP_FACTORY"), token: value("L2_TOKEN"), rpcUrl: value("L2_RPC_URL"), explorerUrl: value("EXPLORER_URL") });
  assert.ok(swap.ok, swap.ok ? "" : swap.problems.join("; "));
  // And the Safe page, which the signers of the multisigs use on both chains.
  const safe = parseSafeConfig({ l1RpcUrl: value("L1_RPC_URL"), l2RpcUrl: value("L2_RPC_URL"), explorerUrl: value("EXPLORER_URL") });
  assert.ok(safe.ok, safe.ok ? "" : safe.problems.join("; "));
  // The landing page is built from these settings: none it needs is missing or unusable. Its own
  // address is the name that serves it, the pages' address is another name, and www leads to it.
  assert.ok(parseLandingConfig({ rpcUrl: value("L2_RPC_URL"), chainId: value("CHAIN_ID"), chainName: value("CHAIN_NAME"), explorerUrl: value("EXPLORER_URL"), symbol: value("NATIVE_SYMBOL") }));
  const settings = Object.fromEntries(["SITE_URL", "APP_URL", "MINE_URL", "EXPLORER_URL", "L2_RPC_URL", "CHAIN_ID", "CHAIN_NAME", "NATIVE_SYMBOL"].map((key) => [key, value(key)]));
  assert.notEqual(landingPage(readFileSync(repo("apps/web/src/landing.html"), "utf8"), settings), null);
  const redirect = parseRedirect(value("REDIRECT_HOSTS"), value("REDIRECT_TO"));
  const landingHosts: Set<string> = parseLandingHosts(value("LANDING_HOSTS"), redirect);
  assert.deepEqual([...landingHosts], [new URL(value("SITE_URL")).host]);
  assert.equal(redirect.to, value("SITE_URL"));
  assert.deepEqual([...redirect.hosts], [`www.${new URL(value("SITE_URL")).host}`]);
  assert.ok(!landingHosts.has(new URL(value("APP_URL")).host) && !redirect.hosts.has(new URL(value("APP_URL")).host));
  // One public address for the chain and one for the explorer, the same everywhere.
  const explorer = svc(nodes, "explorer");
  assert.equal(literal(explorer.variables!.WEBSITE_URL), value("SITE_URL"));
  assert.equal(literal(explorer.variables!.BRIDGE_URL), `${value("APP_URL")}/bridge.html`);
  assert.equal(value("L2_RPC_URL"), literal(explorer.variables!.PUBLIC_RPC_URL));
  assert.equal(value("RPC_URL"), value("L2_RPC_URL"));
  assert.equal(value("CHAIN_ID"), literal(svc(nodes, "op-geth").variables!.L2_CHAIN_ID));
  assert.match(literal(explorer.variables!.BRIDGE_URL) ?? "", /^https:\/\/[a-z0-9.-]+\/bridge\.html$/);
  assert.equal(literal(explorer.variables!.SWAP_URL), literal(explorer.variables!.BRIDGE_URL)!.replace("bridge.html", "swap.html"));
  // The bridge and swap pages link to each other, so they are public together. The Safe page needs
  // only the two chains. The pages that need the API stay closed until it has an address.
  const pages = value("PAGES").split(",");
  assert.ok(pages.includes("bridge") && pages.includes("swap") && pages.includes("safe"));
  if (web.variables!.API_URL!.type !== "literal") assert.deepEqual(pages, ["bridge", "swap", "safe"]);
});

test("railway: LONGYU MINE's web build is made for the live API, which sends browsers back to it", async () => {
  const nodes = await graph();
  const mine = svc(nodes, "mine");
  const api = svc(nodes, "api");
  const value = (key: string) => literal(mine.variables![key]) ?? "";
  // Every setting the image is built with is set on Railway, which hands variables to the build.
  const dockerfile = readFileSync(repo("apps/mobile/site/Dockerfile"), "utf8");
  const args = [...dockerfile.matchAll(/^ARG ([A-Z0-9_]+)(?:=\S*)?$/gm)].map((m) => m[1]!).sort();
  assert.deepEqual(args, ["APP_VARIANT", "EXPO_PUBLIC_API_URL", "EXPO_PUBLIC_TURNSTILE_SITE_KEY"]);
  for (const key of args) assert.ok(value(key), `mine: ${key} is not set in .railway/railway.ts`);
  assert.equal(value("APP_VARIANT"), "testnet");
  assert.equal(value("PORT"), "8080");
  assert.match(value("EXPO_PUBLIC_TURNSTILE_SITE_KEY"), /^0x[0-9A-Za-z_-]{20,}$/);
  // The page calls the API at its public address (the one its data files are published under),
  // and the server accepts that address for the page's content policy.
  const apiUrl = value("EXPO_PUBLIC_API_URL");
  assert.equal(`${apiUrl}/data`, literal(api.variables!.PUBLIC_DATA_BASE_URL));
  assert.ok((contentPolicy(apiUrl) as string).includes(`connect-src 'self' ${apiUrl};`));
  // After X, the API sends a browser back to this site, whose pages it lets call it; so may the claim page.
  const back = literal(api.variables!.WEB_AUTH_REDIRECT) ?? "";
  assert.match(back, /^https:\/\/mine-testnet\.longyu\.network\/$/);
  const origins = (literal(api.variables!.WEB_ORIGINS) ?? "").split(",");
  const claimPage = new URL(literal(svc(nodes, "explorer").variables!.BRIDGE_URL)!).origin;
  assert.deepEqual(origins, [claimPage, new URL(back).origin]);
  // And the claim page links to it.
  assert.equal(literal(svc(nodes, "web").variables!.MINE_URL), new URL(back).origin);
  // The switch for mining in a browser is a declared setting: "false" turns it off.
  assert.equal(literal(api.variables!.WEB_MINING), "true");
  // So is the switch for the invite bonus.
  assert.equal(literal(api.variables!.INVITE_REWARD), "true");
  // The origin check's secret is entered on Railway, never written here.
  assert.notEqual(mine.variables!.ORIGIN_SECRET!.type, "literal");
});

test("railway: services get what their entrypoints require", async () => {
  const nodes = await graph();
  for (const name of ["op-geth", "op-node", "op-batcher", "op-proposer"]) {
    const script = readFileSync(repo(`chain/railway/${name}/entrypoint.sh`), "utf8");
    const used = new Set([...script.matchAll(/\$\{([A-Z0-9_]+)(:-|#|\})/g)].map((m) => m[1]!));
    for (const local of ["DATA_DIR", "CHAIN_DIR", "TMPDIR"]) used.delete(local);
    const declared = new Set(Object.keys(svc(nodes, name).variables ?? {}));
    for (const v of used) assert.ok(declared.has(v), `${name} uses ${v} but Railway does not set it`);
  }
  const deployment = JSON.parse(readFileSync(repo("ops/monitor/deployment.example.json"), "utf8")) as { networks: Record<string, { rpcEnv: string }> };
  const monitorVars = new Set(Object.keys(svc(nodes, "monitor").variables ?? {}));
  for (const n of Object.values(deployment.networks)) assert.ok(monitorVars.has(n.rpcEnv), `monitor needs ${n.rpcEnv}`);
  // Alerts go out through Telegram: the generated trigger reads the bot's token from this variable.
  assert.ok(monitorVars.has("TELEGRAM_BOT_TOKEN"));
  assert.match(readFileSync(repo("ops/monitor/generate.ts"), "utf8"), /value: "TELEGRAM_BOT_TOKEN"/);
});

test("railway: the signer holds the signing keys, and nothing else does", async () => {
  const nodes = await graph();
  const signer = svc(nodes, "signer");
  const vars = signer.variables ?? {};
  // The limits keep the defaults in apps/signer/src/config.ts; everything else is declared.
  const defaults = new Set(["HOST", "MAX_GAS", "MAX_FEE_PER_GAS_WEI", "MAX_DATA_BYTES", "MAX_DAILY_FEE_WEI", "WATCH_MAX_GAS", "WATCH_MAX_FEE_PER_GAS_WEI", "FAUCET_MAX_AMOUNT_WEI", "FAUCET_MAX_DAILY_WEI", "VOUCHER_MAX_TTL_SECONDS"]);
  for (const key of Object.keys(SignerConfigSchema.shape)) {
    assert.ok(key in vars !== defaults.has(key), `signer: ${key} is ${defaults.has(key) ? "a default and must not be" : "not"} declared in .railway/railway.ts`);
  }
  for (const key of Object.keys(vars)) assert.ok(key in SignerConfigSchema.shape, `signer: ${key} is not a setting it reads`);
  // Secrets are entered in Railway, never written in the repository.
  const KEYS = ["PUBLISHER_KEY", "RELAYER_KEY", "FAUCET_SIGNER_KEY", "WATCH_KEY"];
  for (const key of [...KEYS, "SIGNER_TOKEN"]) assert.equal(vars[key]!.type, "preserve", `signer: ${key}`);
  // With the founders' values it starts, bound to the chain the node runs.
  const env: Record<string, string> = { SIGNER_TOKEN: "t".repeat(40) };
  for (const [k, v] of Object.entries(vars)) {
    const l = literal(v);
    if (l !== undefined) env[k] = l;
  }
  KEYS.forEach((key, i) => (env[key] = `0x${String(i + 1).repeat(64)}`));
  const config = loadSignerConfig(env);
  assert.equal(String(config.CHAIN_ID), literal(svc(nodes, "op-geth").variables!.L2_CHAIN_ID));
  assert.equal(config.PORT, 8080);
  assert.equal(config.HOST, "::", "Railway's private network is IPv6");

  // No other service holds a signing key, and only the API holds the signer's token, by reference.
  const api = svc(nodes, "api");
  for (const n of nodes) {
    if (n.name === "signer") continue;
    for (const key of KEYS) assert.ok(!(key in (n.variables ?? {})), `${n.name} must not hold ${key}`);
    if (n.name !== "api") assert.ok(!("SIGNER_TOKEN" in (n.variables ?? {})) && !("SIGNER_URL" in (n.variables ?? {})), `${n.name} has no business with the signer`);
  }
  assert.deepEqual(api.variables!.SIGNER_TOKEN, { type: "reference", resource: "service.signer", output: "SIGNER_TOKEN" });
  assert.equal(literal(api.variables!.SIGNER_URL), "http://${{signer.RAILWAY_PRIVATE_DOMAIN}}:8080");
  // The signer is reached over the private network only: this file gives it no public address, and
  // the instruction never to add one stays next to its definition.
  for (const key of Object.keys(signer)) assert.ok(!/domain|network|port|tcp/i.test(key), `signer: unexpected ${key}`);
  assert.match(readFileSync(repo(".railway/railway.ts"), "utf8"), /Never give this service a public domain/);
  // The image runs the signer as a user without privileges and copies nothing but its own code.
  const image = readFileSync(repo("apps/signer/Dockerfile"), "utf8");
  assert.match(image, /^USER (?!root|0\b)\S+/m);
  assert.doesNotMatch(image, /^COPY (?!--from)\.\s/m, "the image must not copy the whole repository");
});

// ------------------------------------------------------------- entrypoints

const shell = spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
const KEY = `0x${"11".repeat(32)}`;
const JWT = "ab".repeat(32);

/** Runs an entrypoint with stub programs that record their arguments. */
function run(name: string, env: Record<string, string>, files: Record<string, string> = {}, prepare?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), `longyu-${name}-`));
  prepare?.(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const chain = join(dir, "chain");
  mkdirSync(chain);
  for (const [f, body] of Object.entries(files)) writeFileSync(join(chain, f), body);
  for (const prog of ["geth", "op-node", "op-batcher", "op-proposer"]) {
    const p = join(bin, prog);
    writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "${prog} $*" >> "${dir.replace(/\\/g, "/")}/calls.log"\n`);
    chmodSync(p, 0o755);
  }
  const r = spawnSync("sh", [fileURLToPath(new URL(`../chain/railway/${name}/entrypoint.sh`, import.meta.url))], {
    encoding: "utf8",
    env: { PATH: `${bin}${delimiter}${process.env.PATH}`, DATA_DIR: join(dir, "db"), CHAIN_DIR: chain, TMPDIR: dir, ...env },
  });
  const log = existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : [];
  return { code: r.status, stderr: r.stderr, calls: log, dir };
}

// Both layouts op-node may write: the chain ID last on its line, or followed by more on one line.
const genesis = (id: string) => JSON.stringify({ config: { chainId: Number(id) }, alloc: {} }, null, 2);
const genesisOneLine = (id: string) => JSON.stringify({ config: { chainId: Number(id), homesteadBlock: 0 } });

test("entrypoint: op-geth initialises once, serves only safe APIs publicly, and checks its settings", { skip: !shell && "no POSIX shell" }, () => {
  const env = { L2_CHAIN_ID: "668801", GS_SEQUENCER_ADDRESS: "0x000000000000000000000000000000000000dEaD", ENGINE_JWT_SECRET: `0x${JWT}` };
  const r = run("op-geth", env, { "genesis.json": genesis("668801") });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls.length, 2);
  assert.match(r.calls[0]!, /^geth init --datadir=\S+ --state.scheme path --db.engine pebble \S+genesis\.json$/);
  const flags = r.calls[1]!;
  assert.match(flags, / --http\.api=eth,net,web3 /);
  assert.match(flags, / --ws\.api=eth,net,web3,debug,txpool /);
  assert.doesNotMatch(flags.split(" --ws ")[0]!, /debug|engine|txpool|admin|personal/);
  for (const f of ["--gcmode=full", "--networkid=668801", "--maxpeers=0", "--nodiscover", "--miner.etherbase=0x000000000000000000000000000000000000dEaD", "--pathdb.proposeblock=3600", "--cache=4096"]) {
    assert.ok(flags.includes(f), f);
  }
  const jwtFile = join(r.dir, "db", "jwt.txt");
  assert.equal(readFileSync(jwtFile, "utf8"), JWT, "engine secret written without 0x");
  if (process.platform !== "win32") assert.equal(statSync(jwtFile).mode & 0o077, 0, "secret not readable by others");

  assert.equal(run("op-geth", env, { "genesis.json": genesisOneLine("668801") }).code, 0);
  assert.equal(run("op-geth", env, { "genesis.json": genesisOneLine("6688012") }).code, 1);
  const wrongChain = run("op-geth", env, { "genesis.json": genesis("6688010") });
  assert.equal(wrongChain.code, 1);
  assert.match(wrongChain.stderr, /not for chain 668801/);
  for (const [k, v, msg] of [
    ["ENGINE_JWT_SECRET", "abc", /32 bytes/], ["GS_SEQUENCER_ADDRESS", "0x12", /address/], ["L2_CHAIN_ID", "6688x", /number/], ["GETH_CACHE_MB", "lots", /number/],
  ] as const) {
    const bad = run("op-geth", { ...env, [k]: v }, { "genesis.json": genesis("668801") });
    assert.equal(bad.code, 1, k);
    assert.match(bad.stderr, msg);
    assert.deepEqual(bad.calls, [], `${k}: nothing started`);
  }
  assert.match(run("op-geth", env).stderr, /genesis.json is missing/);
});

test("entrypoint: op-geth never starts on another chain's data, and erases it only when told which genesis replaces it", { skip: !shell && "no POSIX shell" }, () => {
  const env = { L2_CHAIN_ID: "668801", GS_SEQUENCER_ADDRESS: "0x000000000000000000000000000000000000dEaD", ENGINE_JWT_SECRET: JWT };
  const file = genesis("668801");
  const sha = createHash("sha256").update(file).digest("hex");
  /** A volume that already holds a chain, initialised from the genesis with this hash (or before hashes were recorded). */
  const volume = (mark?: string) => (dir: string) => {
    mkdirSync(join(dir, "db", "datadir", "geth", "chaindata"), { recursive: true });
    writeFileSync(join(dir, "db", "datadir", "geth", "chaindata", "CURRENT"), "old");
    if (mark) writeFileSync(join(dir, "db", "genesis.sha256"), mark);
  };
  const old = (dir: string) => existsSync(join(dir, "db", "datadir", "geth", "chaindata", "CURRENT"));

  const fresh = run("op-geth", env, { "genesis.json": file });
  assert.equal(readFileSync(join(fresh.dir, "db", "genesis.sha256"), "utf8"), sha, "a new chain records its genesis");

  const same = run("op-geth", env, { "genesis.json": file }, volume(sha));
  assert.equal(same.code, 0, same.stderr);
  assert.equal(same.calls.length, 1, "no second init");
  assert.ok(old(same.dir));

  for (const mark of ["f".repeat(64), undefined]) {
    const other = run("op-geth", env, { "genesis.json": file }, volume(mark));
    assert.equal(other.code, 1);
    assert.match(other.stderr, new RegExp(`set RESET_CHAIN_FOR_GENESIS=${sha}`));
    assert.deepEqual(other.calls, [], "nothing started");
    assert.ok(old(other.dir), "nothing erased");

    const wrong = run("op-geth", { ...env, RESET_CHAIN_FOR_GENESIS: "f".repeat(64) }, { "genesis.json": file }, volume(mark));
    assert.equal(wrong.code, 1);
    assert.ok(old(wrong.dir), "a reset for some other genesis erases nothing");

    const reset = run("op-geth", { ...env, RESET_CHAIN_FOR_GENESIS: sha }, { "genesis.json": file }, volume(mark));
    assert.equal(reset.code, 0, reset.stderr);
    assert.ok(!old(reset.dir), "old chain erased");
    assert.match(reset.calls[0]!, /^geth init /);
    assert.equal(readFileSync(join(reset.dir, "db", "genesis.sha256"), "utf8"), sha);
  }
  // The reset variable left in place does nothing once the chain is the one it names.
  const again = run("op-geth", { ...env, RESET_CHAIN_FOR_GENESIS: sha }, { "genesis.json": file }, volume(sha));
  assert.equal(again.code, 0);
  assert.ok(old(again.dir));
});

test("entrypoint: op-node, op-batcher and op-proposer start with their checked settings", { skip: !shell && "no POSIX shell" }, () => {
  const node = run("op-node", {
    L1_RPC_URL: "https://bsc-testnet.example", L2_ENGINE_HOST: "op-geth.railway.internal", ENGINE_JWT_SECRET: JWT, GS_SEQUENCER_PRIVATE_KEY: KEY,
  }, { "rollup.json": "{}" });
  assert.equal(node.code, 0, node.stderr);
  const n = node.calls[0]!;
  for (const f of ["--l2=http://op-geth.railway.internal:8551", "--sequencer.enabled=true", "--p2p.no-discovery", `--p2p.sequencer.key=${"11".repeat(32)}`, "--l1=https://bsc-testnet.example", "--l1.rpc-max-cache-size=30000", "--l1.rpc-rate-limit=28"]) {
    assert.ok(n.includes(f), f);
  }
  assert.ok(!n.includes("--l1.rpckind"), "only when L1_RPC_KIND is set");
  assert.ok(!n.includes("--sequencer.priority"), "a sequencer behind the clock would starve derivation");
  assert.ok(run("op-node", { L1_RPC_URL: "https://x", L2_ENGINE_HOST: "h", ENGINE_JWT_SECRET: JWT, GS_SEQUENCER_PRIVATE_KEY: KEY, L1_RPC_KIND: "basic" }, { "rollup.json": "{}" })
    .calls[0]!.includes("--l1.rpckind=basic"));
  assert.equal(run("op-node", { L1_RPC_URL: "https://x", L2_ENGINE_HOST: "h", ENGINE_JWT_SECRET: JWT, GS_SEQUENCER_PRIVATE_KEY: KEY }).code, 1, "rollup.json missing");
  const limited = (limit: string) => run("op-node", { L1_RPC_URL: "https://x", L2_ENGINE_HOST: "h", ENGINE_JWT_SECRET: JWT, GS_SEQUENCER_PRIVATE_KEY: KEY, L1_RPC_RATE_LIMIT: limit }, { "rollup.json": "{}" });
  assert.ok(limited("150").calls[0]!.includes("--l1.rpc-rate-limit=150"));
  for (const bad of ["0", "fast", "1.5", "-3"]) assert.equal(limited(bad).code, 1, `rate limit ${bad}`);

  const batcher = run("op-batcher", { L1_RPC_URL: "https://x", L2_RPC_HOST: "op-geth.railway.internal", ROLLUP_RPC_HOST: "op-node.railway.internal", GS_BATCHER_PRIVATE_KEY: KEY });
  assert.equal(batcher.code, 0, batcher.stderr);
  for (const f of ["--l2-eth-rpc=http://op-geth.railway.internal:8545", "--rollup-rpc=http://op-node.railway.internal:8547", "--max-channel-duration=300", "--txmgr.min-tip-cap=0.1", `--private-key=${"11".repeat(32)}`,
    // 30 blocks a pass at most: one pass a second, not held up by one unconfirmed transaction.
    "--poll-interval=1s", "--max-pending-tx=4", "--txmgr.receipt-query-interval=2s"]) {
    assert.ok(batcher.calls[0]!.includes(f), f);
  }
  assert.equal(run("op-batcher", { L1_RPC_URL: "ftp://x", L2_RPC_HOST: "a", ROLLUP_RPC_HOST: "b", GS_BATCHER_PRIVATE_KEY: KEY }).code, 1);

  const proposer = run("op-proposer", { L1_RPC_URL: "https://x", ROLLUP_RPC_HOST: "op-node.railway.internal", L2OO_ADDRESS: "0x00000000000000000000000000000000000000aa", GS_PROPOSER_PRIVATE_KEY: KEY });
  assert.equal(proposer.code, 0, proposer.stderr);
  assert.ok(proposer.calls[0]!.includes("--l2oo-address=0x00000000000000000000000000000000000000aa"));
  assert.ok(proposer.calls[0]!.includes("--txmgr.min-tip-cap=0.1"));
  // Several BSC RPCs, comma-separated: the L2 software moves to the next when one fails.
  const urls = "https://a.example,https://b.example";
  assert.ok(run("op-node", { L1_RPC_URL: urls, L2_ENGINE_HOST: "h", ENGINE_JWT_SECRET: JWT, GS_SEQUENCER_PRIVATE_KEY: KEY }, { "rollup.json": "{}" }).calls[0]!.includes(`--l1=${urls}`));
  assert.equal(run("op-proposer", { L1_RPC_URL: "https://x", ROLLUP_RPC_HOST: "b", L2OO_ADDRESS: "nope", GS_PROPOSER_PRIVATE_KEY: KEY }).code, 1);
});
