#!/usr/bin/env bash
# Local end-to-end run on a throwaway anvil chain:
#   anvil -> forge script DeployParonWif (deploy + seed) -> indexer sync cross-checked against contract views
#   -> autonomous CFO agent signing live transactions -> re-index and verify its $WIF burn on-chain.
# Keys are derived at runtime from anvil's public development mnemonic; nothing secret is stored in the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
PORT="${E2E_ANVIL_PORT:-8547}"
RPC="http://127.0.0.1:${PORT}"
DEV_MNEMONIC="test test test test test test test test test test test junk"

for bin in anvil cast forge node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "e2e: missing $bin"; exit 1; }
done

LOG="$(mktemp -t paron-wif-anvil.XXXXXX)"
anvil --port "$PORT" --chain-id 31337 --silent >"$LOG" 2>&1 &
ANVIL_PID=$!
cleanup() { kill "$ANVIL_PID" >/dev/null 2>&1 || true; rm -f "$LOG"; }
trap cleanup EXIT

for _ in $(seq 1 50); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done

export PARON_DEPLOYER_PK="$(cast wallet private-key --mnemonic "$DEV_MNEMONIC" --mnemonic-index 0)"
export AGENT_PRIVATE_KEY="$(cast wallet private-key --mnemonic "$DEV_MNEMONIC" --mnemonic-index 1)"

echo "e2e: deploying + seeding Paron WIF on anvil :${PORT}"
(cd "$ROOT/contracts" && forge script script/DeployParonWif.s.sol --rpc-url "$RPC" --broadcast --offline >/dev/null)

echo "e2e: indexing, cross-checking and running the live agent"
(cd "$ROOT/indexer" && RPC_URL="$RPC" NEXT_PUBLIC_CHAIN_ID=31337 INDEXER_CONFIRMATIONS=0 node scripts/e2e-check.ts)
