# LONGYU's watchtower: checks the state roots on BSC and the mining roots on LONGYU from its own node,
# and deletes or vetoes a wrong one with keys of its own. Runs in a Railway project of its own, apart
# from the chain, the API and the signer; its node is chain/railway/op-geth and op-node with ROLE=verifier.
# Build from the repository root: docker build -f apps/watchtower/Dockerfile -t longyu-watchtower .
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/abis/package.json packages/abis/
COPY packages/reward-engine/package.json packages/reward-engine/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/explorer/package.json apps/explorer/
COPY apps/signer/package.json apps/signer/
COPY apps/watchtower/package.json apps/watchtower/
RUN npm ci --include=dev --workspace @longyu/watchtower --include-workspace-root=false

COPY packages/reward-engine packages/reward-engine
COPY apps/watchtower apps/watchtower

RUN useradd --system --uid 10001 longyu && mkdir -p /state
WORKDIR /app/apps/watchtower
ENV STATE_DIR=/state
EXPOSE 8080
# The volume at /state mounts owned by root: it is handed to the service's own user, which then runs
# the service with no other rights (setpriv is part of the base image).
CMD ["/bin/sh", "-c", "chown -R longyu /state && exec setpriv --reuid=10001 --regid=$(id -g longyu) --init-groups node --import tsx src/server.ts"]
