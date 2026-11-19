const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

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
