# LONGYU batcher: posts L2 transaction data to BSC. Needs BNB on BSC for fees.
FROM ghcr.io/bnb-chain/op-batcher:v0.5.6@sha256:a2ea248ebb034f423528a58026bfbb949374b98cf1d203cbe725ac6e24daeb01
USER root
COPY chain/railway/op-batcher/entrypoint.sh /entrypoint.sh
RUN chmod 0555 /entrypoint.sh
USER batcher
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
