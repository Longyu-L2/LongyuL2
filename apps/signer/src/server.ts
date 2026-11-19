import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { addresses, loadConfig } from "./config.ts";

const config = loadConfig();
const server = createServer(createApp(config));
// A slow or silent client cannot hold a connection open.
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

server.listen(config.PORT, config.HOST, () => {
  // Addresses are public; keys and the token are never logged.
  console.log(
    JSON.stringify({
      event: "listening",
      port: config.PORT,
      chainId: config.CHAIN_ID,
      distributor: config.DISTRIBUTOR_ADDRESS ?? null,
      faucet: config.FAUCET_ADDRESS ?? null,
      ...addresses(config),
    }),
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
