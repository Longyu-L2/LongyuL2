# LONGYU rollup node, as the sequencer or (ROLE=verifier) the watchtower's own node: BNB Chain's
# op-node with LONGYU's rollup config. NETWORK (testnet or mainnet) picks the chain at build time.
FROM ghcr.io/bnb-chain/op-node:v0.5.6@sha256:4987a2937dc9e4de64ac8add9888eb3076b938c04f80235e87021c481363fc82
ARG NETWORK=testnet
USER root
COPY chain/${NETWORK}/rollup.json /chain/rollup.json
COPY chain/railway/op-node/entrypoint.sh /entrypoint.sh
RUN chmod 0555 /entrypoint.sh && chmod 0444 /chain/rollup.json
USER op-node
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
