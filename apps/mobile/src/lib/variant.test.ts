import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Loads a module afresh as a build of that variant would see it (metro.config.js sets the variable). */
function loadAs<T>(file: string, variant: string | undefined): T {
  const saved = process.env.EXPO_PUBLIC_APP_VARIANT;
  if (variant === undefined) delete process.env.EXPO_PUBLIC_APP_VARIANT;
  else process.env.EXPO_PUBLIC_APP_VARIANT = variant;
  const id = require.resolve(file);
  delete require.cache[id];
  try {
    return require(id) as T;
  } finally {
    delete require.cache[id];
    if (saved === undefined) delete process.env.EXPO_PUBLIC_APP_VARIANT;
    else process.env.EXPO_PUBLIC_APP_VARIANT = saved;
  }
}

type Strings = typeof import("./i18n.ts");
type ChainWork = typeof import("./chain-work.ts");
const NOT_TESTNET = [undefined, "development", "testnet"];
const TESTNET_TEXT = /testnet|tlong|tbnb|monetary|测试网|測試網|货币价值|貨幣價值|faucet|668801/i;
const app = path.join(__dirname, "..");

test("only the production variant is the mainnet app", () => {
  for (const v of NOT_TESTNET) assert.equal(loadAs<typeof import("./variant.ts")>("./variant.ts", v).MAINNET, false, String(v));
  assert.equal(loadAs<typeof import("./variant.ts")>("./variant.ts", "production").MAINNET, true);
});

test("the testnet app keeps its label, its notice and its texts", () => {
  for (const v of NOT_TESTNET) {
    const { LANGUAGES, en, zhHans, zhHant } = loadAs<Strings>("./i18n.ts", v);
    assert.equal(en.networkTag, "Testnet");
    assert.equal(en.rewardValueNotice, "Testnet rewards have no monetary value.");
    assert.equal(en.capacityDisclosure, "Paid in BNB on BNB Smart Chain from your own wallet. Testnet tLONG has no monetary value.");
    assert.equal(en.verifyBody, "Required before mainnet conversion");
    assert.equal(zhHans.networkTag, "测试网");
    assert.equal(zhHant.networkTag, "測試網");
    for (const [lang, table] of Object.entries(LANGUAGES)) {
      assert.ok(table.networkTag && table.rewardValueNotice, lang);
      assert.equal(table.lockedUntilTge, "", lang);
    }
  }
});

test("the mainnet app has no testnet text in any language, and says mined LONG is locked until the TGE", () => {
  const { LANGUAGES, en } = loadAs<Strings>("./i18n.ts", "production");
  assert.equal(en.lockedUntilTge, "Locked until the TGE");
  for (const [lang, table] of Object.entries(LANGUAGES)) {
    assert.equal(table.networkTag, "", lang);
    assert.equal(table.rewardValueNotice, "", lang);
    assert.ok(table.lockedUntilTge.includes("TGE"), lang);
    assert.ok(table.capacityDisclosure.includes("BNB") && table.capacityDisclosure.includes("TGE"), lang);
    for (const [k, value] of Object.entries(table)) assert.doesNotMatch(value, TESTNET_TEXT, `${lang}.${k}`);
  }
});

test("the chain check reads the variant's network", () => {
  for (const v of NOT_TESTNET) {
    assert.deepEqual(loadAs<ChainWork>("./chain-work.ts", v).chainCheck, {
      l2RpcUrl: "https://rpc-testnet.longyu.network",
      l1RpcUrl: "https://bsc-testnet-rpc.publicnode.com",
      outputOracle: "0x2dC53f20F511Bf079167Ef013d6107787E620fE3",
    });
  }
  assert.deepEqual(loadAs<ChainWork>("./chain-work.ts", "production").chainCheck, {
    l2RpcUrl: "https://rpc.longyu.network",
    l1RpcUrl: "https://bsc-rpc.publicnode.com",
    outputOracle: "0x77fF9CDD8B92869D428956695dE0e2d94a75aDC8",
  });
});

test("the testnet label and notice are drawn only when the build is not the mainnet app", () => {
  const source = (file: string) => readFileSync(path.join(app, file), "utf8");
  const uses = (text: string, key: string) => text.split("\n").filter((line) => line.includes(`t("${key}")`));
  const mine = uses(source("app/(tabs)/mine.tsx"), "networkTag");
  const signIn = uses(source("app/(onboarding)/sign-in.tsx"), "rewardValueNotice");
  assert.equal(mine.length, 1);
  assert.equal(signIn.length, 2);
  for (const line of [...mine, ...signIn]) assert.match(line, /\{MAINNET \? null : </, line.trim());
  assert.match(source("components/Rewards.tsx"), /if \(!MAINNET\) return null;\n[^]*t\("lockedUntilTge"\)/);
});

test("metro.config.js hands APP_VARIANT to the app's code, and refuses an unknown one", () => {
  const config = path.join(app, "..", "metro.config.js");
  const saved = { APP_VARIANT: process.env.APP_VARIANT, EXPO_PUBLIC_APP_VARIANT: process.env.EXPO_PUBLIC_APP_VARIANT };
  const run = (variant: string | undefined) => {
    if (variant === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = variant;
    delete require.cache[require.resolve(config)];
    require(config);
    return process.env.EXPO_PUBLIC_APP_VARIANT;
  };
  try {
    assert.equal(run("production"), "production");
    assert.equal(run("testnet"), "testnet");
    assert.equal(run(undefined), "development");
    assert.throws(() => run("staging"), /APP_VARIANT must be one of/);
  } finally {
    delete require.cache[require.resolve(config)];
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
