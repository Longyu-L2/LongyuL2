# Build from the repository root: docker build -f apps/explorer/Dockerfile -t longyu-explorer .
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
RUN npm ci --include=dev --workspace @longyu/explorer --include-workspace-root=false

COPY packages/abis packages/abis
COPY apps/explorer apps/explorer

RUN useradd --system --uid 10001 longyu
USER longyu
WORKDIR /app/apps/explorer
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
