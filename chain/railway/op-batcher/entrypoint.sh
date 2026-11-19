#!/bin/sh
# Starts op-batcher with the flags of BNB Chain's "Run your own L2" guide.
# --max-channel-duration trades how often data is posted against BNB spent. BNB's guide uses 20 L1
# blocks, which at BSC's 0.45-second blocks is a transaction every 9 seconds (~9,600 a day). LONGYU
# posts every 300 blocks (~2 minutes 15 seconds), well inside the 1,200-block channel timeout.
# --txmgr.min-tip-cap: the default tip is 1 gwei, ten times BSC testnet's going price of 0.1 gwei.
# When the network suggests more than the floor, the suggestion is used.
# --poll-interval, --max-pending-tx, --txmgr.receipt-query-interval: each pass reads at most 30 LONGYU
# blocks (fixed in the batcher), and a pass waits while --max-pending-tx transactions are unconfirmed.
# The defaults (one transaction, receipts checked every 12 seconds) post 2.5 blocks a second when the
# batcher is behind; LONGYU produces 4, so it would never catch up. These settings read up to 30 a second.
set -eu

fail() { echo "op-batcher: $*" >&2; exit 1; }
printf '%s' "${L1_RPC_URL:-}" | grep -Eq '^https?://' || fail "L1_RPC_URL must be the BSC RPC URL"
[ -n "${L2_RPC_HOST:-}" ] || fail "L2_RPC_HOST is required (op-geth's private domain)"
[ -n "${ROLLUP_RPC_HOST:-}" ] || fail "ROLLUP_RPC_HOST is required (op-node's private domain)"
printf '%s' "${GS_BATCHER_PRIVATE_KEY:-}" | grep -Eq '^(0x)?[0-9a-fA-F]{64}$' || fail "GS_BATCHER_PRIVATE_KEY must be a 32-byte hex key"
DURATION="${MAX_CHANNEL_DURATION:-300}"
case "$DURATION" in "" | *[!0-9]*) fail "MAX_CHANNEL_DURATION must be a number of L1 blocks" ;; esac
# A channel must be closed and posted before the 1,200-block timeout, with room for the safety margin.
[ "$DURATION" -ge 1 ] && [ "$DURATION" -le 900 ] || fail "MAX_CHANNEL_DURATION must be between 1 and 900 L1 blocks"

exec op-batcher \
  --l1-eth-rpc="$L1_RPC_URL" \
  --l2-eth-rpc="http://$L2_RPC_HOST:8545" \
  --rollup-rpc="http://$ROLLUP_RPC_HOST:8547" \
  --poll-interval=1s --max-pending-tx=4 --txmgr.receipt-query-interval=2s \
  --sub-safety-margin=30 --num-confirmations=4 --safe-abort-nonce-too-low-count=3 \
  --resubmission-timeout=30s --txmgr.min-tip-cap=0.1 \
  --rpc.addr=0.0.0.0 --rpc.port=8548 --rpc.enable-admin \
  --batch-type=1 --data-availability-type=auto --target-num-frames=2 \
  --max-channel-duration="$DURATION" \
  --private-key="${GS_BATCHER_PRIVATE_KEY#0x}"
