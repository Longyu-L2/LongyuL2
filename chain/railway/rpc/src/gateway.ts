/**
 * LONGYU's public JSON-RPC endpoint. The node behind it is the sequencer's, so nothing reaches it
 * unchecked: only served methods (policy.ts), a rate limit per client address, a cap on batches,
 * request and answer sizes and eth_getLogs ranges, and a cap on requests in flight.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { Limiter, clientKey } from "./limiter.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, LIMIT_EXCEEDED, classify, logName, rangeLength, type Id, type Verdict } from "./policy.ts";

export type Stats = { requests: number; calls: number; forwarded: number; limited: number; refused: number; busy: number; upstreamErrors: number };

type Deps = { fetch?: typeof fetch; now?: () => number; log?: (line: string) => void };

class TooLarge extends Error {}

const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const digest = (s: string) => createHash("sha256").update(s).digest();
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function createGateway(config: Config, deps: Deps = {}) {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const limiter = new Limiter(config.ratePerSecond, config.burst);
  const stats: Stats = { requests: 0, calls: 0, forwarded: 0, limited: 0, refused: 0, busy: 0, upstreamErrors: 0 };
  const perClient = new Map<string, number>();
  const secret = config.originSecret === null ? null : digest(config.originSecret);
  let inFlight = 0;
  let head: { value: bigint; at: number } | null = null;

  function send(res: ServerResponse, status: number, body: string | Uint8Array, extra: Record<string, string> = {}): number {
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(typeof body === "string" ? Buffer.byteLength(body) : body.byteLength),
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    });
    res.end(body);
    return status;
  }

  /** The client's rate-limit key, or null when the request did not come through the expected proxy. */
  function identify(req: IncomingMessage): string | null {
    const header = (name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : "");
    if (secret !== null) {
      if (!timingSafeEqual(digest(header("x-longyu-origin")), secret)) return null;
      return clientKey(header("cf-connecting-ip")) ?? "unknown";
    }
    return clientKey(header("x-real-ip")) ?? clientKey(req.socket.remoteAddress ?? "") ?? "unknown";
  }

  function readBody(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      if (Number(req.headers["content-length"] ?? 0) > config.maxBodyBytes) return resolve(null);
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > config.maxBodyBytes) {
          req.removeAllListeners("data");
          req.pause();
          return resolve(null);
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async function upstream(body: string | Uint8Array): Promise<Buffer> {
    const res = await fetchFn(config.upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-encoding": "identity" },
      body: body as BodyInit,
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`the node answered ${res.status}`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > config.maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new TooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  /** The chain's newest block number, at most two seconds old. */
  async function newestBlock(): Promise<bigint> {
    if (head && now() - head.at < 2000) return head.value;
    const out: unknown = JSON.parse((await upstream('{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}')).toString("utf8"));
    const result = typeof out === "object" && out !== null ? (out as { result?: unknown }).result : undefined;
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(result)) throw new Error("the node gave no block number");
    head = { value: BigInt(result), at: now() };
    return head.value;
  }

  async function rpc(req: IncomingMessage, res: ServerResponse, note: (methods: string) => void): Promise<number> {
    const client = identify(req);
    if (client === null) {
      stats.refused++;
      return send(res, 403, JSON.stringify(rpcError(null, INVALID_REQUEST, "requests must come through the public address")));
    }
    const body = await readBody(req);
    if (body === null) {
      stats.refused++;
      res.on("finish", () => req.destroy());
      return send(res, 413, JSON.stringify(rpcError(null, INVALID_REQUEST, `a request may be at most ${config.maxBodyBytes} bytes`)), { connection: "close" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      stats.refused++;
      // Unparseable requests still count against the client's allowance.
      limiter.take(client, 1, now());
      return send(res, 200, JSON.stringify(rpcError(null, -32700, "parse error")));
    }
    const batch = Array.isArray(parsed);
    const items: unknown[] = batch ? (parsed as unknown[]) : [parsed];
    if (items.length === 0 || items.length > config.maxBatch) {
      stats.refused++;
      limiter.take(client, 1, now());
      const message = items.length === 0 ? "empty batch" : `a batch may hold at most ${config.maxBatch} requests`;
      return send(res, 200, JSON.stringify(rpcError(null, INVALID_REQUEST, message)));
    }

    const verdicts: Verdict[] = items.map((item) => classify(item, { chainId: config.chainId }));
    if (config.accessLog) note(verdicts.slice(0, 5).map((v) => logName(v.method)).join(","));
    const answer = (v: Verdict, code: number, message: string) => rpcError(v.idSafe ? v.id : null, code, message);
    const local = (v: Verdict) => (v.kind === "local" ? { jsonrpc: "2.0", id: v.id, result: v.result } : v.kind === "reject" ? answer(v, v.code, v.message) : answer(v, INTERNAL_ERROR, "internal error"));
    const reply = (status: number, answers: unknown[], extra: Record<string, string> = {}) => send(res, status, JSON.stringify(batch ? answers : answers[0]), extra);
    const failAll = (status: number, code: number, message: string, extra: Record<string, string> = {}) =>
      reply(status, verdicts.map((v) => answer(v, code, message)), extra);

    const cost = verdicts.reduce((n, v) => n + (v.kind === "forward" ? v.cost : 1), 0);
    if (!limiter.take(client, cost, now())) {
      stats.limited++;
      return failAll(429, LIMIT_EXCEEDED, "rate limit exceeded; slow down and retry", { "retry-after": "1" });
    }
    stats.calls += items.length;

    // eth_getLogs over more blocks than allowed is refused before the node scans anything.
    for (const [i, v] of verdicts.entries()) {
      if (v.kind !== "forward" || !v.logRange) continue;
      const open = (v.logRange.from === null) !== (v.logRange.to === null);
      let newest = 0n;
      if (open) {
        try {
          newest = await newestBlock();
        } catch {
          stats.upstreamErrors++;
          return failAll(502, INTERNAL_ERROR, "the node did not answer; retry shortly");
        }
      }
      if (rangeLength(v.logRange, newest) > BigInt(config.maxLogRange)) {
        verdicts[i] = { kind: "reject", id: v.id, idSafe: v.idSafe, method: v.method, code: INVALID_PARAMS, message: `eth_getLogs is limited to ${config.maxLogRange} blocks per query; narrow fromBlock and toBlock` };
      }
    }

    const forwards = verdicts.filter((v) => v.kind === "forward");
    stats.refused += verdicts.filter((v) => v.kind === "reject").length;
    if (forwards.length === 0) return reply(200, verdicts.map(local));
    const mixed = forwards.length !== verdicts.length;
    // Ids are repeated from the checked values, which needs ids that can be repeated exactly (policy.ts refuses the rest).
    if (forwards.some((v) => !v.idSafe)) return failAll(200, INVALID_REQUEST, "ids must be strings or whole numbers");

    if (inFlight >= config.maxInFlight) {
      stats.busy++;
      return failAll(503, LIMIT_EXCEEDED, "the endpoint is busy; retry shortly", { "retry-after": "1" });
    }
    const mine = perClient.get(client) ?? 0;
    if (mine >= config.maxInFlightPerClient) {
      stats.limited++;
      return failAll(429, LIMIT_EXCEEDED, "too many requests at once; wait for answers before sending more", { "retry-after": "1" });
    }
    inFlight++;
    perClient.set(client, mine + 1);
    try {
      stats.forwarded += forwards.length;
      // The node is sent a fresh encoding of the checked values, never the client's own bytes (see policy.ts).
      const wire = (v: Verdict & { kind: "forward" }, id: Id) => ({ jsonrpc: "2.0", id, method: v.method, ...(v.params === undefined ? {} : { params: v.params }) });
      // Nothing refused or answered here: the node's answer passes through byte for byte.
      if (!mixed) {
        const all = verdicts.flatMap((v) => (v.kind === "forward" ? [wire(v, v.id)] : []));
        return send(res, 200, await upstream(JSON.stringify(batch ? all : all[0])));
      }

      // A batch the node gets only a part of: its answers and the ones given here are put together,
      // matched to their requests by position.
      const sub = verdicts.flatMap((v, i) => (v.kind === "forward" ? [wire(v, i)] : []));
      const out: unknown = JSON.parse((await upstream(JSON.stringify(sub))).toString("utf8"));
      const byIndex = new Map<number, object>();
      if (Array.isArray(out)) {
        for (const o of out as unknown[]) {
          if (typeof o === "object" && o !== null && typeof (o as { id?: unknown }).id === "number") byIndex.set((o as { id: number }).id, o);
        }
      }
      return reply(200, verdicts.map((v, i) => {
        if (v.kind !== "forward") return local(v);
        const o = byIndex.get(i) as { result?: unknown; error?: unknown } | undefined;
        if (!o) return answer(v, INTERNAL_ERROR, "the node gave no answer for this request");
        return own(o, "error") ? { jsonrpc: "2.0", id: v.id, error: o.error } : { jsonrpc: "2.0", id: v.id, result: o.result };
      }));
    } catch (e) {
      if (e instanceof TooLarge) {
        stats.refused++;
        return failAll(200, LIMIT_EXCEEDED, `the answer is larger than ${config.maxResponseBytes} bytes; narrow the query`);
      }
      stats.upstreamErrors++;
      return failAll(502, INTERNAL_ERROR, "the node did not answer; retry shortly");
    } finally {
      inFlight--;
      const left = (perClient.get(client) ?? 1) - 1;
      if (left <= 0) perClient.delete(client);
      else perClient.set(client, left);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
    const path = (req.url ?? "/").split("?")[0];
    let methods = "";
    let status = 500;
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, GET, OPTIONS",
          "access-control-allow-headers": "*",
          "access-control-max-age": "86400",
        });
        res.end();
        return;
      }
      if (req.method === "GET" && path === "/health") {
        send(res, 200, '{"status":"ok"}');
        return;
      }
      if (req.method === "GET" && path === "/") {
        send(res, 200, JSON.stringify({ service: "LONGYU JSON-RPC", chainId: config.chainId.toString(), usage: "POST JSON-RPC 2.0 requests to this address" }));
        return;
      }
      if (req.method !== "POST" || path !== "/") {
        send(res, path === "/" ? 405 : 404, JSON.stringify(rpcError(null, INVALID_REQUEST, "POST JSON-RPC 2.0 requests to /")));
        return;
      }
      stats.requests++;
      status = await rpc(req, res, (m) => (methods = m));
    } catch {
      if (!res.headersSent) send(res, 500, JSON.stringify(rpcError(null, INTERNAL_ERROR, "internal error")));
      else res.destroy();
    } finally {
      if (config.accessLog && req.method === "POST") log(`rpc: ${identify(req) ?? "refused"} ${status} ${now() - started}ms ${methods}`);
    }
  }

  /** The counts since the last call, for the periodic log line; also forgets idle clients. */
  function drain(): Stats & { clients: number; inFlight: number } {
    const snapshot = { ...stats, clients: limiter.size, inFlight };
    for (const k of Object.keys(stats) as (keyof Stats)[]) stats[k] = 0;
    limiter.sweep(now());
    return snapshot;
  }

  return { handle, drain };
}
