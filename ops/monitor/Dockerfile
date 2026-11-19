# OpenZeppelin Monitor with LONGYU's generated config. Build from the repository root:
#   docker build -f ops/monitor/Dockerfile -t longyu-monitor .
# Needs ops/monitor/deployment.json (copy deployment.example.json and fill in the addresses).
FROM node:24-slim AS config
WORKDIR /repo
COPY packages/abis/src packages/abis/src
COPY ops/monitor ops/monitor
RUN npx --yes tsx@4.23.15 ops/monitor/generate.ts ops/monitor/deployment.json /config

# Pinned: the config format above is validated against 1.7.0.
FROM openzeppelin/openzeppelin-monitor:1.7.0@sha256:0d5ac20151328d691cfcb90eeec77d9ce4d9f2f962ddbbb90988c8e0e7c2d616
COPY --from=config /config /app/config
# Runtime environment: LONGYU_TESTNET_RPC_URL, BSC_TESTNET_RPC_URL, BSC_RPC_URL (only the networks in use),
# and TELEGRAM_BOT_TOKEN. Mount a volume at /app/data to keep block
# checkpoints across restarts.
