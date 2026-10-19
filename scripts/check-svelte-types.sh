#!/usr/bin/env bash
# Wires scripts/check-svelte-types.py into CI (job `svelte-check` in
# CI) the same way the other check scripts are wired in.
# a thin bash wrapper providing argument handling and a `--self-test` that
# proves the underlying check can actually go red, not just that it runs.
#
#   ./scripts/check-svelte-types.sh                  # gate: exit 0/1/2, see .py docstring
#   ./scripts/check-svelte-types.sh --update-baseline
#   ./scripts/check-svelte-types.sh --self-test      # controls; run before trusting it
#
# Background:. Two real runtime bugs (renamed class members
# read stale in NavTrail.svelte / FolderPathAutocomplete.svelte) shipped past
# tsc/jest/lint/build/check-naming.sh because none of them ever look inside a
# .svelte file. This closes that blind spot with svelte-check, ratcheted
# against a frozen baseline of pre-existing unrelated errors (see the .py
# docstring for why a ratchet, not a bare zero).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PYTHON:-python3}"
GATE="$REPO_ROOT/scripts/check-svelte-types.py"
BASELINE="$REPO_ROOT/scripts/svelte-check-baseline.json"
SELFTEST=0
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --self-test) SELFTEST=1; shift ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

if [[ "$SELFTEST" == "1" ]]; then
  # A gate that cannot go red is worse than no gate: it reads as a clean
  # bill of health forever. Both directions are checked here, using the ACTUAL
  # historical bug class this gate exists to catch -- not a synthetic stand-in
  # -- because that's the strongest available proof that a regression of this
  # exact shape would be caught.
  fail=0
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  echo "== copying src/ + config into a scratch workspace (symlinked node_modules) ..."
  mkdir -p "$WORK/probe"
  cp -R "$REPO_ROOT/src" "$WORK/probe/src"
  cp "$REPO_ROOT/tsconfig.json" "$REPO_ROOT/tsconfig.svelte-check.json" "$REPO_ROOT/svelte.config.mjs" "$WORK/probe/"
  ln -s "$REPO_ROOT/node_modules" "$WORK/probe/node_modules"

  echo
  echo "-- POSITIVE control: revert NavTrail.svelte's VaultShare.name -> .folderLabel"
  echo "   rename (the actual historical bug,). The gate MUST go red."
  sed -i.bak 's/{item\.folder\.folderLabel}/{item.folder.name}/' "$WORK/probe/src/components/NavTrail.svelte"
  if diff -q "$WORK/probe/src/components/NavTrail.svelte" "$WORK/probe/src/components/NavTrail.svelte.bak" >/dev/null; then
    echo "   FATAL: sed did not change NavTrail.svelte -- probe file layout drifted, self-test cannot proceed"; exit 2
  fi
  set +e
  out="$("$PY" "$GATE" --cwd "$WORK/probe" --baseline "$BASELINE" --tsconfig tsconfig.svelte-check.json 2>&1)"
  rc=$?
  set -e
  echo "$out" | sed 's/^/   /'
  if [[ $rc -eq 1 ]]; then
    echo "   PASS: exit 1 with the historical bug reintroduced"
  else
    echo "   FAIL: exit $rc -- the gate did not catch a real, previously-shipped bug"; fail=1
  fi

  echo
  echo "-- NEGATIVE control: restore the fixed file. The gate MUST come back green"
  echo "   (no new errors beyond the frozen baseline)."
  mv "$WORK/probe/src/components/NavTrail.svelte.bak" "$WORK/probe/src/components/NavTrail.svelte"
  set +e
  out="$("$PY" "$GATE" --cwd "$WORK/probe" --baseline "$BASELINE" --tsconfig tsconfig.svelte-check.json 2>&1)"
  rc=$?
  set -e
  echo "$out" | sed 's/^/   /'
  if [[ $rc -eq 0 ]]; then
    echo "   PASS: exit 0 on the fixed file"
  else
    echo "   FAIL: exit $rc -- the gate flags the CORRECT code, it would block every unrelated PR"; fail=1
  fi

  echo
  if [[ $fail -eq 0 ]]; then echo "SELF-TEST PASS"; exit 0; fi
  echo "SELF-TEST FAIL — do not trust this gate's number until fixed"; exit 2
fi

exec "$PY" "$GATE" ${EXTRA[@]+"${EXTRA[@]}"}
