# LONGYU's web pages (the landing page, claim, pay, bridge, swap, launch, safe), built once and served as fixed files.
# Build from the repository root: docker build -f apps/web/Dockerfile -t longyu-web .
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/abis/package.json packages/abis/
COPY packages/reward-engine/package.json packages/reward-engine/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/explorer/package.json apps/explorer/
COPY apps/signer/package.json apps/signer/
COPY apps/watchtower/package.json apps/watchtower/
RUN npm ci --include=dev --workspace @longyu/web --include-workspace-root=false
COPY packages/abis packages/abis
COPY apps/web apps/web
# The pages' settings are fixed into the files at build time (see apps/web/build.mjs). All are public values.
# NETWORK is testnet (the default) or mainnet.
ARG NETWORK
ARG API_URL
ARG CHAIN_ID
ARG CHAIN_NAME
ARG NATIVE_SYMBOL
ARG RPC_URL
ARG EXPLORER_URL
ARG REWARD_TOKEN
ARG TOKEN_NAME
ARG TOKEN_SYMBOL
ARG DISTRIBUTOR
ARG L1_PORTAL
ARG L1_OUTPUT_ORACLE
ARG L1_STANDARD_BRIDGE
ARG L1_TOKEN
ARG L2_TOKEN
ARG L2_RPC_URL
ARG L1_RPC_URL
ARG SWAP_ROUTER
ARG SWAP_FACTORY
ARG TOKEN_LAUNCHER
ARG MINE_URL
ARG SITE_URL
ARG APP_URL
ARG DEX_URL
ARG BRIDGE_URL
ARG GITHUB_URL
ARG X_URL
RUN cd apps/web && rm -rf dist && node build.mjs

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/apps/web/dist dist
COPY apps/web/server.mjs server.mjs
RUN useradd --system --uid 10001 longyu
USER longyu
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
