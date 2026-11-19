/**
 * Validates generated Monitor config against OpenZeppelin Monitor 1.7.0's rules (serde structs with
 * deny_unknown_fields, and the load-time checks in its repositories), since a config error there
 * only shows up in the logs of a running service.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generate, signatureOf, type Deployment } from "./generate.ts";

const example = JSON.parse(readFileSync(new URL("./deployment.example.json", import.meta.url), "utf8")) as Deployment;
const filled = (): Deployment => {
  const d = structuredClone(example);
  let i = 1;
  for (const c of Object.values(d.contracts)) c.address = `0x${(i++).toString(16).padStart(40, "0")}`;
  d.alerts.telegramChatId = "-1001234567890";
  return d;
};

const only = (obj: object, allowed: string[], required: string[], where: string) => {
  for (const k of Object.keys(obj)) assert.ok(allowed.includes(k), `${where}: unknown key "${k}"`);
  for (const k of required) assert.ok(k in obj, `${where}: missing "${k}"`);
};
const secret = (v: unknown, where: string) => {
  only(v as object, ["type", "value"], ["type", "value"], where);
  assert.ok(["plain", "environment"].includes((v as { type: string }).type), where);
};

function validate(files: Record<string, unknown>) {
  const networks = new Map<string, Record<string, unknown>>();
  const monitors: Record<string, unknown>[] = [];
  const triggers = new Map<string, Record<string, unknown>>();
  for (const [path, v] of Object.entries(files)) {
    const [dir, file] = path.split("/");
    assert.match(file!, /^[a-z0-9_]+\.json$/, path);
    if (dir === "networks") networks.set(file!.replace(/\.json$/, ""), v as Record<string, unknown>);
    else if (dir === "monitors") monitors.push(v as Record<string, unknown>);
    else if (dir === "triggers") for (const [k, t] of Object.entries(v as object)) {
      assert.ok(!triggers.has(k), `duplicate trigger ${k}`);
      triggers.set(k, t);
    } else assert.fail(`unexpected directory ${dir}`);
  }

  for (const [stem, n] of networks) {
    only(n, ["network_type", "slug", "name", "rpc_urls", "chain_id", "network_passphrase", "block_time_ms", "confirmation_blocks", "cron_schedule", "max_past_blocks", "store_blocks", "recovery_config"],
      ["network_type", "slug", "name", "rpc_urls", "block_time_ms", "confirmation_blocks", "cron_schedule"], `network ${stem}`);
    assert.equal(n.network_type, "EVM");
    assert.equal(n.slug, stem, "file name must equal the slug");
    assert.match(String(n.slug), /^[a-z0-9_]+$/);
    assert.ok(Number(n.block_time_ms) >= 100 && Number(n.confirmation_blocks) > 0);
    assert.equal(String(n.cron_schedule).split(" ").length, 6, "cron needs six fields, seconds first");
    assert.ok(n.max_past_blocks === "unlimited" || (Number.isInteger(n.max_past_blocks) && Number(n.max_past_blocks) > 0));
    for (const u of n.rpc_urls as Record<string, unknown>[]) {
      only(u, ["type_", "url", "weight"], ["type_", "url", "weight"], `network ${stem} rpc`);
      assert.equal(u.type_, "rpc");
      assert.ok(Number(u.weight) <= 100);
      secret(u.url, `network ${stem} url`);
    }
  }
  const names = new Set<string>();
  for (const n of networks.values()) {
    assert.ok(!names.has(String(n.name).toLowerCase()), "network names unique");
    names.add(String(n.name).toLowerCase());
  }

  const monitorNames = new Set<string>();
  for (const m of monitors) {
    const where = `monitor ${m.name}`;
    only(m, ["name", "networks", "paused", "addresses", "match_conditions", "trigger_conditions", "triggers", "chain_configurations"],
      ["name", "networks", "paused", "addresses", "match_conditions", "trigger_conditions", "triggers"], where);
    assert.ok(!monitorNames.has(String(m.name).toLowerCase()), `${where}: duplicate name`);
    monitorNames.add(String(m.name).toLowerCase());
    assert.equal(typeof m.paused, "boolean");
    assert.ok((m.networks as string[]).length > 0);
    for (const n of m.networks as string[]) assert.ok(networks.has(n), `${where}: unknown network ${n}`);
    for (const t of m.triggers as string[]) assert.ok(triggers.has(t), `${where}: unknown trigger ${t}`);
    const mc = m.match_conditions as Record<string, unknown[]>;
    only(mc, ["functions", "events", "transactions"], ["functions", "events", "transactions"], `${where} match_conditions`);
    const specEvents = new Map<string, { name: string; inputs: { name: string; type: string; indexed: boolean }[] }>();
    for (const a of m.addresses as Record<string, unknown>[]) {
      only(a, ["address", "contract_spec"], ["address"], `${where} address`);
      assert.match(String(a.address), /^0x[0-9a-fA-F]{40}$/);
      for (const item of (a.contract_spec ?? []) as Record<string, unknown>[]) {
        assert.equal(item.type, "event");
        for (const i of item.inputs as Record<string, unknown>[]) {
          only(i, ["name", "type", "indexed", "internalType"], ["name", "type", "indexed"], `${where} abi input`);
          // Types Monitor 1.7.0 can decode and compare.
          assert.match(String(i.type), /^(address|bool|string|bytes|bytes32|u?int(8|16|32|64|128|256))$/, `${where}: type ${i.type}`);
        }
        specEvents.set(signatureOf(item as never), item as never);
      }
    }
    assert.ok(mc.events!.length > 0, `${where}: watches no events`);
    for (const e of mc.events as Record<string, unknown>[]) {
      only(e, ["signature", "expression"], ["signature"], `${where} event`);
      const spec = specEvents.get(String(e.signature));
      assert.ok(spec, `${where}: ${e.signature} not in contract_spec`);
      if (e.expression) {
        // Only ABI argument names, comparison operators, AND/OR and literals.
        const tokens = String(e.expression).split(/\s+/);
        for (const tok of tokens) {
          if (/^(AND|OR|==|!=|>|>=|<|<=|\(|\)|\d+|0x[0-9a-fA-F]+|'[^']*')$/i.test(tok)) continue;
          assert.ok(spec.inputs.some((i) => i.name === tok), `${where}: "${tok}" is not an argument of ${e.signature}`);
        }
      }
    }
  }

  const triggerNames = new Set<string>();
  for (const [key, t] of triggers) {
    only(t, ["name", "trigger_type", "config"], ["name", "trigger_type", "config"], `trigger ${key}`);
    assert.ok(!triggerNames.has(String(t.name).toLowerCase()));
    triggerNames.add(String(t.name).toLowerCase());
    const c = t.config as Record<string, unknown>;
    const msg = c.message as Record<string, string>;
    only(msg, ["title", "body"], ["title", "body"], `trigger ${key} message`);
    assert.ok(msg.title.trim() && msg.body.trim());
    if (t.trigger_type === "telegram") {
      only(c, ["token", "chat_id", "disable_web_preview", "message", "retry_policy"], ["token", "chat_id", "message"], `trigger ${key}`);
      secret(c.token, `${key} token`);
      assert.equal(typeof c.chat_id, "string");
      assert.equal((c.token as { type: string }).type, "environment", "the bot token is never written into the config");
      assert.ok(msg.body.length <= 4096);
    } else assert.fail(`unexpected trigger type ${t.trigger_type}`);
  }
}

test("a full deployment generates a valid Monitor 1.7.0 config", () => {
  const files = generate(filled());
  validate(files);
  assert.deepEqual(Object.keys(files).filter((f) => f.startsWith("networks/")).sort(),
    ["networks/bsc_mainnet.json", "networks/bsc_testnet.json", "networks/longyu_testnet.json"]);
  const router = files["monitors/bsc_mainnet_payment_router.json"];
  assert.ok(router);
  const sigs = (router as { match_conditions: { events: { signature: string }[] } }).match_conditions.events.map((e) => e.signature);
  assert.ok(sigs.includes("TreasurySet(address)") && !sigs.some((s) => s.startsWith("OrderPaid")), "admin events only");
});

test("only networks with a deployed contract are emitted, and a blank deployment is refused", () => {
  const d = structuredClone(example);
  d.alerts.telegramChatId = "@longyu_ops";
  d.contracts.miningDistributor!.address = "0x000000000000000000000000000000000000d157";
  const files = generate(d);
  validate(files);
  assert.deepEqual(Object.keys(files).filter((f) => f.startsWith("networks/")), ["networks/longyu_testnet.json"]);
  assert.deepEqual(Object.keys((files["triggers/ops.json"] as object)), ["ops_telegram"]);
  assert.throws(() => generate({ ...example, alerts: { telegramChatId: "-1001234567890" } }), /no contract has an address yet/);
  const bad = structuredClone(d);
  bad.contracts.miningDistributor!.address = "0x123";
  assert.throws(() => generate(bad), /not an address/);
});

test("alerts need a Telegram chat: without one nothing is generated", () => {
  const d = filled();
  for (const chat of ["", null, undefined, "ops@longyu.network", "longyu ops", "@ab", "12 34", 5]) {
    assert.throws(() => generate({ ...d, alerts: { telegramChatId: chat as string } }), /telegramChatId must be a Telegram chat ID/, String(chat));
  }
  assert.throws(() => generate({ ...d, alerts: undefined as never }), /telegramChatId/);
  // The template is not usable until the chat is filled in.
  assert.throws(() => generate(example), /telegramChatId/);
  for (const chat of ["-1001234567890", "123456789", "@longyu_ops"]) {
    const trigger = (generate({ ...d, alerts: { telegramChatId: chat } })["triggers/ops.json"] as { ops_telegram: { config: { chat_id: string } } }).ops_telegram;
    assert.equal(trigger.config.chat_id, chat);
  }
});
