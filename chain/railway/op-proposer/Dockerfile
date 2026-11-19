# LONGYU proposer: posts L2 state roots to the L2OutputOracle on BSC. Needs BNB on BSC for fees.
FROM ghcr.io/bnb-chain/op-proposer:v0.5.6@sha256:02d5cc9b6c390b4dacdce70e0ddce55159004c80e13d89a2d6e3a12aeaf57684
USER root
COPY chain/railway/op-proposer/entrypoint.sh /entrypoint.sh
RUN chmod 0555 /entrypoint.sh
USER proposer
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
