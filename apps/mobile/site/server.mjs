// Serves LONGYU MINE's web build and the Android app's download, and nothing else. Usage: node server.mjs
//   PORT                  default 8080
//   EXPO_PUBLIC_API_URL   the API the build was made for: the one other address the page may call
//   ORIGIN_SECRET         set only behind Cloudflare, which adds it to every request (the
//                         x-longyu-origin header): requests without it are refused, except /health
// The build (dist/) and the download (downloads/*.apk, at most one) are read once at start, so a
// request never touches the disk and no path can leave those folders.
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

/** The app's screens (src/app). Each address opens the app; the app then shows the screen. */
export const ROUTES = ["/", "/sign-in", "/setup", "/mine", "/wallet", "/network", "/profile", "/boost", "/export-key"];

const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  png: "image/png",
  ttf: "font/ttf",
  woff2: "font/woff2",
};
/** Worth compressing; the rest already is. */
const TEXT = new Set(["html", "js", "css", "json", "svg", "ico", "ttf"]);
/** The build names these files after their contents, so a name's bytes never change. */
const HASHED = /^\/(?:_expo\/static|assets)\//;
const APK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.apk$/;
const APK_TYPE = "application/vnd.android.package-archive";

/**
 * What the page may load and call: its own files, the API, and Cloudflare's human check. The app
 * styles itself from script (React Native for Web), which is why inline styles are allowed.
 */
export function contentPolicy(apiUrl) {
  let api;
  try {
    api = new URL(apiUrl ?? "");
  } catch {
    throw new Error("EXPO_PUBLIC_API_URL must be the API's address, such as https://api.example.org");
  }
  const local = api.protocol === "http:" && (api.hostname === "localhost" || api.hostname === "127.0.0.1");
  if (api.protocol !== "https:" && !local) throw new Error("EXPO_PUBLIC_API_URL must be an https address");
  return [
    "default-src 'none'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    // pbs.twimg.com: the profile picture of the X account a person signed in with.
    "img-src 'self' data: blob: https://pbs.twimg.com",
    "font-src 'self' data:",
    `connect-src 'self' ${api.origin}`,
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * The app is drawn light only. A browser that darkens pages by itself (Chrome and Samsung
 * Internet do, in a phone's dark mode) is told to leave this one as it is.
 */
export function lightOnly(html) {
  const text = html.toString("utf8");
  const at = text.indexOf("<head>");
  if (at < 0 || text.includes('name="color-scheme"')) return html;
  const cut = at + "<head>".length;
  return Buffer.from(`${text.slice(0, cut)}<meta name="color-scheme" content="only light">${text.slice(cut)}`);
}

const etagOf = (body) => `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`;

/**
 * Prepares what is served. `files` maps each built file's path ("index.html", "_expo/static/js/web/x.js")
 * to its bytes; `downloads` maps the names in downloads/ to theirs (only an .apk is served).
 */
export function loadSite(files, downloads = new Map()) {
  const site = new Map();
  for (const [name, built] of files) {
    const body = name === "index.html" ? lightOnly(built) : built;
    const ext = name.split(".").pop();
    if (!Object.hasOwn(TYPES, ext)) throw new Error(`the build holds a file of an unknown type: ${name}`);
    site.set(`/${name}`, {
      type: TYPES[ext],
      etag: etagOf(body),
      raw: body,
      ...(TEXT.has(ext) ? { br: brotliCompressSync(body), gzip: gzipSync(body) } : {}),
    });
  }
  if (!site.has("/index.html")) throw new Error("the build has no index.html");
  const apks = [...downloads].filter(([name]) => name.endsWith(".apk"));
  if (apks.length > 1) throw new Error("downloads/ holds more than one .apk: keep only the current one");
  for (const [name] of apks) if (!APK_NAME.test(name)) throw new Error(`downloads/: "${name}" is not a name that can be served`);
  const apk = apks[0] ? { name: apks[0][0], raw: apks[0][1], etag: `"${createHash("sha256").update(apks[0][1]).digest("hex")}"` } : null;
  return { files: site, apk };
}

/**
 * The part of a file a Range header asks for: { start, end } (inclusive), "unsatisfiable", or null
 * for a header to ignore (then the whole file is sent, as the standard allows).
 */
export function parseRange(header, size) {
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const last = Number(m[2]);
    if (last === 0) return "unsatisfiable";
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return "unsatisfiable";
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return null;
  return { start, end };
}

const digest = (value) => createHash("sha256").update(value).digest();

export function createHandler({ files, apk }, policy, originSecret = null) {
  const secret = originSecret === null ? null : digest(originSecret);
  // Sent with every answer.
  const security = {
    "content-security-policy": policy,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
  const index = files.get("/index.html");

  return (req, res) => {
    const send = (status, headers, body) => {
      res.writeHead(status, { ...security, ...headers, "content-length": body ? body.length : 0 });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const text = (status, message, headers = {}) => send(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers }, Buffer.from(message));
    if (req.method !== "GET" && req.method !== "HEAD") return text(405, "method not allowed", { allow: "GET, HEAD" });
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") return text(200, "ok");
    if (secret) {
      const got = req.headers["x-longyu-origin"];
      if (typeof got !== "string" || !timingSafeEqual(digest(got), secret)) return text(403, "forbidden");
    }
    // The page is asked for again on every visit, so a new build reaches people at once.
    if (ROUTES.includes(path)) return serve(index, "no-cache");
    if (path.length > 1 && path.endsWith("/") && ROUTES.includes(path.slice(0, -1))) {
      return send(308, { location: path.slice(0, -1), "cache-control": "no-store" }, null);
    }
    if (path === "/download/android") {
      if (!apk) return text(404, "not found");
      return send(302, { location: `/download/${apk.name}`, "cache-control": "no-store" }, null);
    }
    if (apk && path === `/download/${apk.name}`) return download();
    // The page has one address per screen; it is not also served under its file name.
    const file = path === "/index.html" ? undefined : files.get(path);
    if (!file) return text(404, "not found");
    return serve(file, HASHED.test(path) ? "public, max-age=31536000, immutable" : "no-cache");

    function serve(f, cache) {
      const headers = { "content-type": f.type, "cache-control": cache, etag: f.etag, ...(f.br ? { vary: "accept-encoding" } : {}) };
      if (req.headers["if-none-match"] === f.etag) return send(304, headers, null);
      const accepts = String(req.headers["accept-encoding"] ?? "");
      if (f.br && /\bbr\b/.test(accepts)) return send(200, { ...headers, "content-encoding": "br" }, f.br);
      if (f.gzip && /\bgzip\b/.test(accepts)) return send(200, { ...headers, "content-encoding": "gzip" }, f.gzip);
      return send(200, headers, f.raw);
    }

    // The app is tens of megabytes: a download that broke off can carry on from where it stopped.
    function download() {
      const size = apk.raw.length;
      const headers = {
        "content-type": APK_TYPE,
        "content-disposition": `attachment; filename="${apk.name}"`,
        "cache-control": "public, max-age=300",
        "accept-ranges": "bytes",
        etag: apk.etag,
      };
      if (req.headers["if-none-match"] === apk.etag) return send(304, headers, null);
      const asked = req.headers.range;
      const unchanged = req.headers["if-range"] === undefined || req.headers["if-range"] === apk.etag;
      const range = typeof asked === "string" && unchanged ? parseRange(asked, size) : null;
      if (range === "unsatisfiable") return send(416, { ...headers, "content-range": `bytes */${size}` }, null);
      if (range) return send(206, { ...headers, "content-range": `bytes ${range.start}-${range.end}/${size}` }, apk.raw.subarray(range.start, range.end + 1));
      return send(200, headers, apk.raw);
    }
  };
}

/** Every file under `dir`, by its path from there with forward slashes. */
function readTree(dir) {
  const out = new Map();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = `${entry.parentPath}/${entry.name}`.replaceAll("\\", "/");
    out.set(full.slice(dir.replaceAll("\\", "/").length + 1), readFileSync(full));
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a port number");
  const policy = contentPolicy(process.env.EXPO_PUBLIC_API_URL);
  const originSecret = process.env.ORIGIN_SECRET?.trim() || null;
  if (originSecret !== null && originSecret.length < 32) throw new Error("ORIGIN_SECRET must be at least 32 characters");
  const built = readTree(fileURLToPath(new URL("./dist", import.meta.url)));
  // The export's own list of what it built: nothing the page loads.
  built.delete("metadata.json");
  const site = loadSite(built, readTree(fileURLToPath(new URL("./downloads", import.meta.url))));
  const server = createServer(createHandler(site, policy, originSecret));
  // Limits on receiving a request; sending the answer (the app's download can be slow) has none.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  // Railway's edge keeps idle connections for 60 seconds; this side keeps them longer.
  server.keepAliveTimeout = 75_000;
  server.listen(port, process.env.HOST ?? "0.0.0.0", () =>
    console.log(`LONGYU MINE web on :${port}, ${site.files.size} files, download: ${site.apk ? site.apk.name : "none"}, ` +
      `origin check: ${originSecret ? "on" : "off"}`));
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }
}
