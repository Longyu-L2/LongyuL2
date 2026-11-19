# LONGYU's public JSON-RPC endpoint: a checking, rate-limiting gateway in front of the node.
# It has no dependencies: Node runs the TypeScript sources as they are.
# Build from the repository root: docker build -f chain/railway/rpc/Dockerfile -t longyu-rpc .
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY chain/railway/rpc/src src
RUN useradd --system --uid 10001 longyu
USER longyu
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/server.ts"]
