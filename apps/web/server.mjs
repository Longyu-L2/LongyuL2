// Serves the built pages (dist/) and nothing else. Usage: node server.mjs
//   PORT   default 8080
//   PAGES  the pages that are public, comma-separated: claim (index.html), pay, bridge, swap, safe. Default: all.
//          A page that depends on a service not running yet is left out, and its address answers 404.
//   LANDING_HOSTS  the names that serve the landing page, the developer page (/developers) and their own
//          files in place of the pages (longyu.network). They need a build that made them: see build.mjs.
//   REDIRECT_HOSTS, REDIRECT_TO  other names this service answers on (www.longyu.network) and the
//          address their visitors are sent to (https://longyu.network). Both or neither.
// Files are read once at start, so a request never touches the disk and no path can leave dist/.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const PAGE_FILES = { claim: ["index.html", "main.js"], pay: ["pay.html", "pay.js"], bridge: ["bridge.html", "bridge.js"], swap: ["swap.html", "swap.js"], safe: ["safe.html", "safe.js"] };
// Served whichever pages are public.
const SHARED_FILES = ["favicon.svg", "mark.svg"];
const LANDING_FILES = ["landing.html", "landing.js", "developers.html", "developers.js", "lockup.svg", "share.png", "Inter-Regular.woff2", "Inter-SemiBold.woff2", "Sora-SemiBold.woff2", "JetBrainsMono-Medium.woff2", "OFL.txt"];
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml", png: "image/png", woff2: "font/woff2", txt: "text/plain; charset=utf-8" };
// Compressed as they are: packing them again saves nothing.
const PACKED = new Set(["png", "woff2"]);

// Sent with every answer. Each page's own policy (its meta tag) limits scripts and connections;
// framing can only be refused from a header.
const SECURITY = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** The pages named by PAGES, in the order given. */
export function parsePages(text) {
  const names = (text ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return Object.keys(PAGE_FILES);
  for (const n of names) if (!Object.hasOwn(PAGE_FILES, n)) throw new Error(`PAGES: unknown page "${n}" (claim, pay, bridge, swap, safe)`);
  return [...new Set(names)];
}

/**
 * Reads the named files; `read` returns one built file's bytes.
 *
 * A page names its script, images and fonts by their content (bridge.js?v=…), so a release never
 * runs against a copy of the old script that a browser or a cache in between has kept.
 */
function load(names, read) {
  const versions = new Map();
  for (const name of names) if (!name.endsWith(".html")) versions.set(name, createHash("sha256").update(read(name)).digest("hex").slice(0, 12));
  const versioned = (name) => (versions.has(name) ? `./${name}?v=${versions.get(name)}` : `./${name}`);
  const stamp = (html) => html
    .replace(/\b(src|href)="\.\/([\w.-]+)"/g, (whole, attr, name) => `${attr}="${versioned(name)}"`)
    .replace(/\burl\("\.\/([\w.-]+)"\)/g, (whole, name) => `url("${versioned(name)}")`);
  const files = new Map();
  for (const name of names) {
    const body = name.endsWith(".html") ? Buffer.from(stamp(read(name).toString("utf8"))) : read(name);
    const kind = name.split(".").pop();
    files.set(`/${name}`, {
      type: TYPES[kind],
      etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`,
      version: versions.get(name) ?? null,
      raw: body,
      br: PACKED.has(kind) ? null : brotliCompressSync(body),
      gzip: PACKED.has(kind) ? null : gzipSync(body),
    });
  }
  return files;
}

/** The files of the chosen pages. */
export function loadFiles(pages, read) {
  const files = load([...pages.flatMap((page) => PAGE_FILES[page]), ...SHARED_FILES], read);
  // The front page is the claim page, or the first public page when the claim page is not public.
  const home = pages.includes("claim") ? "/index.html" : `/${PAGE_FILES[pages[0]][0]}`;
  return { files, home };
}

/** The landing and developer pages' files: what the names in LANDING_HOSTS serve, and all they serve. */
export function loadLanding(read) {
  return load([...LANDING_FILES, ...SHARED_FILES], read);
}

function hostNames(setting, text) {
  const names = (text ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const n of names) if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(n)) throw new Error(`${setting}: "${n}" is not a host name`);
  return names;
}

/** The names that serve the landing page, or null when none are set. None of them may be a name that only redirects. */
export function parseLandingHosts(hosts, redirect = null) {
  const names = hostNames("LANDING_HOSTS", hosts);
  if (names.length === 0) return null;
  for (const n of names) if (redirect?.hosts.has(n)) throw new Error(`LANDING_HOSTS: "${n}" is also one of REDIRECT_HOSTS`);
  return new Set(names);
}

/** The names that only send their visitors on, and where to. Null when none are set. */
export function parseRedirect(hosts, to) {
  const names = hostNames("REDIRECT_HOSTS", hosts);
  const target = (to ?? "").trim();
  if (names.length === 0 && !target) return null;
  if (names.length === 0 || !target) throw new Error("REDIRECT_HOSTS and REDIRECT_TO are set together");
  let url;
  try {
    url = new URL(target);
  } catch {
    throw new Error("REDIRECT_TO must be an https address");
  }
  if (url.protocol !== "https:" || url.origin !== target) throw new Error("REDIRECT_TO must be an https address with no path, like https://longyu.network");
  if (names.includes(url.hostname)) throw new Error("REDIRECT_TO must not be one of REDIRECT_HOSTS");
  return { hosts: new Set(names), to: url.origin };
}

/** `landing` is the names that serve the landing page and its files ({ hosts, files }), or null. */
export function createHandler({ files: pageFiles, home }, redirect = null, landing = null) {
  return (req, res) => {
    const send = (status, headers, body) => {
      res.writeHead(status, { ...SECURITY, ...headers, "content-length": body ? body.length : 0 });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const text = (status, message, headers = {}) => send(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers }, Buffer.from(message));
    if (req.method !== "GET" && req.method !== "HEAD") return text(405, "method not allowed", { allow: "GET, HEAD" });
    const [path, query] = (req.url ?? "/").split("?");
    if (path === "/health") return text(200, "ok");
    const host = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    // Not a lasting redirect: the name may carry a site of its own later, and browsers keep a 301 for good.
    if (redirect?.hosts.has(host)) {
      return send(302, { location: redirect.to + (path.startsWith("/") ? path : "/") + (query === undefined ? "" : `?${query}`), "cache-control": "no-store" }, null);
    }
    // A name serves the landing page or the pages, never both.
    const onLanding = landing?.hosts.has(host) === true;
    const files = onLanding ? landing.files : pageFiles;
    if (path === "/") {
      if (onLanding) return serve(files.get("/landing.html"));
      if (home === "/index.html") return serve(files.get(home));
      return send(302, { location: home, "cache-control": "no-store" }, null);
    }
    if (onLanding && path === "/developers") return serve(files.get("/developers.html"));
    // Browsers ask for this name on their own.
    if (path === "/favicon.ico") return send(301, { location: "/favicon.svg", "cache-control": "max-age=86400" }, null);
    const file = files.get(path);
    if (!file) return text(404, "not found");
    return serve(file);

    function serve(f) {
      // Asked for by its content, a file can be kept for good. By name alone, browsers ask each time
      // and get 304 when nothing changed.
      const pinned = f.version !== null && query === `v=${f.version}`;
      const headers = { "content-type": f.type, "cache-control": pinned ? "public, max-age=31536000, immutable" : "no-cache", etag: f.etag, vary: "accept-encoding" };
      if (req.headers["if-none-match"] === f.etag) return send(304, headers, null);
      const accepts = String(req.headers["accept-encoding"] ?? "");
      if (f.br && /\bbr\b/.test(accepts)) return send(200, { ...headers, "content-encoding": "br" }, f.br);
      if (f.gzip && /\bgzip\b/.test(accepts)) return send(200, { ...headers, "content-encoding": "gzip" }, f.gzip);
      return send(200, headers, f.raw);
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a port number");
  const pages = parsePages(process.env.PAGES);
  const read = (name) => readFileSync(new URL(`./dist/${name}`, import.meta.url));
  const redirect = parseRedirect(process.env.REDIRECT_HOSTS, process.env.REDIRECT_TO);
  const landingHosts = parseLandingHosts(process.env.LANDING_HOSTS, redirect);
  let landing = null;
  if (landingHosts) {
    try {
      landing = { hosts: landingHosts, files: loadLanding(read) };
    } catch (e) {
      if (e?.code === "ENOENT") throw new Error("LANDING_HOSTS is set, but this build has no landing page: build.mjs lists the settings it needs");
      throw e;
    }
  }
  const server = createServer(createHandler(loadFiles(pages, read), redirect, landing));
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  // Railway's edge keeps idle connections for 60 seconds; this side keeps them longer.
  server.keepAliveTimeout = 75_000;
  server.listen(port, process.env.HOST ?? "0.0.0.0", () => console.log(`LONGYU web on :${port}, pages: ${pages.join(", ")}${landingHosts ? `, landing page on ${[...landingHosts].join(", ")}` : ""}`));
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }
}
