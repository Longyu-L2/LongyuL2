import { createServer } from "node:http";
import { loadConfig } from "./config.ts";
import { createGateway } from "./gateway.ts";

const config = loadConfig();
const gateway = createGateway(config);
const server = createServer((req, res) => void gateway.handle(req, res));

// Slow or silent clients are cut off. Railway's edge keeps idle connections for 60 seconds, so
// this side keeps them longer and is never the one to close a connection in use.
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 75_000;

server.listen(config.port, config.host, () => {
  console.log(`LONGYU RPC gateway on :${config.port} for chain ${config.chainId}, ${config.ratePerSecond}/s per client (burst ${config.burst})`);
});

const summary = setInterval(() => {
  const s = gateway.drain();
  if (s.requests === 0) return;
  console.log(
    `rpc: 60s requests=${s.requests} calls=${s.calls} forwarded=${s.forwarded} limited=${s.limited} refused=${s.refused} busy=${s.busy} upstream_errors=${s.upstreamErrors} clients=${s.clients} in_flight=${s.inFlight}`,
  );
}, 60_000);
summary.unref();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
