// Serves the built pages (dist/) and nothing else. Usage: node server.mjs
//   PORT   default 8080
//   PAGES  the pages that are public, comma-separated: claim (index.html), pay, bridge, swap, launch, safe. Default: all.
//          A page the build did not make (launch without TOKEN_LAUNCHER) must not be named.
//          A page that depends on a service not running yet is left out, and its address answers 404.
//   LANDING_HOSTS  the names that serve the landing page, the developer page (/developers) and their own
//          files in place of the pages (longyu.network). They need a build that made them: see build.mjs.
//   REDIRECT_HOSTS, REDIRECT_TO  other names this service answers on (www.longyu.network) and the
//          address their visitors are sent to (https://longyu.network). Both or neither.
//   HOST_PAGES  names that serve only some of the pages, entries separated by ";", each host=page[,page...]:
//          "dex.longyu.network=swap,launch; bridge.longyu.network=bridge". The first page is served at "/",
//          and every page at /<page> (/launch) and at its own file (/launch.html; claim's is index.html).
//          Such a name serves its pages' files, the shared files and nothing else. Each page must be one
//          of PAGES, and no name may also be in LANDING_HOSTS or REDIRECT_HOSTS. Other names are as before.
// Files are read once at start, so a request never touches the disk and no path can leave dist/.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const PAGE_FILES = { claim: ["index.html", "main.js"], pay: ["pay.html", "pay.js"], bridge: ["bridge.html", "bridge.js"], swap: ["swap.html", "swap.js"], launch: ["launch.html", "launch.js"], safe: ["safe.html", "safe.js"] };
// Served whichever pages are public, and on the landing page's names too.
const SHARED_FILES = ["favicon.svg", "mark.svg", "app.css", "lockup.svg", "Inter-Regular.woff2", "Inter-SemiBold.woff2", "Sora-SemiBold.woff2", "JetBrainsMono-Medium.woff2", "OFL.txt", "bnb.png", "wallet-metamask.png", "wallet-trust.svg", "wallet-coinbase.png", "wallet-okx.png", "wallet-rabby.png"];
const LANDING_FILES = ["landing.html", "landing.js", "developers.html", "developers.js", "share.png"];
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml", png: "image/png", woff2: "font/woff2", txt: "text/plain; charset=utf-8" };
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
  for (const n of names) if (!Object.hasOwn(PAGE_FILES, n)) throw new Error(`PAGES: unknown page "${n}" (claim, pay, bridge, swap, launch, safe)`);
  return [...new Set(names)];
}

/**
 * Reads the named files; `read` returns one built file's bytes.
 *
 * A page names its script, styles, images and fonts by their content (bridge.js?v=…), so a release never
 * runs against a copy of the old script that a browser or a cache in between has kept. The styles name
 * their fonts the same way, so a new font gives the styles a new address, and the page with them.
 */
function load(names, read) {
  const versions = new Map();
  const bodies = new Map();
  const version = (name) => versions.set(name, createHash("sha256").update(bodies.get(name)).digest("hex").slice(0, 12));
  const versioned = (name) => (versions.has(name) ? `./${name}?v=${versions.get(name)}` : `./${name}`);
  const stamp = (file) => Buffer.from(read(file).toString("utf8")
    .replace(/\b(src|href)="\.\/([\w.-]+)"/g, (whole, attr, name) => `${attr}="${versioned(name)}"`)
    .replace(/\burl\("\.\/([\w.-]+)"\)/g, (whole, name) => `url("${versioned(name)}")`));
  const styles = names.filter((name) => name.endsWith(".css"));
  const pages = names.filter((name) => name.endsWith(".html"));
  // Scripts, images and fonts first, then the styles that name them, then the pages that name all of them.
  for (const name of names) {
    if (styles.includes(name) || pages.includes(name)) continue;
    bodies.set(name, read(name));
    version(name);
  }
  for (const name of styles) {
    bodies.set(name, stamp(name));
    version(name);
  }
  for (const name of pages) bodies.set(name, stamp(name));
  const files = new Map();
  for (const name of names) {
    const body = bodies.get(name);
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

/**
 * The names that serve only some of the pages, each with its pages in order, or null when none are set.
 * `pages` is the public pages (PAGES); `landing` and `redirect` are the other settings' names, which these must not be.
 */
export function parseHostPages(text, pages, { landing = null, redirect = null } = {}) {
  const entries = (text ?? "").split(";").map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  const hosts = new Map();
  for (const entry of entries) {
    const at = entry.indexOf("=");
    const names = at < 0 ? [] : hostNames("HOST_PAGES", entry.slice(0, at));
    if (names.length !== 1) throw new Error(`HOST_PAGES: "${entry}" is not host=page[,page...]`);
    const host = names[0];
    if (hosts.has(host)) throw new Error(`HOST_PAGES: "${host}" is named twice`);
    if (landing?.has(host)) throw new Error(`HOST_PAGES: "${host}" is also one of LANDING_HOSTS`);
    if (redirect?.hosts.has(host)) throw new Error(`HOST_PAGES: "${host}" is also one of REDIRECT_HOSTS`);
    const list = entry.slice(at + 1).split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) throw new Error(`HOST_PAGES: "${host}" names no page`);
    for (const [i, page] of list.entries()) {
      if (!Object.hasOwn(PAGE_FILES, page)) throw new Error(`HOST_PAGES: unknown page "${page}" (claim, pay, bridge, swap, launch, safe)`);
      if (!pages.includes(page)) throw new Error(`HOST_PAGES: page "${page}" is not one of PAGES`);
      if (list.indexOf(page) !== i) throw new Error(`HOST_PAGES: page "${page}" is named twice for "${host}"`);
    }
    hosts.set(host, list);
  }
  return hosts;
}

/**
 * `landing` is the names that serve the landing page and its files ({ hosts, files }), or null.
 * `hostPages` is the names that serve only some of the pages (parseHostPages), or null.
 */
export function createHandler({ files: pageFiles, home }, redirect = null, landing = null, hostPages = null) {
  // Each such name's addresses: its first page at "/", every page at its name and at its files, and the shared files.
  const mapped = new Map();
  for (const [host, pages] of hostPages ?? []) {
    const routes = new Map();
    const add = (path, name) => {
      const file = pageFiles.get(`/${name}`);
      if (!file) throw new Error(`HOST_PAGES: "${host}" names a page that is not served: "${name}"`);
      routes.set(path, file);
    };
    for (const name of SHARED_FILES) add(`/${name}`, name);
    for (const page of pages) {
      add(`/${page}`, PAGE_FILES[page][0]);
      for (const name of PAGE_FILES[page]) add(`/${name}`, name);
    }
    add("/", PAGE_FILES[pages[0]][0]);
    mapped.set(host, routes);
  }
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
    // Browsers ask for this name on their own.
    if (path === "/favicon.ico") return send(301, { location: "/favicon.svg", "cache-control": "max-age=86400" }, null);
    const routes = mapped.get(host);
    if (routes) {
      const file = routes.get(path);
      return file ? serve(file) : text(404, "not found");
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
  const hostPages = parseHostPages(process.env.HOST_PAGES, pages, { landing: landingHosts, redirect });
  let landing = null;
  if (landingHosts) {
    try {
      landing = { hosts: landingHosts, files: loadLanding(read) };
    } catch (e) {
      if (e?.code === "ENOENT") throw new Error("LANDING_HOSTS is set, but this build has no landing page: build.mjs lists the settings it needs");
      throw e;
    }
  }
  const server = createServer(createHandler(loadFiles(pages, read), redirect, landing, hostPages));
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  // Railway's edge keeps idle connections for 60 seconds; this side keeps them longer.
  server.keepAliveTimeout = 75_000;
  server.listen(port, process.env.HOST ?? "0.0.0.0", () => console.log(`LONGYU web on :${port}, pages: ${pages.join(", ")}${landingHosts ? `, landing page on ${[...landingHosts].join(", ")}` : ""}${hostPages ? `, ${[...hostPages].map(([host, names]) => `${names.join(", ")} on ${host}`).join("; ")}` : ""}`));
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }
}
