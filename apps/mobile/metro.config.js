const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

/**
 * The variant APP_VARIANT picks (app.config.ts), for the app's code as process.env.EXPO_PUBLIC_APP_VARIANT.
 * A release build fixes it into the bundle and leaves out what only the other variants use: the mainnet
 * app (production) holds no testnet text or addresses. Set here, before the bundler starts its workers.
 */
const VARIANTS = ["development", "testnet", "production"];
const variant = process.env.APP_VARIANT || "development";
if (!VARIANTS.includes(variant)) throw new Error(`APP_VARIANT must be one of ${VARIANTS.join(", ")}`);
process.env.EXPO_PUBLIC_APP_VARIANT = variant;

const config = getDefaultConfig(__dirname);

/**
 * Design preview (LONGYU_PREVIEW=1, web only): screens render in a browser against sample data, so
 * the UI can be reviewed and screenshotted without a phone, a backend or device keys. The device
 * layer (src/lib/core.web.ts in a browser) is swapped for src/preview/core.ts. Android and iOS
 * builds never take this path, and neither does the public web build: the swap applies to the web
 * platform alone and only with the variable set.
 */
if (process.env.LONGYU_PREVIEW === "1") {
  const swaps = {
    "src/lib/core.ts": "src/preview/core.ts",
    "src/lib/core.web.ts": "src/preview/core.ts",
  };
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const resolved = context.resolveRequest(context, moduleName, platform);
    if (platform === "web" && resolved.type === "sourceFile") {
      const swap = swaps[path.relative(__dirname, resolved.filePath).split(path.sep).join("/")];
      if (swap) return { type: "sourceFile", filePath: path.join(__dirname, swap) };
    }
    return resolved;
  };
}

module.exports = config;
