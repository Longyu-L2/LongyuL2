#!/usr/bin/env bash
# Deploys LONGYU's rollup contracts to BSC (testnet or mainnet) and builds the chain's genesis.json
# and rollup.json. Run on Linux with BNB Chain's opbnb repository at v0.5.6:
#
#   MODE=rehearsal         chain/testnet/deploy-rollup.sh   # testnet, on a local fork of BSC testnet; spends nothing
#   MODE=bsc-testnet       chain/testnet/deploy-rollup.sh   # testnet, for real; spends the deployer's tBNB
#   MODE=mainnet-rehearsal chain/testnet/deploy-rollup.sh   # mainnet, on a local fork of BSC; spends nothing
#   MODE=bsc               chain/testnet/deploy-rollup.sh   # mainnet, for real; spends the deployer's BNB
#
# Needs: Go 1.25 (to build op-node), Foundry, Node 22+, python3, and SECRETS: the path of a JSON file
# with the deployer's address and privateKey and the addresses of the sequencer, batcher and
# proposer, each under its own name; for mainnet also the challenger's address and the founders' Safe
# on BSC as safe.address. The deployer key is read from that file and
# never printed. Mainnet uses its own keys file: no key of the testnet's is reused.
set -euo pipefail

MODE="${MODE:?set MODE=rehearsal, bsc-testnet, mainnet-rehearsal or bsc}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OPBNB="${OPBNB:-$HOME/longyu/opbnb}"
BIN="${BIN:-$HOME/longyu/bin}"
SECRETS="${SECRETS:?set SECRETS to the keys file}"
case "$MODE" in
  rehearsal | bsc-testnet) NETWORK=testnet L1_CHAIN=97 L2_CHAIN=668801 L1_NAME="BSC testnet" COIN=tBNB
    L1_PUBLIC="${BSC_TESTNET_RPC:-https://bsc-testnet-rpc.publicnode.com}" ;;
  mainnet-rehearsal | bsc) NETWORK=mainnet L1_CHAIN=56 L2_CHAIN=668800 L1_NAME="BSC" COIN=BNB
    L1_PUBLIC="${BSC_RPC:-https://bsc-rpc.publicnode.com}" ;;
  *) printf 'deploy-rollup: MODE must be rehearsal, bsc-testnet, mainnet-rehearsal or bsc\n' >&2; exit 1 ;;
esac
# A unique CREATE2 salt: with the default one, implementation addresses already used on BSC collide.
# Every new deployment needs a salt not used before.
if [ "$NETWORK" = testnet ]; then IMPL_SALT="${IMPL_SALT:-longyu-668801-v3}"; else IMPL_SALT="${IMPL_SALT:-longyu-668800-v1}"; fi
export PATH="$HOME/.local/go/bin:$HOME/.foundry/bin:$PATH"

say() { printf '\n> %s\n' "$*"; }
fail() { printf 'deploy-rollup: %s\n' "$*" >&2; exit 1; }
json() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))$2)" "$1"; }

# ------------------------------------------------------------------ checks
[ -d "$OPBNB/packages/contracts-bedrock" ] || fail "opbnb not found at $OPBNB (git clone --branch v0.5.6 https://github.com/bnb-chain/opbnb)"
[ "$(git -C "$OPBNB" describe --tags --exact-match 2>/dev/null || git -C "$OPBNB" rev-parse HEAD)" = "v0.5.6" ] ||
  [ "$(git -C "$OPBNB" rev-parse HEAD)" = "5886d22b3c62d96af0ce7f2b8682244032d07a77" ] || fail "opbnb must be at v0.5.6"
[ -n "$SECRETS" ] && [ -f "$SECRETS" ] || fail "keys file not found at $SECRETS"
for t in forge cast anvil go node python3; do command -v "$t" >/dev/null || fail "$t is not installed"; done

DEPLOYER=$(json "$SECRETS" "['deployer']['address']")
SEQUENCER=$(json "$SECRETS" "['sequencer']['address']")
BATCHER=$(json "$SECRETS" "['batcher']['address']")
PROPOSER=$(json "$SECRETS" "['proposer']['address']")
DEPLOYER_KEY=$(json "$SECRETS" "['deployer']['privateKey']")
CHALLENGER="" SAFE=""
if [ "$NETWORK" = mainnet ]; then
  CHALLENGER=$(json "$SECRETS" "['challenger']['address']")
  SAFE=$(json "$SECRETS" "['safe']['address']")
fi

case "$MODE" in
  rehearsal | mainnet-rehearsal)
    OUT="$HOME/longyu/$MODE"
    L1="http://127.0.0.1:8546"
    BLOCK_TAG=latest ;;
  *)
    OUT="$REPO/chain/$NETWORK"
    L1="$L1_PUBLIC"
    BLOCK_TAG=finalized
    [ ! -f "$OUT/l1-deployments.json" ] || fail "$OUT/l1-deployments.json exists: the rollup is already deployed" ;;
esac
mkdir -p "$OUT" "$BIN"

# ------------------------------------------------------------------ tools
if [ ! -x "$BIN/op-node" ]; then
  say "Building op-node from opbnb v0.5.6"
  (cd "$OPBNB/op-node" && go build -o "$BIN/op-node" ./cmd)
fi
say "Compiling the rollup contracts (periphery and tests skipped)"
# forge re-clones every git submodule it sees as uninitialised before it builds, with no switch to
# stop it, and opbnb v0.5.6 lists gelatodigital/automate, a repository that no longer exists (only
# periphery code uses it, and periphery is skipped). So the same v0.5.6 sources are built from a
# copy kept in a one-commit git repository of its own, which has no submodules (the deploy script
# stamps `git rev-parse HEAD` into its log). Inputs and outputs live in the copy's deploy-config/
# and deployments/ folders, the only ones its foundry.toml lets scripts read and write.
BEDROCK="${BEDROCK:-$HOME/longyu/contracts-bedrock-v0.5.6}"
export GIT_TERMINAL_PROMPT=0
rsync -a --delete --exclude .git --exclude forge-artifacts --exclude cache --exclude artifacts --exclude deployments \
  "$OPBNB/packages/contracts-bedrock/" "$BEDROCK/"
mkdir -p "$BEDROCK/deployments"
if [ ! -d "$BEDROCK/.git" ]; then
  git -C "$BEDROCK" init -q
  printf '%s\n' forge-artifacts cache artifacts deployments broadcast > "$BEDROCK/.git/info/exclude"
  git -C "$BEDROCK" add -A
  git -C "$BEDROCK" -c user.name="LONGYU deploy" -c user.email="deploy@longyu.invalid" commit -q \
    -m "bnb-chain/opbnb v0.5.6 (5886d22b3c62d96af0ce7f2b8682244032d07a77) packages/contracts-bedrock"
fi
[ ! -f "$BEDROCK/.gitmodules" ] || fail "$BEDROCK must not declare git submodules"
# The wrapped gas token at 0x4200000000000000000000000000000000000006 builds its name from the gas
# token's, which this software only knows as "Ether" ("Wrapped Ether", "WETH"). LONGYU's gas token
# is BNB, so its two name functions answer with fixed text. Nothing else in the contract changes,
# and the script stops here if upstream's lines are not the ones expected.
python3 - "$BEDROCK/src/L2/WETH.sol" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
for old, new in (
    ('name_ = string.concat("Wrapped ", L1Block(Predeploys.L1_BLOCK_ATTRIBUTES).gasPayingTokenName());', 'name_ = "Wrapped BNB";'),
    ('symbol_ = string.concat("W", L1Block(Predeploys.L1_BLOCK_ATTRIBUTES).gasPayingTokenSymbol());', 'symbol_ = "WBNB";'),
):
    if src.count(old) != 1:
        sys.exit("deploy-rollup: src/L2/WETH.sol is not the v0.5.6 text; the wrapped BNB name was not applied")
    src = src.replace(old, new)
open(path, "w").write(src)
PY
# CONFIG_RPC: another endpoint of the same BSC for the deploy config's block lookup, if node cannot reach $L1.
SKIP=(--skip "src/periphery/**" --skip "test/**" --skip "scripts/periphery/**")
(cd "$BEDROCK" && forge build "${SKIP[@]}")
CONFIG_IN="$BEDROCK/deploy-config/longyu-$L2_CHAIN-$MODE.json"
DEPLOYED="$BEDROCK/deployments/longyu-$L2_CHAIN-$MODE-l1.json"
ALLOCS="$BEDROCK/deployments/longyu-$L2_CHAIN-$MODE-allocs.json"

# ------------------------------------------------------------------ L1
case "$MODE" in rehearsal | mainnet-rehearsal)
  # KEEP_FORK=1: a fork already running on port 8546 (chain/mainnet/rehearse.sh starts one and runs the
  # later steps against it); otherwise one is started here and stopped at the end.
  if [ "${KEEP_FORK:-}" != 1 ]; then
    say "Starting a local fork of $L1_NAME"
    anvil --fork-url "$L1_PUBLIC" --chain-id "$L1_CHAIN" --port 8546 --silent &
    ANVIL=$!
    trap 'kill $ANVIL 2>/dev/null || true' EXIT
  fi
  for _ in $(seq 60); do cast chain-id --rpc-url "$L1" >/dev/null 2>&1 && break; sleep 1; done
  cast rpc --rpc-url "$L1" anvil_setBalance "$DEPLOYER" 0x16345785D8A0000 >/dev/null # 0.1 $COIN, local only
esac
[ "$(cast chain-id --rpc-url "$L1")" = "$L1_CHAIN" ] || fail "L1 is not $L1_NAME (chain $L1_CHAIN)"
BALANCE=$(cast balance --rpc-url "$L1" "$DEPLOYER")
say "Deployer $DEPLOYER holds $(cast from-wei "$BALANCE") $COIN"
# Wei amounts pass 64 bits above 9.2 BNB, so they are compared in python, not with the shell's -ge.
wei_ge() { python3 -c "import sys; sys.exit(0 if int(sys.argv[1]) >= int(sys.argv[2]) else 1)" "$1" "$2"; }
wei_sub() { python3 -c "import sys; print(int(sys.argv[1]) - int(sys.argv[2]))" "$1" "$2"; }
wei_ge "$BALANCE" 10000000000000000 || fail "deployer needs at least 0.01 $COIN"
if [ "$NETWORK" = mainnet ]; then
  # The founders' Safe owns the system config, holds the pause and receives the fees from the first
  # block, so it is checked before anything is spent: a Safe that needs two signatures or more, and that
  # the deploying key does not sign for. CreateSafe.s.sol makes one; the handover checks it in full.
  [ "$(cast code --rpc-url "$L1" "$SAFE")" != 0x ] || fail "the Safe $SAFE has no code on $L1_NAME: it must be the founders' Safe"
  THRESHOLD=$(cast call --rpc-url "$L1" "$SAFE" "getThreshold()(uint256)") || fail "$SAFE is not a Safe"
  wei_ge "$THRESHOLD" 2 || fail "the Safe $SAFE needs only $THRESHOLD signature(s); it must need at least two"
  [ "$(cast call --rpc-url "$L1" "$SAFE" "isOwner(address)(bool)" "$DEPLOYER")" = false ] || fail "the deploying key signs for the Safe $SAFE"
fi
GAS_PRICE=$(cast gas-price --rpc-url "$L1")
# The deploy scripts shell out to `cast block`, which reads its node from ETH_RPC_URL.
export ETH_RPC_URL="$L1"

# ------------------------------------------------------------------ deploy
say "Writing the deploy config (starting from the $BLOCK_TAG BSC block)"
NETWORK="$NETWORK" L1_RPC_URL="${CONFIG_RPC:-$L1}" L1_BLOCK_TAG="$BLOCK_TAG" ADMIN="$DEPLOYER" SEQUENCER="$SEQUENCER" BATCHER="$BATCHER" PROPOSER="$PROPOSER" \
  CHALLENGER="$CHALLENGER" SAFE="$SAFE" node --experimental-strip-types --no-warnings "$REPO/chain/testnet/deploy-config.ts" > "$OUT/deploy-config.json"
cp "$OUT/deploy-config.json" "$CONFIG_IN"
rm -f "$DEPLOYED" "$ALLOCS"
# BSC keeps a block's milliseconds in its mixHash. The L2 genesis is stamped with whole seconds, and
# op-node will not start a chain whose genesis is older than its L1 origin, so the origin must sit
# on a whole second. Checked here, before anything is spent.
block_ms() { cast block "$1" --rpc-url "$L1" --json | python3 -c "import json,sys; b=json.load(sys.stdin); print(int(b['timestamp'], 16) * 1000 + int(b['mixHash'], 16))"; }
START=$(json "$OUT/deploy-config.json" "['l1StartingBlockTag']")
START_MS=$(block_ms "$START")
[ $((START_MS % 1000)) = 0 ] || fail "L1 starting block $START is $((START_MS % 1000)) ms past the second; op-node could not start the chain"

BEFORE=$(cast balance --rpc-url "$L1" "$DEPLOYER")
say "Deploying the L1 contracts (gas price $(cast from-wei "$GAS_PRICE" gwei) gwei)"
(cd "$BEDROCK" &&
  DEPLOY_CONFIG_PATH="$CONFIG_IN" DEPLOYMENT_OUTFILE="$DEPLOYED" IMPL_SALT="$IMPL_SALT" \
    forge script scripts/Deploy.s.sol:Deploy --rpc-url "$L1" --broadcast --slow --legacy --with-gas-price "$GAS_PRICE" \
      --private-key "$DEPLOYER_KEY" --non-interactive "${SKIP[@]}")
# --non-interactive answers forge's "transaction to an address without code" prompt. Checked with a
# dry run: the only such transactions (2 of 52) call l2OutputOracleStartingTimestamp() on the deploy
# script's own config helper, which upstream calls inside the broadcast. They carry no value, reach
# an address with no code and no key, and change nothing.
cp "$DEPLOYED" "$OUT/l1-deployments.json"

SPENT=$(wei_sub "$BEFORE" "$(cast balance --rpc-url "$L1" "$DEPLOYER")")
say "Deployment cost $(cast from-wei "$SPENT") $COIN"

say "Building the L2 genesis state"
(cd "$BEDROCK" &&
  DEPLOY_CONFIG_PATH="$CONFIG_IN" CONTRACT_ADDRESSES_PATH="$DEPLOYED" STATE_DUMP_PATH="$ALLOCS" \
    forge script scripts/L2Genesis.s.sol:L2Genesis --sig 'runWithStateDump()' "${SKIP[@]}")
cp "$ALLOCS" "$OUT/l2-allocs.json"

say "Writing genesis.json and rollup.json"
"$BIN/op-node" genesis l2 --l1-rpc "$L1" --deploy-config "$OUT/deploy-config.json" --l1-deployments "$OUT/l1-deployments.json" \
  --l2-allocs "$OUT/l2-allocs.json" --outfile.l2 "$OUT/genesis.json" --outfile.rollup "$OUT/rollup.json"
ORIGIN_MS=$(block_ms "$(json "$OUT/rollup.json" "['genesis']['l1']['hash']")")

# ------------------------------------------------------------------ verify
say "Checking the results"
python3 - "$OUT" "$ORIGIN_MS" "$L1_CHAIN" "$L2_CHAIN" <<'PY'
import json, sys
out, origin_ms, l1_chain, l2_chain = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
rollup = json.load(open(f"{out}/rollup.json"))
genesis = json.load(open(f"{out}/genesis.json"))
deps = json.load(open(f"{out}/l1-deployments.json"))
alloc = {k.lower().removeprefix("0x"): v for k, v in genesis["alloc"].items()}
wbnb = bytes.fromhex(alloc["4200000000000000000000000000000000000006"]["code"].removeprefix("0x"))
checks = {
    f"rollup L1 chain is {l1_chain}": rollup["l1_chain_id"] == l1_chain,
    f"rollup L2 chain is {l2_chain}": rollup["l2_chain_id"] == l2_chain,
    f"genesis chain is {l2_chain}": genesis["config"]["chainId"] == l2_chain,
    "deposits go to the deployed portal": rollup["deposit_contract_address"].lower() == deps["OptimismPortalProxy"].lower(),
    "system config is the deployed one": rollup["l1_system_config_address"].lower() == deps["SystemConfigProxy"].lower(),
    "batch inbox is LONGYU's": rollup["batch_inbox_address"].lower() == "0xff" + str(l2_chain).zfill(38),
    # block_time is the pre-Volta setting. With Volta and Fourier active from the first block the
    # chain runs at 250 ms, which is what the deployed L2OutputOracle assumes for blocks after 0.
    "250 ms blocks from genesis": rollup["block_time"] == 1
    and rollup["volta_time"] == rollup["fourier_time"] == rollup["genesis"]["l2_time"],
    "genesis is not older than its L1 origin": rollup["genesis"]["l2_time"] * 1000 >= origin_ms,
    "no pre-funded accounts": all(int(a.get("balance", "0x0"), 16) < 10**18 for a in genesis["alloc"].values()),
    "the wrapped gas token is named Wrapped BNB (WBNB)": b"Wrapped BNB" in wbnb and b"WBNB" in wbnb and b"Wrapped Ether" not in wbnb,
}
for name, ok in checks.items():
    print(("ok   " if ok else "FAIL ") + name)
if not all(checks.values()):
    sys.exit(1)
print("L2OutputOracleProxy (set as L2OO_ADDRESS on op-proposer):", deps["L2OutputOracleProxy"])
PY
say "Done. Files in $OUT"
