# LONGYU sequencer execution client: BNB Chain's op-geth with LONGYU's genesis and a checked start-up.
# Built by Railway from the repository root (see .railway/railway.ts).
FROM ghcr.io/bnb-chain/op-geth:v0.5.11@sha256:68e5a499a4318269b3f4bdf4c669d97a06a9c3a398d6c4578e09dea342ff5a3b
USER root
# su-exec drops from root to the geth user after the volume's ownership is fixed.
RUN apk add --no-cache su-exec
COPY chain/testnet/genesis.json /chain/genesis.json
COPY chain/railway/op-geth/entrypoint.sh /entrypoint.sh
RUN chmod 0555 /entrypoint.sh && chmod 0444 /chain/genesis.json
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
