# LONGYU MINE for browsers: the app's web build as fixed files, with the Android app's download.
# Build from the repository root:
#   docker build -f apps/mobile/site/Dockerfile -t longyu-mine \
#     --build-arg EXPO_PUBLIC_API_URL=https://... --build-arg EXPO_PUBLIC_TURNSTILE_SITE_KEY=... .
# APP_VARIANT is testnet unless given; the mainnet site passes --build-arg APP_VARIANT=production.
# Run it with the same EXPO_PUBLIC_API_URL: the server allows the page to call that address only.
FROM node:22-slim AS build
WORKDIR /app
COPY apps/mobile/package.json apps/mobile/package-lock.json ./
RUN npm ci
COPY apps/mobile ./
# The build's settings are fixed into the files (both are public values). The export refuses to run
# without them (assertReleaseConfig in app.config.ts).
ARG APP_VARIANT=testnet
ARG EXPO_PUBLIC_API_URL
ARG EXPO_PUBLIC_TURNSTILE_SITE_KEY
ENV LONGYU_RELEASE_CHECK=true CI=1 EXPO_NO_TELEMETRY=1
RUN case "$APP_VARIANT" in testnet | production) ;; *) echo "APP_VARIANT must be testnet or production" >&2; exit 1 ;; esac \
 && rm -rf dist && npx expo export --platform web --output-dir dist \
 && cp "chain-check.$APP_VARIANT.json" /chain-check.json

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist dist
COPY apps/mobile/site/server.mjs server.mjs
# The chain check's RPC addresses for the build's network, which the page may call (server.mjs).
COPY --from=build /chain-check.json /chain-check.json
ENV LONGYU_CHAIN_CHECK=/chain-check.json
COPY apps/mobile/site/downloads downloads
RUN useradd --system --uid 10001 longyu
USER longyu
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
