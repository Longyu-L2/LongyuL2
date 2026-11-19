/**
 * Build variants on top of app.json, chosen by APP_VARIANT (set by scripts/build-apk.sh, or by the EAS
 * build profiles in eas.json):
 *
 * - development: dev client; its own app ID, so it installs beside the store app, and App Attest in its
 *   development environment. Its JavaScript comes from the local bundler, so the API URL is whatever
 *   EXPO_PUBLIC_API_URL is when you run `npx expo start` (default http://localhost:8080).
 * - testnet: the public testnet app, an APK downloaded from LONGYU's site (no app stores), against the
 *   testnet API. Android proves the device with hardware key attestation, which needs no Google Play.
 * - production: the mainnet app. Same app ID as testnet, so installing it updates the testnet app.
 *
 * Release builds refuse to start without the values the backend checks (see assertReleaseConfig).
 */
import type { ConfigContext, ExpoConfig } from "expo/config";

type Variant = "development" | "testnet" | "production";
const VARIANTS: Variant[] = ["development", "testnet", "production"];

export function variantOf(env: NodeJS.ProcessEnv): Variant {
  const v = (env.APP_VARIANT ?? "development") as Variant;
  if (!VARIANTS.includes(v)) throw new Error(`APP_VARIANT must be one of ${VARIANTS.join(", ")}`);
  return v;
}

/**
 * Permissions that Expo's packages ask for and the released app never uses: drawing
 * over other apps is for the development menu, and the app reads and writes no files on shared
 * storage. Reading the person's pictures is how expo-screen-capture notices a screenshot on
 * Android 13; the app only uses it to keep the key screen out of captures, which needs no permission.
 */
export const RELEASE_BLOCKED_PERMISSIONS = [
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.READ_MEDIA_IMAGES",
];

/** A store build with a missing or development setting would be rejected by the backend, or worse, accepted by a dev one. */
export function assertReleaseConfig(variant: Variant, env: NodeJS.ProcessEnv): void {
  if (variant === "development") return;
  const problems: string[] = [];
  const api = env.EXPO_PUBLIC_API_URL ?? "";
  if (!/^https:\/\//.test(api)) problems.push("EXPO_PUBLIC_API_URL must be an https URL");
  if (env.EXPO_PUBLIC_DEV_ATTESTATION === "true") problems.push("EXPO_PUBLIC_DEV_ATTESTATION must be false");
  if (!env.EXPO_PUBLIC_TURNSTILE_SITE_KEY) problems.push("EXPO_PUBLIC_TURNSTILE_SITE_KEY is required (EAS environment variable)");
  if (problems.length) throw new Error(`Cannot build the ${variant} app:\n- ${problems.join("\n- ")}`);
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = variantOf(process.env);
  // Only enforce when EAS (or a release export) is building, not for every local `expo start`.
  if (process.env.EAS_BUILD === "true" || process.env.LONGYU_RELEASE_CHECK === "true") assertReleaseConfig(variant, process.env);
  const id = variant === "development" ? "app.longyu.mine.dev" : "app.longyu.mine";
  const name = variant === "development" ? "LONGYU Dev" : "LONGYU MINE";
  return {
    ...config,
    name,
    slug: config.slug ?? "longyu-mine",
    ios: {
      ...config.ios,
      bundleIdentifier: id,
      entitlements: {
        ...config.ios?.entitlements,
        "com.apple.developer.devicecheck.appattest-environment": variant === "development" ? "development" : "production",
      },
    },
    android: {
      ...config.android,
      package: id,
      ...(variant === "development" ? {} : { blockedPermissions: RELEASE_BLOCKED_PERMISSIONS }),
    },
    // extra.eas.projectId comes from app.json once `eas init` has run.
    extra: { ...config.extra, variant },
  };
};
