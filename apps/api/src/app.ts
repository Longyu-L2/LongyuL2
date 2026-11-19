import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { clientIp, type Deps } from "./context.ts";
import { HttpError, isUniqueViolation, jsonSafe } from "./lib/util.ts";
import { registerAuth } from "./modules/auth.ts";
import { registerDeviceAndWallet } from "./modules/device-wallet.ts";
import { registerMining } from "./modules/mining.ts";
import { registerVerification } from "./modules/verification.ts";
import { registerPublicAndAdmin } from "./modules/public-admin.ts";
import { registerPayments } from "./modules/payments.ts";
import { registerBoosts } from "./modules/boosts.ts";
import { registerAdminConsole } from "./modules/admin-console.ts";
import { registerHealth } from "./modules/health.ts";

/**
 * What is logged about a request: Fastify's usual fields, except that the sign-in callback's query
 * (the state and X's code) is left out.
 */
export const logRequest = (req: FastifyRequest) => ({
  method: req.method,
  url: req.url.startsWith("/v1/auth/x/callback") ? req.url.split("?")[0] : req.url,
  version: [req.headers?.["accept-version"]].flat()[0],
  host: req.host,
  remoteAddress: req.ip,
  remotePort: req.socket ? req.socket.remotePort : undefined,
});

export async function buildApp(deps: Deps, opts: { logger?: boolean; rateLimit?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? {
          redact: [
            "req.headers.authorization", "req.headers['x-admin-key']", "req.headers['x-monitor-key']", "req.headers['x-longyu-origin']",
            "req.body.refreshToken", "req.body.ticket", "req.body.reauthTicket", "req.body.appVerifier",
          ],
          serializers: { req: logRequest },
        }
      : false,
    // Only listed proxies may set the client address; by default none can.
    trustProxy: deps.config.TRUST_PROXY === "false" ? false : deps.config.TRUST_PROXY.split(",").map((s) => s.trim()).filter(Boolean),
    bodyLimit: 64 * 1024,
  });

  // Keep the raw body: webhooks are authenticated with an HMAC over the exact bytes.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, body === "" ? {} : JSON.parse(body as string));
    } catch {
      done(new HttpError(400, "invalid_json"), undefined);
    }
  });

  // Behind Cloudflare on a host whose origin is public (Railway), only requests carrying the secret
  // Cloudflare adds are served; anything else reached the origin directly and could forge headers.
  if (deps.config.ORIGIN_SECRET) {
    const expected = Buffer.from(deps.config.ORIGIN_SECRET);
    app.addHook("onRequest", async (req, reply) => {
      if (req.method === "GET" && req.url === "/health") return; // the platform's health check
      const got = req.headers["x-longyu-origin"];
      const value = Buffer.from(typeof got === "string" ? got : "");
      if (value.length !== expected.length || !timingSafeEqual(value, expected)) {
        return reply.code(403).send({ error: "origin_required" });
      }
    });
  }

  if (opts.rateLimit !== false) {
    await app.register(rateLimit, { max: 300, timeWindow: "1 minute", keyGenerator: (req) => clientIp(deps, req) });
  }
  const origins = deps.config.WEB_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  // Bearer tokens, not cookies, so allowing the claim page's origin exposes no session. The published
  // data files are public: any page may read them, as the claim page does from the address on-chain.
  await app.register(cors, {
    delegator: (req, done) =>
      done(null, req.url?.startsWith("/data/roots/")
        ? { origin: "*", methods: ["GET"] }
        : { origin: origins.length ? origins : false, methods: ["GET", "POST"] }),
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", reply.getHeader("cache-control") ?? "no-store");
    return payload;
  });

  // BigInt values are serialised as decimal strings everywhere.
  app.setReplySerializer((payload) => JSON.stringify(jsonSafe(payload)));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message === err.code ? undefined : err.message });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "invalid_request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).name, message: (err as Error).message });
    // Two requests raced for the same unique row (Postgres 23505): the loser gets a conflict, not a 500.
    if (isUniqueViolation(err)) return reply.status(409).send({ error: "conflict" });
    req.log.error(err);
    return reply.status(500).send({ error: "internal_error" });
  });

  registerAuth(app, deps);
  registerDeviceAndWallet(app, deps);
  registerMining(app, deps);
  registerVerification(app, deps);
  registerPublicAndAdmin(app, deps);
  registerPayments(app, deps);
  registerBoosts(app, deps);
  registerHealth(app, deps);
  registerAdminConsole(app);
  return app;
}
