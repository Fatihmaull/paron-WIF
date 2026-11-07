#!/usr/bin/env bash
# One-command verification for judges and CI: `npm run verify:all` (or ./scripts/verify-all.sh).
# Exits non-zero on the first failing gate.
#   SKIP_E2E=1  skip the anvil end-to-end run (step 9)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"
export NEXT_TELEMETRY_DISABLED=1
LOG_DIR="$(mktemp -d -t paron-wif-verify.XXXXXX)"
trap 'rm -rf "$LOG_DIR"' EXIT
START=$(date +%s)
RESULTS=()

step() { printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }
pass() { RESULTS+=("✔ $1"); printf '\033[32m✔ %s\033[0m\n' "$1"; }
die() { printf '\033[31m✘ %s\033[0m\n' "$1"; exit 1; }

step "0/9 Toolchain"
command -v node >/dev/null || die "node not found (Node.js >= 22.18 required)"
command -v npm >/dev/null || die "npm not found"
command -v forge >/dev/null || die "forge not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || die "Node.js $(node -v) found; >= 22.18 is required (native TypeScript type stripping)"
if [ ! -d node_modules/next ] || [ ! -d node_modules/viem ]; then
  echo "installing workspace dependencies…"
  npm ci --no-audit --no-fund
fi
pass "toolchain: node $(node -v), $(forge --version | head -1)"

step "1/9 Brand & secret hygiene"
./scripts/audit-compliance.sh
pass "compliance audit (brand, secrets, env files)"

step "2/9 Solidity build: zero compiler warnings, EIP-170 sizes"
(cd contracts && forge build --force --sizes) 2>&1 | tee "$LOG_DIR/build.log"
[ "${PIPESTATUS[0]}" -eq 0 ] || die "forge build failed"
if grep -qiE '^(warning|error)' "$LOG_DIR/build.log"; then die "compiler/lint warnings present"; fi
pass "contracts compile with zero warnings; every contract is under the 24,576-byte limit"

step "3/9 Solidity tests (forge test -vvv)"
(cd contracts && forge test -vvv) 2>&1 | tee "$LOG_DIR/test.log"
[ "${PIPESTATUS[0]}" -eq 0 ] || die "forge tests failed"
FORGE_TESTS=$(grep -Eo '[0-9]+ tests passed' "$LOG_DIR/test.log" | tail -1)
pass "foundry: ${FORGE_TESTS:-all tests passed} (incl. fuzzing and on-chain judge-tour golden parity)"

step "4/9 ABI drift"
node scripts/export-abis.mjs --check
pass "typed ABIs in packages/core match the compiled contracts"

step "5/9 TypeScript typecheck (core, indexer, web)"
npm run --silent typecheck
pass "typecheck: core, indexer, web"

step "6/9 Core engine tests"
npm --workspace @paron-wif/core test 2>&1 | tee "$LOG_DIR/core.log" | grep -E '^# (tests|pass|fail)'
[ "${PIPESTATUS[0]}" -eq 0 ] || die "core tests failed"
pass "core: $(grep -Eo '^# pass [0-9]+' "$LOG_DIR/core.log" | grep -Eo '[0-9]+') tests (TypeScript engine == Solidity golden numbers)"

step "7/9 Indexer & API tests"
npm --workspace @paron-wif/indexer test 2>&1 | tee "$LOG_DIR/indexer.log" | grep -E '^# (tests|pass|fail)'
[ "${PIPESTATUS[0]}" -eq 0 ] || die "indexer tests failed"
pass "indexer: $(grep -Eo '^# pass [0-9]+' "$LOG_DIR/indexer.log" | grep -Eo '[0-9]+') tests (event reducer == ledger state, RPC resilience, REST API)"

step "8/9 Next.js production build"
npm --prefix web run build
pass "web: next build (/, /flywheel, /agents, /tour)"

if [ "${SKIP_E2E:-0}" = "1" ]; then
  RESULTS+=("- e2e skipped (SKIP_E2E=1)")
else
  step "9/9 Local chain end-to-end (anvil deploy + seed, indexer, live agent)"
  command -v anvil >/dev/null || die "anvil not found (ships with Foundry)"
  ./scripts/e2e-local.sh
  pass "e2e: deployed on anvil, indexer == contract views, live agent burned its own \$WIF"
fi

printf '\n\033[1mParon WIF verification summary (%ss)\033[0m\n' "$(( $(date +%s) - START ))"
printf '  %s\n' "${RESULTS[@]}"
printf '\033[1;32mALL CHECKS PASSED\033[0m\n'
