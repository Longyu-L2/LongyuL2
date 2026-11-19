/**
 * Generates OpenZeppelin Monitor 1.7.0 configuration (networks, monitors, triggers) from the compiled
 * contract ABIs and one deployment file, so event signatures and ABI fragments are always exact.
 *
 *   npx tsx ops/monitor/generate.ts ops/monitor/deployment.json ops/monitor/config
 *
 * Contracts with a blank address, and networks no monitor uses, are left out (Monitor resolves every
 * network's RPC secret at start-up, so an unused network with an unset variable would stop it).
 * Format notes, checked against the v1.7.0 source: unknown keys are rejected; network file names must
 * equal their slug; cron has six fields, seconds first; expressions use ABI argument names, AND/OR.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Relative import: the Docker config stage copies only this folder and the ABI source.
import {
  faucetAbi, migrationDistributorAbi, miningDistributorAbi, miningVaultAbi, paymentRouterAbi,
} from "../../packages/abis/src/index.ts";

type AbiEvent = { type: "event"; name: string; anonymous?: boolean; inputs: { name: string; type: string; indexed: boolean; internalType?: string }[] };
type Abi = readonly { type: string }[];

// Rollup contracts on BSC, from bnb-chain/opbnb packages/contracts-bedrock/src/L1 (enums are uint8 in the ABI).
const ev = (name: string, ...inputs: [string, string, boolean][]): AbiEvent => ({
  type: "event", name, anonymous: false, inputs: inputs.map(([type, n, indexed]) => ({ name: n, type, indexed })),
});
const l2OutputOracleAbi = [
  ev("OutputsDeleted", ["uint256", "prevNextOutputIndex", true], ["uint256", "newNextOutputIndex", true]),
];
const systemConfigAbi = [ev("ConfigUpdate", ["uint256", "version", true], ["uint8", "updateType", true], ["bytes", "data", false])];
const superchainConfigAbi = [
  ev("Paused", ["string", "identifier", false]),
  ev("Unpaused"),
  ev("ConfigUpdate", ["uint8", "updateType", true], ["bytes", "data", false]),
];

const ROLES = ["RoleGranted", "RoleRevoked", "RoleAdminChanged"];

/** What each contract is watched for. Routine events (claims, drips, payments) are left to the API. */
const CONTRACTS: Record<string, { label: string; abi: Abi; events: string[]; severity: string }> = {
  miningDistributor: { label: "MiningDistributor", abi: miningDistributorAbi, events: ["RootVetoed", "Paused", "Unpaused", "VaultSet", "MaxDailyIncreaseSet", "ChallengeDelaySet", ...ROLES], severity: "HIGH" },
  miningVault: { label: "MiningVault", abi: miningVaultAbi, events: ["DistributorSet", ...ROLES], severity: "HIGH" },
  faucet: { label: "Faucet", abi: faucetAbi, events: ["LimitsSet", "Paused", "Unpaused", "Withdrawn", ...ROLES], severity: "MEDIUM" },
  migrationDistributor: { label: "MigrationDistributor", abi: migrationDistributorAbi, events: ["RootSet", "Swept", "Paused", "Unpaused", ...ROLES], severity: "HIGH" },
  paymentRouter: { label: "PaymentRouter", abi: paymentRouterAbi, events: ["TreasurySet", "TokenAccepted", "Paused", "Unpaused", ...ROLES], severity: "CRITICAL" },
  l2OutputOracle: { label: "L2OutputOracle", abi: l2OutputOracleAbi, events: ["OutputsDeleted"], severity: "CRITICAL" },
  systemConfig: { label: "SystemConfig", abi: systemConfigAbi, events: ["ConfigUpdate"], severity: "HIGH" },
  superchainConfig: { label: "SuperchainConfig", abi: superchainConfigAbi, events: ["Paused", "Unpaused", "ConfigUpdate"], severity: "CRITICAL" },
};

export interface Deployment {
  /** The Telegram chat (a group's or channel's numeric ID, or a public @name) the alerts go to. */
  alerts: { telegramChatId: string };
  networks: Record<string, { name: string; chainId: number; rpcEnv: string; blockTimeMs: number; confirmations: number; explorerTx: string }>;
  contracts: Record<string, { network: string; address: string }>;
  /** Claims above this many wei from the mining distributor raise an alert. */
  largeClaimWei: string;
}

const SLUG = /^[a-z0-9_]+$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TELEGRAM_CHAT = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export const signatureOf = (e: AbiEvent) => `${e.name}(${e.inputs.map((i) => i.type).join(",")})`;

function eventsOf(abi: Abi, names: string[], label: string): AbiEvent[] {
  return names.map((n) => {
    const found = (abi as AbiEvent[]).filter((x) => x.type === "event" && x.name === n);
    if (found.length !== 1) throw new Error(`${label}: expected one ${n} event in the ABI, found ${found.length}`);
    const e = found[0]!;
    // Monitor only reads names, types and indexed flags; keep the fragment minimal and exact.
    return { type: "event", name: e.name, anonymous: false, inputs: e.inputs.map((i) => ({ name: i.name, type: i.type, indexed: i.indexed })) };
  });
}

export function generate(d: Deployment): Record<string, unknown> {
  const chat = d.alerts?.telegramChatId;
  if (typeof chat !== "string" || !TELEGRAM_CHAT.test(chat)) {
    throw new Error("alerts.telegramChatId must be a Telegram chat ID (a number, negative for groups) or a public @name");
  }
  if (!/^\d+$/.test(d.largeClaimWei)) throw new Error("largeClaimWei must be an integer amount in wei");
  const triggers = ["ops_telegram"];
  const files: Record<string, unknown> = {};
  const usedNetworks = new Set<string>();

  for (const [key, c] of Object.entries(d.contracts)) {
    if (!c.address) continue;
    const spec = CONTRACTS[key];
    if (!spec) throw new Error(`unknown contract "${key}"; known: ${Object.keys(CONTRACTS).join(", ")}`);
    if (!ADDRESS.test(c.address)) throw new Error(`${key}: "${c.address}" is not an address`);
    const net = d.networks[c.network];
    if (!net) throw new Error(`${key}: network "${c.network}" is not defined`);
    usedNetworks.add(c.network);
    const events = eventsOf(spec.abi, spec.events, spec.label);
    const body = [
      `${spec.severity}: ${spec.label} ${c.address} on ${net.name}`,
      "${events}",
      `Transaction: ${net.explorerTx}\${transaction.hash}`,
      "Check whether this was a planned multisig action. If not, follow the incident playbook.",
    ].join("\n\n");
    const name = `${spec.label} admin and safety events (${c.network})`;
    const fileKey = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    files[`monitors/${c.network}_${fileKey}.json`] = {
      name,
      paused: false,
      networks: [c.network],
      addresses: [{ address: c.address, contract_spec: events }],
      match_conditions: { functions: [], events: events.map((e) => ({ signature: signatureOf(e), expression: null })), transactions: [] },
      trigger_conditions: [],
      triggers,
    };
    if (key === "miningDistributor") {
      const claimed = eventsOf(spec.abi, ["Claimed"], spec.label);
      files[`monitors/${c.network}_${fileKey}_large_claim.json`] = {
        name: `Large mining claim (${c.network})`,
        paused: false,
        networks: [c.network],
        addresses: [{ address: c.address, contract_spec: claimed }],
        match_conditions: {
          functions: [],
          events: [{ signature: signatureOf(claimed[0]!), expression: `amount > ${d.largeClaimWei}` }],
          transactions: [],
        },
        trigger_conditions: [],
        triggers,
      };
    }
  }
  if (!usedNetworks.size) throw new Error("no contract has an address yet: fill in deployment.json");

  for (const slug of usedNetworks) {
    if (!SLUG.test(slug)) throw new Error(`network slug "${slug}" may only use a-z, 0-9 and _`);
    const n = d.networks[slug]!;
    if (!/^[A-Z][A-Z0-9_]*$/.test(n.rpcEnv)) throw new Error(`${slug}: rpcEnv must be an environment variable name`);
    // Every minute; pick up every block since the last run, however many that is.
    files[`networks/${slug}.json`] = {
      network_type: "EVM",
      slug,
      name: n.name,
      rpc_urls: [{ type_: "rpc", url: { type: "environment", value: n.rpcEnv }, weight: 100 }],
      chain_id: n.chainId,
      block_time_ms: n.blockTimeMs,
      confirmation_blocks: n.confirmations,
      cron_schedule: "0 */1 * * * *",
      max_past_blocks: "unlimited",
      store_blocks: false,
    };
  }

  const message = { title: "[LONGYU] ${monitor.name}", body: "${events}\n\nTransaction ${transaction.hash} on ${network.slug}" };
  files["triggers/ops.json"] = {
    ops_telegram: {
      name: "LONGYU ops Telegram",
      trigger_type: "telegram",
      config: { token: { type: "environment", value: "TELEGRAM_BOT_TOKEN" }, chat_id: chat, disable_web_preview: true, message },
    },
  };
  return files;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("ops/monitor/generate.ts")) {
  const [input, out] = process.argv.slice(2);
  if (!input || !out) throw new Error("usage: generate.ts <deployment.json> <output config dir>");
  const files = generate(JSON.parse(readFileSync(input, "utf8")) as Deployment);
  for (const dir of ["networks", "monitors", "triggers"]) {
    rmSync(join(out, dir), { recursive: true, force: true });
    mkdirSync(join(out, dir), { recursive: true });
  }
  for (const [path, value] of Object.entries(files)) writeFileSync(join(out, path), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${Object.keys(files).length} files to ${out}`);
}
