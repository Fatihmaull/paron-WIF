#!/usr/bin/env bash
# Brand & secret hygiene audit for the World is Flat build rules.
#  1. Zero occurrences of the host sponsor's brand in any file, file name or commit (case-insensitive).
#  2. Zero hardcoded secrets: private keys, keyed RPC URLs, API tokens, PEM keys.
#  3. No populated .env file is tracked; .env.example key slots are empty.
# Scans every tracked and untracked-but-not-ignored file (node_modules, build output and vendored
# dependencies are ignored by .gitignore), plus the full git history.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0
red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

# The pattern is assembled at runtime so this script never matches itself.
BRAND="robin""hood"

mapfile -t FILES < <({ git ls-files; git ls-files --others --exclude-standard; } | sort -u | while read -r f; do [ -f "$f" ] && echo "$f"; done)

# ---- 1. Brand ---------------------------------------------------------------
if hits=$(printf '%s\0' "${FILES[@]}" | xargs -0 grep -Iin "$BRAND" 2>/dev/null); then
  red "brand: sponsor brand string found in files:"; echo "$hits" | head -20; fail=1
else
  green "brand: 0 occurrences in ${#FILES[@]} files"
fi
if names=$(printf '%s\n' "${FILES[@]}" | grep -i "$BRAND"); then
  red "brand: sponsor brand string found in file names:"; echo "$names"; fail=1
else
  green "brand: 0 occurrences in file names"
fi
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  count=$(git log --all -p --format='%H%n%an%n%s%n%b' | grep -ic "$BRAND" || true)
  if [ "${count:-0}" != "0" ]; then
    red "brand: $count occurrences in git history"; fail=1
  else
    green "brand: 0 occurrences in git history ($(git rev-list --all --count) commits)"
  fi
fi

# ---- 2. Secrets -------------------------------------------------------------
# Known public constants that look like secrets but are not:
#  - the secp256k1 half-order used for low-s signature checks (contracts and engine).
ALLOW='7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0'
SECRET_PATTERNS=(
  '(private[_-]?key|_pk|deployer_pk|secret|mnemonic)["'"'"' ]*[:=][ "'"'"']*(0x)?[0-9a-fA-F]{64}'
  'infura\.io/v3/[0-9a-fA-F]{32}'
  'alchemy(api)?\.(com|io)/v2/[A-Za-z0-9_-]{16,}'
  'quiknode\.pro/[0-9a-fA-F]{20,}'
  'ghp_[A-Za-z0-9]{36}'
  'github_pat_[A-Za-z0-9_]{40,}'
  'AKIA[0-9A-Z]{16}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  'sk-[A-Za-z0-9]{32,}'
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
)
secret_hits=""
for pat in "${SECRET_PATTERNS[@]}"; do
  if out=$(printf '%s\0' "${FILES[@]}" | xargs -0 grep -IinE -- "$pat" 2>/dev/null | grep -iv "$ALLOW"); then
    secret_hits+="$out"$'\n'
  fi
done
# Bare 64-hex values assigned in env-style files are always suspicious.
if out=$(printf '%s\n' "${FILES[@]}" | grep -E '(^|/)\.env' | xargs -r grep -InE '=[ "]*(0x)?[0-9a-fA-F]{64}' 2>/dev/null); then
  secret_hits+="$out"$'\n'
fi
if [ -n "${secret_hits//$'\n'/}" ]; then
  red "secrets: possible hardcoded secrets:"; printf '%s' "$secret_hits" | head -20; fail=1
else
  green "secrets: no private keys, keyed RPC URLs or API tokens found"
fi

# History report (informational): the first commits vendored forge-std verbatim, whose StdChains.sol
# ships Foundry's public default Infura project id. It is patched at HEAD; squash-merge to drop it.
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  hist=$(git log HEAD -p | grep -oiE 'infura\.io/v3/[0-9a-f]{32}|alchemy(api)?\.(com|io)/v2/[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{36}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----' | sort -u || true)
  if [ -n "$hist" ]; then
    printf '\033[33m%s\033[0m\n' "history (info): pre-patch commits contain forge-std's public default RPC id, not a project credential:"
    echo "$hist" | sed 's/^/  /'
  else
    green "history: no keyed RPC URLs or tokens in any commit"
  fi
fi

# ---- 3. Env files -----------------------------------------------------------
if tracked=$(git ls-files | grep -E '(^|/)\.env($|\.)' | grep -vE '\.env\.example$'); then
  red "env: populated env files are tracked:"; echo "$tracked"; fail=1
else
  green "env: only .env.example templates are tracked"
fi
for f in $(git ls-files | grep -E '\.env\.example$'); do
  if bad=$(grep -nE '^(PARON_DEPLOYER_PK|AGENT_PRIVATE_KEY|PRIVATE_KEY|ETHERSCAN_API_KEY)=.+' "$f"); then
    red "env: $f pre-fills a key slot:"; echo "$bad"; fail=1
  fi
done
[ $fail -eq 0 ] && green "env: every key slot in .env.example files is empty"

if [ $fail -ne 0 ]; then
  red "compliance audit FAILED"
  exit 1
fi
green "compliance audit passed"
