/** Operational health for the console and for uptime monitors (503 when anything is critical). */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Deps } from "../context.ts";
import { computeHealth, type Health } from "../jobs/health.ts";
import { safeEqualHex, sha256PlainHex } from "../lib/util.ts";
import { adminName } from "./public-admin.ts";

const CACHE_MS = 15_000;
const cache = new WeakMap<Deps, { at: number; value: Promise<Health> }>();

function authorize(deps: Deps, req: FastifyRequest): void {
  const key = req.headers["x-monitor-key"];
  if (typeof key === "string" && key.length >= 16 && deps.config.MONITOR_KEY_SHA256) {
    if (safeEqualHex(sha256PlainHex(key), deps.config.MONITOR_KEY_SHA256)) return;
  }
  adminName(deps, req); // throws 401 unless a valid admin key is sent
}

export function registerHealth(app: FastifyInstance, deps: Deps): void {
  app.get("/v1/admin/health", async (req, reply) => {
    authorize(deps, req);
    let hit = cache.get(deps);
    if (!hit || Date.now() - hit.at > CACHE_MS) {
      hit = { at: Date.now(), value: computeHealth(deps) };
      cache.set(deps, hit);
      hit.value.catch(() => cache.delete(deps));
    }
    const health = await hit.value;
    if (health.status === "critical") reply.status(503);
    return health;
  });
}

/** Tests move the clock; they clear the cache between readings. */
export const clearHealthCache = (deps: Deps): void => void cache.delete(deps);
