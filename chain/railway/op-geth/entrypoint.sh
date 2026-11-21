#!/bin/sh
# Starts op-geth as the LONGYU sequencer's execution client.
# Flags follow BNB Chain's "Run your own L2" guide with three changes for a public host:
# - The public HTTP port (8545) serves only eth, net and web3. The guide's debug, txpool and engine
#   namespaces stay on the private WebSocket port (8546) and the authenticated engine port (8551).
# - gcmode full, not archive: the path state scheme keeps no archive, and Railway volumes are small.
# - No peers (--nodiscover, --maxpeers 0): this node is the only one, and Railway has no public UDP.
# ROLE=verifier runs it for the watchtower's own node instead: it builds no blocks, only those its
# op-node derives from BSC, and keeps the same proofs so that node can rebuild every state root.
set -eu

DATA_DIR="${DATA_DIR:-/db}"
CHAIN_DIR="${CHAIN_DIR:-/chain}"
fail() { echo "op-geth: $*" >&2; exit 1; }
is_hex() { printf '%s' "$1" | grep -Eq "^(0x)?[0-9a-fA-F]{$2}\$"; }

[ -n "${L2_CHAIN_ID:-}" ] || fail "L2_CHAIN_ID is required"
case "$L2_CHAIN_ID" in *[!0-9]*) fail "L2_CHAIN_ID must be a number" ;; esac
ROLE="${ROLE:-sequencer}"
case "$ROLE" in
  sequencer) printf '%s' "${GS_SEQUENCER_ADDRESS:-}" | grep -Eq '^0x[0-9a-fA-F]{40}$' || fail "GS_SEQUENCER_ADDRESS must be an address" ;;
  verifier) ;;
  *) fail "ROLE must be sequencer or verifier" ;;
esac
is_hex "${ENGINE_JWT_SECRET:-}" 64 || fail "ENGINE_JWT_SECRET must be 32 bytes of hex (openssl rand -hex 32)"
CACHE_MB="${GETH_CACHE_MB:-4096}"
case "$CACHE_MB" in "" | *[!0-9]*) fail "GETH_CACHE_MB must be a number" ;; esac
[ -f "$CHAIN_DIR/genesis.json" ] || fail "$CHAIN_DIR/genesis.json is missing"
# The genesis baked into the image must be this chain's.
grep -Eq "\"chainId\"[[:space:]]*:[[:space:]]*$L2_CHAIN_ID([^0-9]|\$)" "$CHAIN_DIR/genesis.json" || fail "genesis.json is not for chain $L2_CHAIN_ID"

# Volumes mount owned by root; run geth as its own user when started as root.
mkdir -p "$DATA_DIR"
RUN=""
if [ "$(id -u)" = "0" ]; then
  [ "$(stat -c %u "$DATA_DIR")" = "$(id -u geth)" ] || chown -R geth:geth "$DATA_DIR"
  RUN="su-exec geth"
fi

JWT="$DATA_DIR/jwt.txt"
(umask 077 && printf '%s' "${ENGINE_JWT_SECRET#0x}" > "$JWT")
[ -z "$RUN" ] || chown geth:geth "$JWT"

# The chain data on the volume belongs to one genesis, and a different genesis.json is a different
# chain. Never start on another chain's data. Relaunching the testnet from a new genesis erases the
# data once, and only when RESET_CHAIN_FOR_GENESIS names that genesis file's SHA-256.
GENESIS_SHA=$(sha256sum < "$CHAIN_DIR/genesis.json" | cut -d' ' -f1)
MARK="$DATA_DIR/genesis.sha256"
if [ -d "$DATA_DIR/datadir/geth/chaindata" ]; then
  HAVE=$(cat "$MARK" 2>/dev/null || echo unknown)
  if [ "$HAVE" != "$GENESIS_SHA" ]; then
    [ "${RESET_CHAIN_FOR_GENESIS:-}" = "$GENESIS_SHA" ] ||
      fail "the volume holds the chain of genesis $HAVE, not $GENESIS_SHA. To erase it and start this chain, set RESET_CHAIN_FOR_GENESIS=$GENESIS_SHA"
    echo "op-geth: erasing the chain of genesis $HAVE"
    rm -rf "$DATA_DIR/datadir"
  fi
fi

if [ ! -d "$DATA_DIR/datadir/geth/chaindata" ]; then
  echo "op-geth: initialising chain $L2_CHAIN_ID from genesis $GENESIS_SHA"
  $RUN geth init --datadir="$DATA_DIR/datadir" --state.scheme path --db.engine pebble "$CHAIN_DIR/genesis.json"
  printf '%s' "$GENESIS_SHA" > "$MARK"
fi

if [ "$ROLE" = sequencer ]; then
  set -- --mine --miner.newpayload-timeout=650ms --miner.gaslimit=150000000 --miner.gasprice=1 \
    --miner.etherbase="$GS_SEQUENCER_ADDRESS"
else
  set --
fi

exec $RUN geth \
  --datadir "$DATA_DIR/datadir" \
  --http --http.addr=0.0.0.0 --http.port=8545 --http.vhosts="*" --http.corsdomain="*" --http.api=eth,net,web3 \
  --ws --ws.addr=0.0.0.0 --ws.port=8546 --ws.origins="*" --ws.api=eth,net,web3,debug,txpool \
  --syncmode=full --gcmode=full \
  "$@" \
  --nodiscover --maxpeers=0 \
  --networkid="$L2_CHAIN_ID" \
  --authrpc.vhosts="*" --authrpc.addr=0.0.0.0 --authrpc.port=8551 --authrpc.jwtsecret="$JWT" \
  --txpool.globalslots=20000 --txpool.globalqueue=10000 --txpool.accountqueue=500 --txpool.accountslots=500 \
  --txpool.pricelimit=1 --txpool.nolocals=true --txpool.reannouncetime=3m --txpool.reannounceremotes=true \
  --cache="$CACHE_MB" --cache.preimages \
  --rollup.disabletxpoolgossip=false \
  --history.transactions=0 \
  --journalfile \
  --pathdb.nodebuffer=list --pathdb.proposeblock=3600 --pathdb.enableproofkeeper \
  --metrics --metrics.addr=0.0.0.0 --metrics.port=6060 \
  --verbosity=3
