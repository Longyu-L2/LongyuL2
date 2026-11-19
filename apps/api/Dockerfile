# Build from the repository root: docker build -f apps/api/Dockerfile -t longyu-api .
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
RUN npm ci --include=dev --workspace @longyu/api --include-workspace-root=false

COPY packages packages
COPY apps/api apps/api

RUN useradd --system --uid 10001 longyu && mkdir -p /data && chown longyu /data
USER longyu
WORKDIR /app/apps/api
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
