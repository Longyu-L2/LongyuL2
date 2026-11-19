import { test } from "node:test";
import assert from "node:assert/strict";
import appConfig, { assertReleaseConfig, RELEASE_BLOCKED_PERMISSIONS, variantOf } from "../../app.config.ts";

const base = { name: "LONGYU MINE", slug: "longyu-mine", ios: { bundleIdentifier: "app.longyu.mine", entitlements: {} }, android: { package: "app.longyu.mine" }, extra: { eas: { projectId: "p" } } };
const release = {
  EXPO_PUBLIC_API_URL: "https://api-testnet.longyu.network",
  EXPO_PUBLIC_DEV_ATTESTATION: "false",
  EXPO_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAAAAAA",
};

function resolve(env: Record<string, string>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return appConfig({ config: base } as never);
  } finally {
    for (const k of Object.keys(env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("variants: development installs beside the store app; testnet and production share the store ID", () => {
  const dev = resolve({ APP_VARIANT: "development" });
  assert.equal(dev.ios?.bundleIdentifier, "app.longyu.mine.dev");
  assert.equal(dev.android?.package, "app.longyu.mine.dev");
  assert.equal(dev.ios?.entitlements?.["com.apple.developer.devicecheck.appattest-environment"], "development");
  assert.equal(dev.android?.blockedPermissions, undefined); // the development menu draws over the app
  for (const v of ["testnet", "production"]) {
    const c = resolve({ APP_VARIANT: v, EAS_BUILD: "true", ...release });
    assert.equal(c.ios?.bundleIdentifier, "app.longyu.mine");
    assert.equal(c.android?.package, "app.longyu.mine");
    assert.deepEqual(c.android?.blockedPermissions, RELEASE_BLOCKED_PERMISSIONS);
    assert.ok(RELEASE_BLOCKED_PERMISSIONS.includes("android.permission.SYSTEM_ALERT_WINDOW"));
    // The released app never reads the person's files or pictures, whatever a package's manifest asks for.
    for (const p of ["READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "READ_MEDIA_IMAGES"]) assert.ok(RELEASE_BLOCKED_PERMISSIONS.includes(`android.permission.${p}`), p);
    // Android 14 and later refuse the screen-capture package's start-up registration without this one.
    assert.ok(!RELEASE_BLOCKED_PERMISSIONS.includes("android.permission.DETECT_SCREEN_CAPTURE"));
    assert.equal(c.ios?.entitlements?.["com.apple.developer.devicecheck.appattest-environment"], "production");
    assert.deepEqual(c.extra, { eas: { projectId: "p" }, variant: v });
  }
  assert.throws(() => variantOf({ APP_VARIANT: "staging" }), /APP_VARIANT must be one of/);
});

test("release builds refuse development or missing settings", () => {
  assert.doesNotThrow(() => assertReleaseConfig("testnet", release));
  assert.throws(() => assertReleaseConfig("production", { ...release, EXPO_PUBLIC_DEV_ATTESTATION: "true" }), /must be false/);
  assert.throws(() => assertReleaseConfig("production", { ...release, EXPO_PUBLIC_API_URL: "http://api.longyu.network" }), /https/);
  assert.throws(() => assertReleaseConfig("testnet", { ...release, EXPO_PUBLIC_TURNSTILE_SITE_KEY: "" }), /TURNSTILE/);
  assert.doesNotThrow(() => assertReleaseConfig("development", {}));
  // On EAS the check runs while the config is read, so a bad build fails before it starts.
  assert.throws(() => resolve({ APP_VARIANT: "production", EAS_BUILD: "true", ...release, EXPO_PUBLIC_DEV_ATTESTATION: "true" }), /Cannot build the production app/);
});
