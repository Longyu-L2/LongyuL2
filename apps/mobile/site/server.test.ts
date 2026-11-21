import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
// @ts-expect-error a plain JavaScript module without type declarations
import { chainCheckOrigins, contentPolicy, createHandler, lightOnly, loadSite, parseRange, ROUTES } from "./server.mjs";

const API = "https://api.example.org";
const JS = "_expo/static/js/web/entry-0123abcd.js";
const FONT = "assets/assets/fonts/web/Inter-Regular.51b6.woff2";
const ICON = "assets/node_modules/expo-router/assets/close-icon.808e@2x.png";
const built = new Map<string, Buffer>([
  ["index.html", Buffer.from("<!doctype html><title>LONGYU MINE</title>")],
  ["favicon.ico", Buffer.from("icon".repeat(100))],
  [JS, Buffer.from("console.log('mine');".repeat(300))],
  [FONT, Buffer.from("font".repeat(500))],
  [ICON, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])],
]);
const APK = "longyu-mine-testnet-1.0.0-1.apk";
const apkBytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const apkEtag = `"${createHash("sha256").update(apkBytes).digest("hex")}"`;

const servers: Server[] = [];
async function site(downloads = new Map<string, Buffer>([[APK, apkBytes], ["README.md", Buffer.from("notes")]]), originSecret: string | null = null): Promise<string> {
  const server = createServer(createHandler(loadSite(built, downloads), contentPolicy(API), originSecret));
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

const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer());

test("the page may reach its own files, the API and the human check, and nothing else", () => {
  const policy: string = contentPolicy("https://api-testnet.longyu.network");
  assert.equal(
    policy,
    "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://pbs.twimg.com; " +
      "font-src 'self' data:; connect-src 'self' https://api-testnet.longyu.network https://rpc-testnet.longyu.network https://bsc-testnet-rpc.publicnode.com; frame-src https://challenges.cloudflare.com; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  );
  // Only the address's origin is taken: nothing after it can add to the policy.
  assert.match(contentPolicy("https://api.example.org/v1; script-src *"), /connect-src 'self' https:\/\/api\.example\.org https:\/\/rpc-testnet\.longyu\.network https:\/\/bsc-testnet-rpc\.publicnode\.com; frame-src/);
  assert.match(contentPolicy("http://localhost:8080"), /connect-src 'self' http:\/\/localhost:8080 /);
  assert.match(contentPolicy("http://127.0.0.1:8080"), /connect-src 'self' http:\/\/127\.0\.0\.1:8080 /);
  for (const bad of [undefined, "", "api.example.org", "http://api.example.org", "ftp://api.example.org", "javascript:alert(1)"]) {
    assert.throws(() => contentPolicy(bad), /EXPO_PUBLIC_API_URL/, String(bad));
  }
});

test("the server's list of screens is the app's (src/app)", () => {
  const routes = readdirSync(new URL("../src/app", import.meta.url), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx$/.test(e.name) && !e.name.startsWith("_") && !e.name.startsWith("+"))
    .map((e) => (e.name === "index.tsx" ? "/" : `/${e.name.replace(/\.tsx$/, "")}`));
  assert.deepEqual([...ROUTES].sort(), routes.sort());
});

test("every screen's address opens the app, with the security headers", async () => {
  const url = await site();
  for (const route of ROUTES) {
    const res = await fetch(url + route, { headers: { "accept-encoding": "identity" } });
    assert.equal(res.status, 200, route);
    assert.equal(await res.text(), built.get("index.html")!.toString(), route);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.equal(res.headers.get("content-security-policy"), contentPolicy(API));
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000");
    assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
  }
  // The query is the page's business; a trailing slash goes to the address without it.
  assert.equal((await fetch(`${url}/mine?x=1`)).status, 200);
  const slash = await fetch(`${url}/mine/`, { redirect: "manual" });
  assert.deepEqual([slash.status, slash.headers.get("location")], [308, "/mine"]);
});

test("anything else is not found: no other address opens the app", async () => {
  const url = await site();
  for (const path of ["/index.html", "/_sitemap", "/admin", "/mine/x", "/metadata.json", "/.env", "/server.mjs", "/download", "/download/", "/download/README.md",
    "/download/other.apk", "/_expo/static/js/web/missing.js", "/assets/../index.html", "/%2e%2e/server.mjs", "//mine", "/MINE", "/sign-in.html"]) {
    const res = await fetch(url + path, { redirect: "manual" });
    assert.equal(res.status, 404, path);
    assert.equal(await res.text(), "not found");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("content-security-policy"), contentPolicy(API));
  }
  const post = await fetch(`${url}/`, { method: "POST" });
  assert.deepEqual([post.status, post.headers.get("allow")], [405, "GET, HEAD"]);
  assert.equal(await (await fetch(`${url}/health`)).text(), "ok");
});

test("built files: named after their contents and kept for a year, compressed when it helps", async () => {
  const url = await site();
  const plain = await fetch(`${url}/${JS}`, { headers: { "accept-encoding": "identity" } });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(plain.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(plain.headers.get("vary"), "accept-encoding");
  assert.equal(plain.headers.get("content-encoding"), null);
  assert.deepEqual(await bytes(plain), built.get(JS));

  // fetch would decompress on its own: ask for the bytes as sent.
  const sent = async (encoding: string) => {
    const res = await fetch(`${url}/${JS}`, { headers: { "accept-encoding": encoding } });
    return { encoding: res.headers.get("content-encoding"), length: Number(res.headers.get("content-length")) };
  };
  assert.equal((await sent("gzip, deflate, br")).encoding, "br");
  assert.equal((await sent("gzip")).encoding, "gzip");
  assert.ok((await sent("br")).length < built.get(JS)!.length / 10);

  const font = await fetch(`${url}/${FONT}`, { headers: { "accept-encoding": "identity" } });
  assert.deepEqual([font.status, font.headers.get("content-type"), font.headers.get("cache-control")], [200, "font/woff2", "public, max-age=31536000, immutable"]);
  assert.equal(font.headers.get("content-encoding"), null);
  // An image is already compressed: it is sent as it is, whatever the browser accepts.
  const icon = await fetch(`${url}/${ICON}`, { headers: { "accept-encoding": "br, gzip" } });
  assert.deepEqual([icon.status, icon.headers.get("content-type"), icon.headers.get("content-encoding"), icon.headers.get("vary")], [200, "image/png", null, null]);
  assert.deepEqual(await bytes(icon), built.get(ICON));

  // The favicon's name is not versioned: the browser asks each time and gets 304 when nothing changed.
  const fav = await fetch(`${url}/favicon.ico`);
  assert.equal(fav.headers.get("cache-control"), "no-cache");
  const again = await fetch(`${url}/favicon.ico`, { headers: { "if-none-match": fav.headers.get("etag")! } });
  assert.equal(again.status, 304);
  const head = await fetch(`${url}/${JS}`, { method: "HEAD", headers: { "accept-encoding": "identity" } });
  assert.deepEqual([head.status, head.headers.get("content-length"), (await bytes(head)).length], [200, String(built.get(JS)!.length), 0]);
});

test("the page is marked light only, once, for browsers that darken pages", () => {
  const page = Buffer.from('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>LONGYU MINE</title></head><body></body></html>');
  const marked = lightOnly(page).toString();
  assert.equal(marked, '<!DOCTYPE html><html lang="en"><head><meta name="color-scheme" content="only light"><meta charset="utf-8"><title>LONGYU MINE</title></head><body></body></html>');
  assert.equal(lightOnly(Buffer.from(marked)).toString(), marked);
  // A page without a head is served as it was built.
  const bare = Buffer.from("<!doctype html><title>LONGYU MINE</title>");
  assert.equal(lightOnly(bare), bare);
  const served = loadSite(new Map([["index.html", page], ["a.js", Buffer.from("1")]])).files;
  assert.equal(served.get("/index.html").raw.toString(), marked);
  assert.equal(served.get("/a.js").raw.toString(), "1");
});

test("compressed answers decompress to the file", async () => {
  const site = loadSite(built);
  const f = site.files.get(`/${JS}`);
  assert.deepEqual(brotliDecompressSync(f.br), built.get(JS));
  assert.deepEqual(gunzipSync(f.gzip), built.get(JS));
  assert.equal(site.files.get(`/${ICON}`).br, undefined);
});

test("the Android app: one stable link to the current file, sent as a download", async () => {
  const url = await site();
  const link = await fetch(`${url}/download/android`, { redirect: "manual" });
  assert.deepEqual([link.status, link.headers.get("location"), link.headers.get("cache-control")], [302, `/download/${APK}`, "no-store"]);

  const res = await fetch(`${url}/download/${APK}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.equal(res.headers.get("content-disposition"), `attachment; filename="${APK}"`);
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("content-length"), "1000");
  assert.equal(res.headers.get("content-encoding"), null);
  // The tag is the file's SHA-256, the same value people are given to check the download.
  assert.equal(res.headers.get("etag"), apkEtag);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await bytes(res), apkBytes);
  assert.equal((await fetch(`${url}/download/${APK}`, { headers: { "if-none-match": apkEtag } })).status, 304);
});

test("the Android app: a broken download carries on from where it stopped", async () => {
  const url = await site();
  const part = async (headers: Record<string, string>) => {
    const res = await fetch(`${url}/download/${APK}`, { headers });
    return { status: res.status, range: res.headers.get("content-range"), body: await bytes(res) };
  };
  const rest = await part({ range: "bytes=400-" });
  assert.deepEqual([rest.status, rest.range], [206, "bytes 400-999/1000"]);
  assert.deepEqual(rest.body, apkBytes.subarray(400));
  const middle = await part({ range: "bytes=10-19" });
  assert.deepEqual([middle.status, middle.range], [206, "bytes 10-19/1000"]);
  assert.deepEqual(middle.body, apkBytes.subarray(10, 20));
  const tail = await part({ range: "bytes=-5" });
  assert.deepEqual([tail.status, tail.range], [206, "bytes 995-999/1000"]);
  assert.deepEqual(tail.body, apkBytes.subarray(995));
  // Past the end: refused, with the size.
  const beyond = await part({ range: "bytes=1000-" });
  assert.deepEqual([beyond.status, beyond.range, beyond.body.length], [416, "bytes */1000", 0]);
  // The part belongs to the file the phone started on: a different file is sent whole.
  const same = await part({ range: "bytes=400-", "if-range": apkEtag });
  assert.equal(same.status, 206);
  const changed = await part({ range: "bytes=400-", "if-range": '"another-file"' });
  assert.deepEqual([changed.status, changed.range, changed.body.length], [200, null, 1000]);
  // Several parts at once, or other units: the whole file.
  for (const range of ["bytes=0-1,5-6", "items=0-1", "bytes=5-2", "bytes=-", "bytes=a-b"]) {
    assert.equal((await part({ range })).status, 200, range);
  }
});

test("ranges are read exactly", () => {
  assert.deepEqual(parseRange("bytes=0-0", 10), { start: 0, end: 0 });
  assert.deepEqual(parseRange("bytes=0-", 10), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=3-99999", 10), { start: 3, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=-99", 10), { start: 0, end: 9 });
  assert.equal(parseRange("bytes=-0", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=10-", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=999999999999999-", 10), "unsatisfiable");
  for (const ignored of ["bytes=5-2", "bytes=-", "bytes=", "bytes=1-2,4-5", "bytes= 1-2", "BYTES=1-2", "bytes=1-2 ", "bytes=1234567890123456-", ""]) {
    assert.equal(parseRange(ignored, 10), null, JSON.stringify(ignored));
  }
});

test("without an app in downloads/ there is no download; a wrong folder stops the start", async () => {
  const url = await site(new Map([["README.md", Buffer.from("notes")]]));
  assert.equal((await fetch(`${url}/download/android`, { redirect: "manual" })).status, 404);
  assert.equal((await fetch(`${url}/download/${APK}`)).status, 404);
  assert.throws(() => loadSite(built, new Map([["a.apk", apkBytes], ["b.apk", apkBytes]])), /more than one \.apk/);
  assert.throws(() => loadSite(built, new Map([['x".apk', apkBytes]])), /not a name that can be served/);
  assert.throws(() => loadSite(built, new Map([["sub/app.apk", apkBytes]])), /not a name that can be served/);
  assert.throws(() => loadSite(new Map([[JS, built.get(JS)!]])), /no index\.html/);
  assert.throws(() => loadSite(new Map([...built, ["run.sh", Buffer.from("x")]])), /unknown type: run\.sh/);
  assert.throws(() => loadSite(new Map([...built, ["constructor", Buffer.from("x")]])), /unknown type/);
});

test("behind Cloudflare, only requests carrying its secret header are served", async () => {
  const secret = "s".repeat(40);
  const url = await site(undefined, secret);
  for (const path of ["/", "/mine", `/${JS}`, "/download/android", `/download/${APK}`, "/nothing"]) {
    for (const headers of [{}, { "x-longyu-origin": "" }, { "x-longyu-origin": "wrong" }, { "x-longyu-origin": secret.slice(1) }, { "x-longyu-origin": `${secret}s` }]) {
      const res = await fetch(`${url}${path}`, { headers: headers as Record<string, string>, redirect: "manual" });
      assert.equal(res.status, 403, `${path} ${JSON.stringify(headers)}`);
      assert.equal(await res.text(), "forbidden");
      assert.ok(res.headers.get("content-security-policy"));
    }
  }
  // Railway's health check carries no header.
  assert.equal((await fetch(`${url}/health`)).status, 200);
  const ok = { "x-longyu-origin": secret };
  assert.equal((await fetch(`${url}/mine`, { headers: ok })).status, 200);
  assert.equal((await fetch(`${url}/download/android`, { headers: ok, redirect: "manual" })).status, 302);
  assert.deepEqual(await bytes(await fetch(`${url}/download/${APK}`, { headers: ok })), apkBytes);
  assert.equal((await fetch(`${url}/nothing`, { headers: ok })).status, 404);
});

test("the chain check's two RPC addresses: the defaults, a build's own, and never plain http", () => {
  assert.deepEqual(chainCheckOrigins({}), ["https://rpc-testnet.longyu.network", "https://bsc-testnet-rpc.publicnode.com"]);
  assert.deepEqual(chainCheckOrigins({ APP_VARIANT: "testnet" }), ["https://rpc-testnet.longyu.network", "https://bsc-testnet-rpc.publicnode.com"]);
  assert.deepEqual(chainCheckOrigins({ APP_VARIANT: "development" }), ["https://rpc-testnet.longyu.network", "https://bsc-testnet-rpc.publicnode.com"]);
  assert.deepEqual(chainCheckOrigins({ APP_VARIANT: "production" }), ["https://rpc.longyu.network", "https://bsc-rpc.publicnode.com"]);
  // The image's own file wins over APP_VARIANT.
  const mainnetFile = fileURLToPath(new URL("../chain-check.production.json", import.meta.url));
  assert.deepEqual(chainCheckOrigins({ APP_VARIANT: "testnet", LONGYU_CHAIN_CHECK: mainnetFile }), ["https://rpc.longyu.network", "https://bsc-rpc.publicnode.com"]);
  assert.deepEqual(chainCheckOrigins({ EXPO_PUBLIC_L2_RPC_URL: "https://rpc.example.org/x", EXPO_PUBLIC_L1_RPC_URL: "https://bsc.example.org" }), ["https://rpc.example.org", "https://bsc.example.org"]);
  assert.throws(() => chainCheckOrigins({ EXPO_PUBLIC_L1_RPC_URL: "http://bsc.example.org" }), /https/);
});

test("the image: testnet unless APP_VARIANT says production, holding only that network's chain check", () => {
  const dockerfile = readFileSync(fileURLToPath(new URL("./Dockerfile", import.meta.url)), "utf8");
  assert.match(dockerfile, /^ARG APP_VARIANT=testnet$/m);
  assert.match(dockerfile, /testnet \| production\) ;;/);
  assert.match(dockerfile, /cp "chain-check\.\$APP_VARIANT\.json" \/chain-check\.json/);
  assert.match(dockerfile, /^COPY --from=build \/chain-check\.json \/chain-check\.json$/m);
  assert.match(dockerfile, /^ENV LONGYU_CHAIN_CHECK=\/chain-check\.json$/m);
  assert.doesNotMatch(dockerfile, /^COPY apps\/mobile\/chain-check/m);
});
