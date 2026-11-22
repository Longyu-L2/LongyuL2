import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
// @ts-expect-error a plain JavaScript module without type declarations
import { createHandler, loadFiles, loadLanding, parseHostPages, parseLandingHosts, parsePages, parseRedirect } from "./server.mjs";
import { request } from "node:http";

const built: Record<string, string> = {
  "index.html": "<!doctype html><title>claim</title>", "main.js": "console.log('claim');".repeat(200),
  "pay.html": "<!doctype html><title>pay</title>", "pay.js": "console.log('pay');",
  "bridge.html": "<!doctype html><title>bridge</title>", "bridge.js": "console.log('bridge');".repeat(200),
  "swap.html": "<!doctype html><title>swap</title>", "swap.js": "console.log('swap');",
  "launch.html": "<!doctype html><title>launch</title>", "launch.js": "console.log('launch');",
  "safe.html": "<!doctype html><title>safe</title>", "safe.js": "console.log('safe');",
  "favicon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>', "mark.svg": '<svg xmlns="http://www.w3.org/2000/svg"><title>LONGYU</title></svg>',
  "app.css": '@font-face { font-family: Inter; src: url("./Inter-Regular.woff2") format("woff2"); } body { font-family: Inter; }'.repeat(20),
  "lockup.svg": '<svg xmlns="http://www.w3.org/2000/svg"><title>lockup</title></svg>',
  "Inter-Regular.woff2": "regular ".repeat(100), "Inter-SemiBold.woff2": "semibold ".repeat(100), "Sora-SemiBold.woff2": "sora ".repeat(100), "JetBrainsMono-Medium.woff2": "mono ".repeat(100),
  "OFL.txt": "SIL OPEN FONT LICENSE Version 1.1",
  "bnb.png": "png ".repeat(50), "wallet-metamask.png": "png ".repeat(50), "wallet-trust.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "wallet-coinbase.png": "png ".repeat(50), "wallet-okx.png": "png ".repeat(50), "wallet-rabby.png": "png ".repeat(50),
};
const shared = ["/favicon.svg", "/mark.svg", "/app.css", "/lockup.svg", "/Inter-Regular.woff2", "/Inter-SemiBold.woff2", "/Sora-SemiBold.woff2", "/JetBrainsMono-Medium.woff2", "/OFL.txt", "/bnb.png", "/wallet-metamask.png", "/wallet-trust.svg", "/wallet-coinbase.png", "/wallet-okx.png", "/wallet-rabby.png"];
const servers: Server[] = [];
async function site(pages?: string): Promise<string> {
  const server = createServer(createHandler(loadFiles(parsePages(pages), (name: string) => Buffer.from(built[name]!))));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

test("pages: the list is checked", () => {
  assert.deepEqual(parsePages(undefined), ["claim", "pay", "bridge", "swap", "launch", "safe"]);
  assert.deepEqual(parsePages("bridge,swap"), ["bridge", "swap"]);
  assert.deepEqual(parsePages(" bridge , pay,bridge "), ["bridge", "pay"]);
  assert.throws(() => parsePages("bridge,admin"), /unknown page "admin"/);
  assert.throws(() => parsePages("constructor"), /unknown page/);
});

test("every page is served with its headers, compressed when asked", async () => {
  const url = await site();
  const home = await fetch(`${url}/`, { headers: { "accept-encoding": "identity" } });
  assert.equal(home.status, 200);
  assert.equal(await home.text(), built["index.html"]);
  assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(home.headers.get("x-content-type-options"), "nosniff");
  assert.equal(home.headers.get("x-frame-options"), "DENY");
  assert.equal(home.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.equal(home.headers.get("cache-control"), "no-cache");
  assert.match(home.headers.get("strict-transport-security") ?? "", /max-age=31536000/);

  const raw = async (encoding: string) => {
    const r = await fetch(`${url}/bridge.js`, { headers: { "accept-encoding": encoding } });
    return { r, body: Buffer.from(await r.arrayBuffer()) };
  };
  const plain = await raw("identity");
  assert.equal(plain.r.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(plain.r.headers.get("content-encoding"), null);
  assert.equal(plain.body.toString(), built["bridge.js"]);
  // fetch decodes the answer itself: the same text arrives, in fewer bytes on the wire.
  for (const encoding of ["br", "gzip", "gzip, deflate, br"]) {
    const { r, body } = await raw(encoding);
    assert.equal(r.status, 200);
    assert.equal(body.toString(), built["bridge.js"], encoding);
    assert.equal(r.headers.get("vary"), "accept-encoding");
  }
  for (const page of ["/pay.html", "/pay.js", "/main.js", "/bridge.html", "/index.html", "/swap.html", "/swap.js", "/launch.html", "/launch.js", "/safe.html", "/safe.js"]) assert.equal((await fetch(url + page)).status, 200, page);
  assert.equal((await fetch(`${url}/bridge.html?ref=x`)).status, 200);
});

test("a page names its script and images by their content, and only that address is kept for long", async () => {
  const page = '<!doctype html><link rel="icon" href="./favicon.svg" /><a href="./swap.html">Swap</a><a href="./other.js">x</a><img src="./mark.svg" /><script type="module" src="./bridge.js"></script>';
  const read = (changed: Record<string, string>) => (name: string) => Buffer.from({ ...built, "bridge.html": page, ...changed }[name]!);
  const { files } = loadFiles(["bridge", "swap"], read({}));
  const html: string = files.get("/bridge.html").raw.toString();
  const stamped = [...html.matchAll(/"\.\/([\w.]+)\?v=([0-9a-f]{12})"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(stamped.map(([name]) => name), ["favicon.svg", "mark.svg", "bridge.js"]);
  // Links to pages, and to anything that is not served, stay as written.
  assert.ok(html.includes('href="./swap.html"') && html.includes('href="./other.js"'));

  const server = createServer(createHandler({ files, home: "/bridge.html" }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [name, version] of stamped) {
    assert.equal((await fetch(`${url}/${name}?v=${version}`)).headers.get("cache-control"), "public, max-age=31536000, immutable", name);
    for (const other of ["", "?v=000000000000", `?v=${version}&x=1`, "?x=1"]) assert.equal((await fetch(`${url}/${name}${other}`)).headers.get("cache-control"), "no-cache", name + other);
  }
  assert.equal((await fetch(`${url}/bridge.html?v=${stamped[2]![1]}`)).headers.get("cache-control"), "no-cache");

  // A new script gets a new address, and with it a new page.
  const next = loadFiles(["bridge", "swap"], read({ "bridge.js": "console.log('next');" })).files;
  const after: string = next.get("/bridge.html").raw.toString();
  assert.notEqual(/bridge\.js\?v=([0-9a-f]+)/.exec(after)![1], stamped[2]![1]);
  assert.equal(/mark\.svg\?v=([0-9a-f]+)/.exec(after)![1], stamped[1]![1]);
  assert.notEqual(next.get("/bridge.html").etag, files.get("/bridge.html").etag);
});

test("the stored compressed copies decode to the built file", () => {
  const { files } = loadFiles(["bridge"], (name: string) => Buffer.from(built[name]!));
  const f = files.get("/bridge.js");
  assert.equal(brotliDecompressSync(f.br).toString(), built["bridge.js"]);
  assert.equal(gunzipSync(f.gzip).toString(), built["bridge.js"]);
  assert.ok(f.br.length < f.raw.length / 10);
  assert.deepEqual([...files.keys()], ["/bridge.html", "/bridge.js", ...shared]);
});

test("the styles name their fonts by their content, and the page names the styles by theirs", async () => {
  const page = '<!doctype html><link rel="stylesheet" href="./app.css" /><script type="module" src="./bridge.js"></script>';
  const read = (changed: Record<string, string>) => (name: string) => Buffer.from({ ...built, "bridge.html": page, ...changed }[name]!);
  const { files } = loadFiles(["bridge"], read({}));
  const css = files.get("/app.css");
  const font = files.get("/Inter-Regular.woff2").version;
  assert.match(font, /^[0-9a-f]{12}$/);
  assert.equal(css.type, "text/css; charset=utf-8");
  assert.ok(css.raw.toString().includes(`url("./Inter-Regular.woff2?v=${font}")`));
  assert.ok(!css.raw.toString().includes('url("./Inter-Regular.woff2")'));
  assert.equal(brotliDecompressSync(css.br).toString(), css.raw.toString());
  assert.ok(files.get("/bridge.html").raw.toString().includes(`href="./app.css?v=${css.version}"`));

  // A new font, with the same styles as written, gives the styles and the page new addresses.
  const next = loadFiles(["bridge"], read({ "Inter-Regular.woff2": "next ".repeat(100) })).files;
  assert.notEqual(next.get("/app.css").version, css.version);
  assert.ok(next.get("/app.css").raw.toString().includes(`url("./Inter-Regular.woff2?v=${next.get("/Inter-Regular.woff2").version}")`));
  assert.ok(next.get("/bridge.html").raw.toString().includes(`href="./app.css?v=${next.get("/app.css").version}"`));
  // Another font changes nothing here.
  assert.equal(loadFiles(["bridge"], read({ "Sora-SemiBold.woff2": "other ".repeat(100) })).files.get("/app.css").version, css.version);
});

test("an unchanged file is not sent twice", async () => {
  const url = await site();
  const first = await fetch(`${url}/bridge.js`);
  const etag = first.headers.get("etag")!;
  assert.match(etag, /^"[\w-]{22}"$/);
  const again = await fetch(`${url}/bridge.js`, { headers: { "if-none-match": etag } });
  assert.equal(again.status, 304);
  assert.equal((await again.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(`${url}/bridge.js`, { headers: { "if-none-match": '"other"' } })).status, 200);
});

test("only the chosen pages are public", async () => {
  const url = await site("bridge");
  const home = await fetch(`${url}/`, { redirect: "manual" });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get("location"), "/bridge.html");
  assert.equal(home.headers.get("x-frame-options"), "DENY");
  assert.equal((await fetch(`${url}/bridge.html`)).status, 200);
  assert.equal((await fetch(`${url}/bridge.js`)).status, 200);
  for (const hidden of ["/index.html", "/main.js", "/pay.html", "/pay.js", "/swap.html", "/swap.js", "/launch.html", "/launch.js", "/safe.html", "/safe.js"]) assert.equal((await fetch(url + hidden)).status, 404, hidden);
  // The icon belongs to every page.
  const icon = await fetch(`${url}/favicon.ico`);
  assert.equal(icon.url, `${url}/favicon.svg`);
  assert.equal(icon.headers.get("content-type"), "image/svg+xml");
  assert.equal(await icon.text(), built["favicon.svg"]);
});

test("another name of the site sends its visitors on, path and all", async () => {
  assert.equal(parseRedirect(undefined, undefined), null);
  assert.equal(parseRedirect(" ", ""), null);
  assert.throws(() => parseRedirect("longyu.network", ""), /set together/);
  assert.throws(() => parseRedirect("", "https://testnet.longyu.network"), /set together/);
  assert.throws(() => parseRedirect("longyu.network", "http://testnet.longyu.network"), /https address/);
  assert.throws(() => parseRedirect("longyu.network", "https://testnet.longyu.network/bridge.html"), /no path/);
  assert.throws(() => parseRedirect("longyu.network", "not an address"), /https address/);
  assert.throws(() => parseRedirect("longyu.network/x", "https://testnet.longyu.network"), /not a host name/);
  assert.throws(() => parseRedirect("testnet.longyu.network", "https://testnet.longyu.network"), /must not be one of/);
  const redirect = parseRedirect("longyu.network, WWW.longyu.network", "https://testnet.longyu.network");
  assert.deepEqual([...redirect.hosts], ["longyu.network", "www.longyu.network"]);

  const server = createServer(createHandler(loadFiles(parsePages(undefined), (name: string) => Buffer.from(built[name]!)), redirect));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const ask = (host: string, path: string) => new Promise<{ status: number; location: string | undefined; cache: string | undefined }>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode!, location: res.headers.location, cache: res.headers["cache-control"] });
    }).on("error", reject).end();
  });
  assert.deepEqual(await ask("longyu.network", "/"), { status: 302, location: "https://testnet.longyu.network/", cache: "no-store" });
  assert.deepEqual(await ask("WWW.LONGYU.NETWORK:443", "/bridge.html?x=1&y=2"), { status: 302, location: "https://testnet.longyu.network/bridge.html?x=1&y=2", cache: "no-store" });
  // A path cannot name another site: it stays a path on the address the visitors are sent to.
  assert.equal((await ask("longyu.network", "//example.org/a")).location, "https://testnet.longyu.network//example.org/a");
  // The site's own name, and the platform's health check, are answered as before.
  assert.equal((await ask("testnet.longyu.network", "/bridge.html")).status, 200);
  assert.equal((await ask("longyu.network", "/health")).status, 200);
  assert.equal((await ask("longyu.network.example.org", "/")).status, 200);
});

test("nothing else is served", async () => {
  const url = await site();
  for (const path of ["/server.mjs", "/package.json", "/../package.json", "/%2e%2e/package.json", "/dist/bridge.js", "/bridge.js/", "/BRIDGE.JS", "//bridge.js", "/.env", "/bridge.html%00"]) {
    const r = await fetch(url + path);
    assert.equal(r.status, 404, path);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal(await (await fetch(`${url}/health`)).text(), "ok");
  const post = await fetch(`${url}/bridge.html`, { method: "POST", body: "x" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  const head = await fetch(`${url}/bridge.html`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("the landing page has names of its own, which serve it and nothing of the pages", async () => {
  const landingBuilt: Record<string, string> = {
    ...built,
    "landing.html": '<!doctype html><title>landing</title><link rel="preload" href="./Inter-SemiBold.woff2" as="font" /><style>@font-face { src: url("./Inter-SemiBold.woff2") format("woff2"); } .x { background: url("./other.png"); }</style><img src="./lockup.svg" /><a href="./">home</a><script type="module" src="./landing.js"></script>',
    "developers.html": '<!doctype html><title>developers</title><img src="./lockup.svg" /><a href="./">home</a><a href="./developers">here</a><script type="module" src="./developers.js"></script>',
    "developers.js": "console.log('developers');".repeat(200),
    "landing.js": "console.log('landing');".repeat(200), "lockup.svg": '<svg xmlns="http://www.w3.org/2000/svg"><title>lockup</title></svg>', "share.png": "png bytes ".repeat(100),
    "Inter-Regular.woff2": "regular ".repeat(100), "Inter-SemiBold.woff2": "semibold ".repeat(100), "Sora-SemiBold.woff2": "sora ".repeat(100), "JetBrainsMono-Medium.woff2": "mono ".repeat(100),
    "OFL.txt": "SIL OPEN FONT LICENSE Version 1.1",
  };
  const read = (name: string) => Buffer.from(landingBuilt[name]!);

  assert.equal(parseLandingHosts(undefined), null);
  assert.equal(parseLandingHosts(" , "), null);
  assert.deepEqual([...parseLandingHosts(" Longyu.Network ")], ["longyu.network"]);
  assert.throws(() => parseLandingHosts("longyu.network/x"), /LANDING_HOSTS: "longyu.network\/x" is not a host name/);
  const redirect = parseRedirect("www.longyu.network", "https://longyu.network");
  assert.throws(() => parseLandingHosts("longyu.network,www.longyu.network", redirect), /also one of REDIRECT_HOSTS/);
  const landing = { hosts: parseLandingHosts("longyu.network", redirect), files: loadLanding(read) };
  // A build without the landing page cannot serve it: the start fails on the first missing file.
  assert.throws(() => loadLanding((name: string) => Buffer.from(built[name]!)));

  const server = createServer(createHandler(loadFiles(parsePages("claim,bridge"), read), redirect, landing));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const ask = (host: string, path: string, encoding = "identity") => new Promise<{ status: number; type: string | undefined; encoding: string | undefined; cache: string | undefined; location: string | undefined; body: string }>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers: { host, "accept-encoding": encoding } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, type: res.headers["content-type"], encoding: res.headers["content-encoding"], cache: res.headers["cache-control"], location: res.headers.location, body: Buffer.concat(chunks).toString() }));
    }).on("error", reject).end();
  });

  const page = await ask("longyu.network", "/");
  assert.equal(page.status, 200);
  assert.equal(page.type, "text/html; charset=utf-8");
  assert.equal(page.cache, "no-cache");
  assert.ok(page.body.includes("<title>landing</title>"));
  // Fonts named in the page's styles are named by their content too, the same way in both places.
  const font = /url\("\.\/Inter-SemiBold\.woff2\?v=([0-9a-f]{12})"\)/.exec(page.body)![1]!;
  assert.ok(page.body.includes(`href="./Inter-SemiBold.woff2?v=${font}"`));
  assert.ok(page.body.includes('url("./other.png")') && page.body.includes('href="./"'));
  assert.match(page.body, /src="\.\/lockup\.svg\?v=[0-9a-f]{12}"/);
  assert.match(page.body, /src="\.\/landing\.js\?v=[0-9a-f]{12}"/);

  // The developer page has a path of its own, and its script is named by its content like the landing page's.
  const guide = await ask("longyu.network", "/developers");
  assert.deepEqual([guide.status, guide.type, guide.cache], [200, "text/html; charset=utf-8", "no-cache"]);
  assert.ok(guide.body.includes("<title>developers</title>") && guide.body.includes('href="./developers"') && guide.body.includes('src="./developers.js?v='));
  assert.equal((await ask("longyu.network", "/developers.html")).body, guide.body);
  assert.equal((await ask("longyu.network", "/developers.js", "br")).encoding, "br");
  for (const near of ["/developers/", "/Developers", "/developer"]) assert.equal((await ask("longyu.network", near)).status, 404, near);

  const pinned = await ask("longyu.network", `/Inter-SemiBold.woff2?v=${font}`, "gzip, deflate, br");
  assert.deepEqual([pinned.status, pinned.type, pinned.encoding, pinned.cache], [200, "font/woff2", undefined, "public, max-age=31536000, immutable"]);
  assert.equal(pinned.body, landingBuilt["Inter-SemiBold.woff2"]);
  const image = await ask("longyu.network", "/share.png", "br");
  assert.deepEqual([image.status, image.type, image.encoding], [200, "image/png", undefined]);
  assert.equal((await ask("longyu.network", "/landing.js", "br")).encoding, "br");
  assert.equal((await ask("longyu.network", "/OFL.txt")).type, "text/plain; charset=utf-8");
  for (const own of ["/landing.html", "/landing.js", "/lockup.svg", "/Inter-Regular.woff2", "/Sora-SemiBold.woff2", "/JetBrainsMono-Medium.woff2", "/favicon.svg", "/mark.svg", "/health"]) assert.equal((await ask("LONGYU.network:443", own)).status, 200, own);
  assert.equal((await ask("longyu.network", "/favicon.ico")).location, "/favicon.svg");
  for (const other of ["/index.html", "/main.js", "/bridge.html", "/bridge.js", "/swap.html", "/server.mjs", "/fonts/Inter-Regular.woff2"]) assert.equal((await ask("longyu.network", other)).status, 404, other);

  // The pages' name is as it was, and has none of the landing page.
  const claim = await ask("testnet.longyu.network", "/");
  assert.equal(claim.body, built["index.html"]);
  assert.equal((await ask("testnet.longyu.network", "/bridge.html")).status, 200);
  for (const other of ["/landing.html", "/landing.js", "/developers", "/developers.html", "/developers.js", "/share.png"]) assert.equal((await ask("testnet.longyu.network", other)).status, 404, other);
  // The shared styles, images and fonts belong to the pages as well.
  for (const own of ["/lockup.svg", "/Inter-Regular.woff2", "/OFL.txt", "/app.css"]) assert.equal((await ask("testnet.longyu.network", own)).status, 200, own);
  // And www goes to the landing page's name.
  const www = await ask("www.longyu.network", "/?ref=x");
  assert.deepEqual([www.status, www.location], [302, "https://longyu.network/?ref=x"]);

  // Without the setting, the landing page is on no name.
  const plain = createServer(createHandler(loadFiles(parsePages("claim"), read)));
  servers.push(plain);
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
  const plainUrl = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${plainUrl}/landing.html`)).status, 404);
  assert.equal((await fetch(`${plainUrl}/developers`)).status, 404);
  assert.equal(await (await fetch(`${plainUrl}/`)).text(), built["index.html"]);
});

test("names that serve some of the pages are checked", () => {
  const pages = parsePages(undefined);
  assert.equal(parseHostPages(undefined, pages), null);
  assert.equal(parseHostPages(" ; ", pages), null);
  assert.deepEqual([...parseHostPages("dex.longyu.network=swap,launch; bridge.longyu.network=bridge", pages)], [["dex.longyu.network", ["swap", "launch"]], ["bridge.longyu.network", ["bridge"]]]);
  assert.deepEqual([...parseHostPages(" DEX.Longyu.Network = launch , swap ; ", pages)], [["dex.longyu.network", ["launch", "swap"]]]);
  for (const bad of ["dex.longyu.network", "=swap", "a.longyu.network,b.longyu.network=swap"]) assert.throws(() => parseHostPages(bad, pages), /HOST_PAGES: ".*" is not host=page\[,page\.\.\.\]/, bad);
  assert.throws(() => parseHostPages("dex.longyu.network=", pages), /HOST_PAGES: "dex.longyu.network" names no page/);
  assert.throws(() => parseHostPages("dex.longyu.network= , ", pages), /names no page/);
  assert.throws(() => parseHostPages("dex.longyu.network/x=swap", pages), /HOST_PAGES: "dex.longyu.network\/x" is not a host name/);
  assert.throws(() => parseHostPages("dex=swap", pages), /HOST_PAGES: "dex" is not a host name/);
  assert.throws(() => parseHostPages("dex.longyu.network=swap; DEX.longyu.network=launch", pages), /HOST_PAGES: "dex.longyu.network" is named twice/);
  assert.throws(() => parseHostPages("dex.longyu.network=admin", pages), /HOST_PAGES: unknown page "admin"/);
  assert.throws(() => parseHostPages("dex.longyu.network=constructor", pages), /HOST_PAGES: unknown page/);
  assert.throws(() => parseHostPages("dex.longyu.network=Swap", pages), /HOST_PAGES: unknown page "Swap"/);
  assert.throws(() => parseHostPages("dex.longyu.network=swap,launch", parsePages("swap,bridge")), /HOST_PAGES: page "launch" is not one of PAGES/);
  assert.throws(() => parseHostPages("dex.longyu.network=swap,launch,swap", pages), /HOST_PAGES: page "swap" is named twice for "dex.longyu.network"/);
  const redirect = parseRedirect("www.longyu.network", "https://longyu.network");
  const landing = parseLandingHosts("longyu.network", redirect);
  assert.throws(() => parseHostPages("longyu.network=swap", pages, { landing, redirect }), /HOST_PAGES: "longyu.network" is also one of LANDING_HOSTS/);
  assert.throws(() => parseHostPages("www.longyu.network=swap", pages, { landing, redirect }), /HOST_PAGES: "www.longyu.network" is also one of REDIRECT_HOSTS/);
  assert.equal(parseHostPages("dex.longyu.network=swap", pages, { landing, redirect }).size, 1);
});

test("a name of its own serves its pages from the top, and nothing of the other pages", async () => {
  const template = '<!doctype html><title>PAGE</title><link rel="icon" href="./favicon.svg" /><link rel="stylesheet" href="./app.css" /><img src="./lockup.svg" /><a href="./launch.html">Launch</a><script type="module" src="./PAGE.js"></script>';
  const own: Record<string, string> = { ...built, "swap.html": template.replaceAll("PAGE", "swap"), "launch.html": template.replaceAll("PAGE", "launch"), "bridge.html": template.replaceAll("PAGE", "bridge") };
  const pages = parsePages(undefined);
  const loaded = loadFiles(pages, (name: string) => Buffer.from(own[name]!));
  const server = createServer(createHandler(loaded, null, null, parseHostPages("dex.longyu.network=swap,launch; bridge.longyu.network=bridge", pages)));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  type Answer = { status: number; type: string | undefined; encoding: string | undefined; cache: string | undefined; location: string | undefined; etag: string | undefined; frame: string | undefined; body: string };
  const ask = (host: string, path: string, headers: Record<string, string> = {}, method = "GET") => new Promise<Answer>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, method, headers: { host, "accept-encoding": "identity", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, type: res.headers["content-type"], encoding: res.headers["content-encoding"], cache: res.headers["cache-control"], location: res.headers.location, etag: res.headers.etag, frame: res.headers["x-frame-options"] as string | undefined, body: Buffer.concat(chunks).toString() }));
    }).on("error", reject).end();
  });
  const swapHtml: string = loaded.files.get("/swap.html").raw.toString();
  const launchHtml: string = loaded.files.get("/launch.html").raw.toString();

  const top = await ask("DEX.longyu.network:443", "/");
  assert.deepEqual([top.status, top.type, top.cache, top.frame], [200, "text/html; charset=utf-8", "no-cache", "DENY"]);
  assert.ok(top.body.includes("<title>swap</title>"));
  // The same page, named by the same content, as on the pages' own name.
  assert.equal(top.body, swapHtml);
  assert.equal(top.etag, loaded.files.get("/swap.html").etag);
  assert.equal((await ask("dex.longyu.network", "/", { "if-none-match": top.etag! })).status, 304);
  assert.equal((await ask("dex.longyu.network", "/", { "accept-encoding": "br" })).encoding, "br");
  assert.equal((await ask("dex.longyu.network", "/swap")).body, swapHtml);
  assert.equal((await ask("dex.longyu.network", "/swap.html")).body, swapHtml);
  assert.equal((await ask("dex.longyu.network", "/launch.html")).body, launchHtml);
  const launch = await ask("dex.longyu.network", "/launch?ref=x");
  assert.equal(launch.body, launchHtml);
  assert.ok(launch.body.includes("<title>launch</title>"));

  // The page's own addresses are at the top of the name, so they work from "/launch" as from "/".
  const script = /src="(\.\/launch\.js\?v=[0-9a-f]{12})"/.exec(launch.body)![1]!;
  const styles = /href="(\.\/app\.css\?v=[0-9a-f]{12})"/.exec(launch.body)![1]!;
  for (const address of [script, styles]) {
    const at = new URL(address, "https://dex.longyu.network/launch");
    const r = await ask("dex.longyu.network", at.pathname + at.search);
    assert.deepEqual([r.status, r.cache], [200, "public, max-age=31536000, immutable"], address);
  }
  assert.equal((await ask("dex.longyu.network", "/app.css")).type, "text/css; charset=utf-8");
  assert.equal((await ask("dex.longyu.network", "/swap.js")).body, built["swap.js"]);
  for (const file of shared) assert.equal((await ask("dex.longyu.network", file)).status, 200, file);
  assert.equal((await ask("dex.longyu.network", "/health")).body, "ok");
  const icon = await ask("dex.longyu.network", "/favicon.ico");
  assert.deepEqual([icon.status, icon.location], [301, "/favicon.svg"]);
  for (const other of ["/bridge.html", "/bridge.js", "/bridge", "/index.html", "/main.js", "/pay.html", "/safe.html", "/claim", "/launch/", "/swap/", "/Launch", "/launch.html/", "/landing.html", "/developers", "/server.mjs", "//swap.js"]) {
    const r = await ask("dex.longyu.network", other);
    assert.deepEqual([r.status, r.frame], [404, "DENY"], other);
  }
  assert.equal((await ask("dex.longyu.network", "/", {}, "POST")).status, 405);

  // The bridge's name has the bridge alone.
  const bridgeHtml: string = loaded.files.get("/bridge.html").raw.toString();
  for (const path of ["/", "/bridge", "/bridge.html"]) assert.equal((await ask("bridge.longyu.network", path)).body, bridgeHtml, path);
  assert.equal((await ask("bridge.longyu.network", "/bridge.js")).status, 200);
  for (const other of ["/swap.html", "/swap", "/launch", "/index.html", "/bridge/"]) assert.equal((await ask("bridge.longyu.network", other)).status, 404, other);

  // Every other name is as it was.
  assert.equal((await ask("app.longyu.network", "/")).body, built["index.html"]);
  for (const path of ["/index.html", "/pay.html", "/safe.html", "/swap.html", "/bridge.html", "/launch.html", "/swap.js", "/app.css"]) assert.equal((await ask("app.longyu.network", path)).status, 200, path);
  for (const path of ["/swap", "/launch", "/bridge"]) assert.equal((await ask("app.longyu.network", path)).status, 404, path);
});

test("a name of its own may only name pages that are served", () => {
  const loaded = loadFiles(["swap"], (name: string) => Buffer.from(built[name]!));
  assert.throws(() => createHandler(loaded, null, null, new Map([["dex.longyu.network", ["launch"]]])), /HOST_PAGES: "dex.longyu.network" names a page that is not served/);
});
