# LONGYU's signer: holds the publisher, relayer and faucet-signer keys and signs only what its policy allows.
# Private network only: never give this service a public domain.
# Build from the repository root: docker build -f apps/signer/Dockerfile -t longyu-signer .
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
RUN npm ci --include=dev --workspace @longyu/signer --include-workspace-root=false

COPY packages/abis packages/abis
COPY apps/signer apps/signer

RUN useradd --system --uid 10001 longyu
USER longyu
WORKDIR /app/apps/signer
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
