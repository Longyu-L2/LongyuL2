#!/bin/sh
# Starts op-node as the LONGYU sequencer, with the flags of BNB Chain's "Run your own L2" guide.
# P2P runs without discovery: this is the only node, and Railway accepts no public UDP.
set -eu

CHAIN_DIR="${CHAIN_DIR:-/chain}"
fail() { echo "op-node: $*" >&2; exit 1; }
is_hex() { printf '%s' "$1" | grep -Eq "^(0x)?[0-9a-fA-F]{$2}\$"; }

printf '%s' "${L1_RPC_URL:-}" | grep -Eq '^https?://' || fail "L1_RPC_URL must be the BSC RPC URL"
[ -n "${L2_ENGINE_HOST:-}" ] || fail "L2_ENGINE_HOST is required (op-geth's private domain)"
is_hex "${ENGINE_JWT_SECRET:-}" 64 || fail "ENGINE_JWT_SECRET must be 32 bytes of hex, the same as op-geth's"
is_hex "${GS_SEQUENCER_PRIVATE_KEY:-}" 64 || fail "GS_SEQUENCER_PRIVATE_KEY must be a 32-byte hex key"
[ -f "$CHAIN_DIR/rollup.json" ] || fail "$CHAIN_DIR/rollup.json is missing"
L1_RPC_RATE_LIMIT="${L1_RPC_RATE_LIMIT:-28}"
printf '%s' "$L1_RPC_RATE_LIMIT" | grep -Eq '^[1-9][0-9]{0,3}$' || fail "L1_RPC_RATE_LIMIT must be requests per second, 1 to 9999"

JWT="${TMPDIR:-/tmp}/jwt.txt"
(umask 077 && printf '%s' "${ENGINE_JWT_SECRET#0x}" > "$JWT")

# --l1.rpc-max-cache-size: the sequencer only moves to a BSC block whose receipts are cached, and the
# cache keeps every block since the last one whose batch is confirmed. The default of 1,000 blocks is
# 7.5 minutes of BSC. A restart re-reads BSC from up to 1,200 blocks before that one, and a full cache
# stops the pre-fetcher short of the block the sequencer needs; its idle workers then use a third of
# the request allowance below and the node falls further behind (seen with 6,000 on launch day).
# 30,000 is 3 hours 45 minutes of BSC. The cache only holds that much while the node is that far behind.
# --l1.rpc-rate-limit: BNB Chain's public endpoints serve one address 10,000 requests per 5 minutes (33 a
# second) and refuse the rest of that window once it is passed. Following BSC takes about 12 a second;
# catching up after a restart sends hundreds unless limited. Raise L1_RPC_RATE_LIMIT for a keyed endpoint.
# No --sequencer.priority: with it, a sequencer that is behind the clock never lets derivation run, the
# confirmed head stops, the cache above never empties, and the sequencer cannot catch up.
set -- \
  --l1.trustrpc \
  --l1="$L1_RPC_URL" \
  --l2="http://$L2_ENGINE_HOST:8551" --l2.jwt-secret="$JWT" \
  --sequencer.enabled=true --sequencer.l1-confs=15 --sequencer.combined-engine \
  --verifier.l1-confs=15 \
  --l1.http-poll-interval=3s --l1.epoch-poll-interval=3s --l1.rpc-max-batch-size=20 --l1.max-concurrency=20 \
  --l1.rpc-max-cache-size=30000 --l1.rpc-rate-limit="$L1_RPC_RATE_LIMIT" \
  --rollup.config="$CHAIN_DIR/rollup.json" \
  --rpc.addr=0.0.0.0 --rpc.port=8547 --rpc.enable-admin \
  --p2p.sequencer.key="${GS_SEQUENCER_PRIVATE_KEY#0x}" --p2p.no-discovery \
  --metrics.enabled --metrics.addr=0.0.0.0 --metrics.port=7070
if [ -n "${L1_RPC_KIND:-}" ]; then set -- "$@" --l1.rpckind="$L1_RPC_KIND"; fi

exec op-node "$@"
