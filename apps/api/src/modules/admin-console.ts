/**
 * Serves the admin console (apps/api/admin) from the API's own origin, so the console needs no
 * CORS and its admin key never goes to another host. The page is static; every action goes
 * through the /v1/admin endpoints, which check the key. Put Cloudflare Access in front of
 * /admin and /v1/admin as a second lock.
 */
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const FILES: Record<string, { file: string; type: string }> = {
  "": { file: "index.html", type: "text/html; charset=utf-8" },
  "app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "icon.svg": { file: "icon.svg", type: "image/svg+xml" },
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function registerAdminConsole(app: FastifyInstance): void {
  const dir = new URL("../../admin/", import.meta.url);
  const content = new Map(Object.entries(FILES).map(([name, f]) => [name, { body: readFileSync(new URL(f.file, dir), "utf8"), type: f.type }]));
  const serve = (name: string) => async (_req: unknown, reply: import("fastify").FastifyReply) => {
    const f = content.get(name)!;
    reply
      .header("content-type", f.type)
      .header("content-security-policy", CSP)
      .header("x-frame-options", "DENY")
      .header("cross-origin-opener-policy", "same-origin")
      .header("cross-origin-resource-policy", "same-origin")
      .header("cache-control", "no-store");
    return f.body;
  };
  app.get("/admin", serve(""));
  app.get("/admin/", serve(""));
  app.get("/admin/app.js", serve("app.js"));
  app.get("/admin/app.css", serve("app.css"));
  app.get("/admin/icon.svg", serve("icon.svg"));
}
