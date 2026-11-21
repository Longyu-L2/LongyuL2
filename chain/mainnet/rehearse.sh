#!/usr/bin/env bash
# Rehearses LONGYU's mainnet launch on BSC end to end, on a local fork of BSC, with throwaway keys.
# Spends nothing. Run on Linux with the same tools as chain/testnet/deploy-rollup.sh:
#
#   chain/mainnet/rehearse.sh
#
# Steps, in launch order: the founders' Safe (two of three throwaway signers), the rollup deployment,
# and the handover of the upgrade rights to the timelock. LONG is not on BSC at launch: it is created
# on LONGYU by mining (contracts/script/DeployMainnetMining.s.sol), and its BSC copy after the TGE. Each step's own
# checks run; the gas each step used is reported at BSC's current gas price, so the BNB needed for
# the real launch is known before anything is spent.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BSC_RPC="${BSC_RPC:-https://bsc-rpc.publicnode.com}"
WORK="$HOME/longyu/mainnet-rehearsal"
KEYS="$WORK-keys.json"
L1="http://127.0.0.1:8546"
# The handover reads the deployment from the repository's chain folder, the only one it may read.
COPY="$REPO/chain/mainnet/.rehearsal"
export PATH="$HOME/.foundry/bin:$PATH"
# Build output, caches and broadcast records of the rehearsal stay out of the repository.
export FOUNDRY_OUT="$WORK/out" FOUNDRY_CACHE_PATH="$WORK/cache" FOUNDRY_BROADCAST="$WORK/broadcast"

say() { printf '\n> %s\n' "$*"; }
fail() { printf 'rehearse: %s\n' "$*" >&2; exit 1; }
json() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))$2)" "$1"; }

mkdir -p "$WORK"
say "Throwaway keys for the rehearsal"
python3 - "$KEYS" <<'PY'
import json, subprocess, sys
out = {}
for name in ["deployer", "sequencer", "batcher", "proposer", "challenger", "signer1", "signer2", "signer3", "sender"]:
    k = json.loads(subprocess.check_output(["cast", "wallet", "new", "--json"]))[0]
    out[name] = {"address": k["address"], "privateKey": k["private_key"]}
open(sys.argv[1], "w").write(json.dumps(out))
PY
chmod 600 "$KEYS"
key() { json "$KEYS" "['$1']['privateKey']"; }
addr() { json "$KEYS" "['$1']['address']"; }

say "Starting a local fork of BSC"
anvil --fork-url "$BSC_RPC" --chain-id 56 --port 8546 --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true; rm -rf "$COPY"' EXIT
for _ in $(seq 60); do cast chain-id --rpc-url "$L1" >/dev/null 2>&1 && break; sleep 1; done
[ "$(cast chain-id --rpc-url "$L1")" = 56 ] || fail "the fork is not BSC"
GAS_PRICE=$(cast gas-price --rpc-url "$BSC_RPC")
for who in deployer sender; do cast rpc --rpc-url "$L1" anvil_setBalance "$(addr $who)" 0x16345785D8A0000 >/dev/null; done
report() { # name, gas used
  python3 -c "import sys; g=int(sys.argv[2]); p=int(sys.argv[3]); print(f'  {sys.argv[1]}: {g:,} gas, {g*p/1e18:.5f} BNB at {p/1e9:g} gwei')" "$1" "$2" "$GAS_PRICE"
}
gas_of() { # a forge script's broadcast record
  python3 -c "import json,sys; print(sum(int(r['gasUsed'], 16) for r in json.load(open(sys.argv[1]))['receipts']))" "$FOUNDRY_BROADCAST/$1/56/run-latest.json"
}

cd "$REPO/contracts"
say "The founders' Safe: two of three signatures"
OWNERS="$(addr signer1),$(addr signer2),$(addr signer3)" THRESHOLD=2 \
  forge script script/CreateSafe.s.sol:CreateSafe --rpc-url "$L1" --broadcast --private-key "$(key sender)" --sender "$(addr sender)" >"$WORK/safe.log" 2>&1 ||
  { tail -30 "$WORK/safe.log"; fail "the Safe was not created"; }
SAFE=$(grep -Eo 'Safe 0x[0-9a-fA-F]{40}' "$WORK/safe.log" | head -1 | cut -d' ' -f2)
[ -n "$SAFE" ] || fail "no Safe created"
report "Safe" "$(gas_of CreateSafe.s.sol)"
python3 - "$KEYS" "$SAFE" <<'PY'
import json, sys
k = json.load(open(sys.argv[1])); k["safe"] = {"address": sys.argv[2]}
open(sys.argv[1], "w").write(json.dumps(k))
PY

say "The rollup on BSC"
MODE=mainnet-rehearsal KEEP_FORK=1 SECRETS="$KEYS" bash "$REPO/chain/testnet/deploy-rollup.sh" >"$WORK/rollup.log" 2>&1 ||
  { tail -30 "$WORK/rollup.log"; fail "the rollup deployment failed"; }
grep -E '^(ok|FAIL) ' "$WORK/rollup.log"
# deploy-rollup.sh reports what it spent at the fork's gas price; the same gas at BSC's price:
python3 - "$WORK/rollup.log" "$GAS_PRICE" <<'PY'
import re, sys
log = open(sys.argv[1]).read()
fork = float(re.search(r"gas price ([0-9.]+) gwei", log).group(1)) * 1e9
spent = float(re.search(r"Deployment cost ([0-9.]+) BNB", log).group(1)) * 1e18
gas, price = spent / fork, int(sys.argv[2])
print(f"  rollup: {gas:,.0f} gas, {gas * price / 1e18:.5f} BNB at {price / 1e9:g} gwei")
PY
mkdir -p "$COPY"
cp "$WORK/l1-deployments.json" "$COPY/l1-deployments.json"
DEPLOYMENTS="../chain/mainnet/.rehearsal/l1-deployments.json"

say "Upgrade rights to the timelock"
SAFE="$SAFE" CHALLENGER="$(addr challenger)" DEPLOYMENTS="$DEPLOYMENTS" \
  forge script script/HandoverMainnetBsc.s.sol:HandoverMainnetBsc --rpc-url "$L1" --broadcast --private-key "$(key deployer)" >"$WORK/handover.log" 2>&1 ||
  { tail -30 "$WORK/handover.log"; fail "the handover failed"; }
TIMELOCK=$(grep -Eo 'Timelock 0x[0-9a-fA-F]{40}' "$WORK/handover.log" | cut -d' ' -f2)
report "handover" "$(gas_of HandoverMainnetBsc.s.sol)"
SAFE="$SAFE" CHALLENGER="$(addr challenger)" TIMELOCK="$TIMELOCK" DEPLOYMENTS="$DEPLOYMENTS" \
  forge script script/HandoverMainnetBsc.s.sol:HandoverMainnetBsc --sig "verify()" --rpc-url "$L1" >/dev/null
echo "  verified: the timelock $TIMELOCK holds the upgrade rights; only the Safe proposes and runs"

say "Done. Files in $WORK"
