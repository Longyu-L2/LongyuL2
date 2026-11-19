#!/bin/sh
# Starts op-proposer with the flags of BNB Chain's "Run your own L2" guide.
# An output is due every 3,600 L2 blocks, which at 250 ms blocks is every 15 minutes
# (--pathdb.proposeblock=3600 on op-geth keeps the state those proofs are read from).
# --txmgr.min-tip-cap: the default tip is 1 gwei, ten times BSC testnet's going price of 0.1 gwei.
set -eu

fail() { echo "op-proposer: $*" >&2; exit 1; }
printf '%s' "${L1_RPC_URL:-}" | grep -Eq '^https?://' || fail "L1_RPC_URL must be the BSC RPC URL"
[ -n "${ROLLUP_RPC_HOST:-}" ] || fail "ROLLUP_RPC_HOST is required (op-node's private domain)"
printf '%s' "${L2OO_ADDRESS:-}" | grep -Eq '^0x[0-9a-fA-F]{40}$' || fail "L2OO_ADDRESS must be the L2OutputOracleProxy address"
printf '%s' "${GS_PROPOSER_PRIVATE_KEY:-}" | grep -Eq '^(0x)?[0-9a-fA-F]{64}$' || fail "GS_PROPOSER_PRIVATE_KEY must be a 32-byte hex key"

exec op-proposer \
  --l1-eth-rpc="$L1_RPC_URL" \
  --rollup-rpc="http://$ROLLUP_RPC_HOST:8547" \
  --l2oo-address="$L2OO_ADDRESS" \
  --poll-interval=1s --txmgr.min-tip-cap=0.1 \
  --rpc.port=8560 \
  --private-key="${GS_PROPOSER_PRIVATE_KEY#0x}"
