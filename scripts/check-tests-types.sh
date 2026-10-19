#!/usr/bin/env bash
# Wires scripts/check-tests-types.py into CI (job `tests-typecheck` in
# CI) the same way the other check scripts are wired in.
# check-svelte-types.py: a thin bash wrapper providing argument handling and
# a `--self-test` that proves the underlying check can actually go red, not
# just that it runs.
#
#   ./scripts/check-tests-types.sh                  # gate: exit 0/1/2, see .py docstring
#   ./scripts/check-tests-types.sh --update-baseline
#   ./scripts/check-tests-types.sh --self-test      # controls; run before trusting it
#
# Background:, follow-up to's.svelte gate. Two real
# regressions (a hand-rolled __tests__ mock's own field going stale after the
# real production field it stands in for was renamed) shipped past
# tsc/jest/lint/build in one evening because __tests__ was excluded from
# tsc's `include` entirely. This closes that blind spot, ratcheted against a
# frozen baseline of pre-existing unrelated errors (see the .py docstring for
# why a ratchet, not a bare zero).
#
# Three controls, not two: the first two reproduce the ACTUAL historical
# bugs (FakeFolder.connected -> isOnline, MR !228; FakeFile.guid ->
# entityGuid, MR !235) via the `Pick<>` convention now used in
# __tests__/crdtBackgroundSyncPoller.test.ts -- reverting the `Pick<>`
# reference to the old field name must fail, because that field no longer
# exists on the real production type. The third targets a file that
# currently has ZERO tsc errors and has nothing to do with either historical
# case (__tests__/mocks/MockClock.ts) with a synthetic, unrelated type
# error -- proving this is a real general type-checker gate, not something
# that only recognizes the two names it was written to reproduce (the same
# distinction drew for check-svelte-types.py).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PYTHON:-python3}"
GATE="$REPO_ROOT/scripts/check-tests-types.py"
BASELINE="$REPO_ROOT/scripts/tests-typecheck-baseline.json"
SELFTEST=0
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --self-test) SELFTEST=1; shift ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

run_gate() {
  # $1 = probe cwd
  "$PY" "$GATE" --cwd "$1" --baseline "$BASELINE" --tsconfig tsconfig.tests.json
}

if [[ "$SELFTEST" == "1" ]]; then
  fail=0
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  echo "== copying src/ + __tests__/ + config into a scratch workspace (symlinked node_modules) ..."
  mkdir -p "$WORK/probe"
  cp -R "$REPO_ROOT/src" "$WORK/probe/src"
  cp -R "$REPO_ROOT/__tests__" "$WORK/probe/__tests__"
  # Test imports must resolve in the isolated probe as in the real checkout.
  mkdir -p "$WORK/probe/scripts"
  cp -R "$REPO_ROOT/scripts/test" "$WORK/probe/scripts/test"
  cp "$REPO_ROOT/tsconfig.json" "$REPO_ROOT/tsconfig.tests.json" "$WORK/probe/"
  ln -s "$REPO_ROOT/node_modules" "$WORK/probe/node_modules"
  TARGET="$WORK/probe/__tests__/crdtBackgroundSyncPoller.test.ts"
  MOCKCLOCK="$WORK/probe/__tests__/mocks/MockClock.ts"

  # ── Control 1 (positive): FakeFile.guid / MR !235 ────────
  echo
  echo "-- POSITIVE control 1: revert FakeFile's Pick<Document, ...> to the OLD"
  echo "   'guid' field name (real historical bug: Document.guid -> entityGuid)."
  echo "   The gate MUST go red, naming crdtBackgroundSyncPoller.test.ts."
  cp "$TARGET" "$TARGET.bak1"
  sed -i.tmp 's/Pick<Document, "isOnline" | "entityGuid">/Pick<Document, "isOnline" | "guid">/' "$TARGET"
  rm -f "$TARGET.tmp"
  if diff -q "$TARGET" "$TARGET.bak1" >/dev/null; then
    echo "   FATAL: sed did not change the file -- probe layout drifted, self-test cannot proceed"; exit 2
  fi
  set +e
  out="$(run_gate "$WORK/probe" 2>&1)"; rc=$?
  set -e
  echo "$out" | sed 's/^/   /'
  if [[ $rc -eq 1 ]] && echo "$out" | grep -q "crdtBackgroundSyncPoller.test.ts"; then
    echo "   PASS: exit 1, naming the file, with the historical guid bug reintroduced"
  else
    echo "   FAIL: exit $rc, or did not name the file -- the gate did not catch a real, previously-shipped bug"; fail=1
  fi
  mv "$TARGET.bak1" "$TARGET"

  echo
  echo "-- NEGATIVE control 1: restore the fixed field. The gate MUST come back"
  echo "   green (no new errors beyond the frozen baseline)."
  set +e
  out="$(run_gate "$WORK/probe" 2>&1)"; rc=$?
  set -e
  echo "$out" | sed 's/^/   /'
  if [[ $rc -eq 0 ]]; then
    echo "   PASS: exit 0 on the fixed file"
  else
    echo "   FAIL: exit $rc -- the gate flags the CORRECT code, it would block every unrelated PR"; fail=1
  fi

  # ── Control 2 (positive): FakeFolder.connected -- MR !228 ──────────────────
  echo
  echo "-- POSITIVE control 2: revert FakeFolder's Pick<VaultShare, ...> to the"
  echo "   OLD 'connected' field name (real historical bug: the ProviderBacked"
  echo "   base getter was renamed connected -> isOnline). The gate MUST go red,"
  echo "   naming crdtBackgroundSyncPoller.test.ts."
  cp "$TARGET" "$TARGET.bak2"
  sed -i.tmp 's/Pick<VaultShare, "workspaceId" | "isOnline">/Pick<VaultShare, "workspaceId" | "connected">/' "$TARGET"
  rm -f "$TARGET.tmp"
  if diff -q "$TARGET" "$TARGET.bak2" >/dev/null; then
    echo "   FATAL: sed did not change the file -- probe layout drifted, self-test cannot proceed"; exit 2
  fi
  set +e
  out="$(run_gate "$WORK/probe" 2>&1)"; rc=$?
  set -e
  echo "$out" | sed 's/^/   /'
  if [[ $rc -eq 1 ]] && echo "$out" | grep -q "crdtBackgroundSyncPoller.test.ts"; then
    echo "   PASS: exit 1, naming the file, with the historical connected bug reintroduced"
  else
    echo "   FAIL: exit $rc, or did not name the file -- the gate did not catch a real, previously-shipped bug"; fail=1
  fi
  mv "$TARGET.bak2" "$TARGET"

  echo
  echo "-- NEGATIVE control 2: restore the fixed field. The gate MUST come back green."
  set +e
  out="$(run_gate "$WORK/probe" 2>&1)"; rc=$?
  set -e
  echo "$out" | sed 's/^/   /'
  if [[ $rc -eq 0 ]]; then
    echo "   PASS: exit 0 on the fixed file"
  else
    echo "   FAIL: exit $rc -- the gate flags the CORRECT code, it would block every unrelated PR"; fail=1
  fi

  # ── Control 3 (positive): a file with ZERO pre-existing errors, unrelated to
  # either historical case -- proves this is a general type-checker gate, not
  # one hardcoded to recognize only the two known names ( drew
  # the same distinction for check-svelte-types.py).
  echo
  echo "-- POSITIVE control 3: inject a synthetic, unrelated type error into"
  echo "   __tests__/mocks/MockClock.ts (currently zero tsc errors, no relation"
  echo "   to either historical bug). The gate MUST go red, naming that file."
  cp "$MOCKCLOCK" "$MOCKCLOCK.bak3"
  printf '\nconst __check_tests_types_selftest_probe: number = "not a number";\n' >> "$MOCKCLOCK"
  set +e
  out="$(run_gate "$WORK/probe" 2>&1)"; rc=$?
  set -e
  echo "$out" | sed 's/^/   /'
  if [[ $rc -eq 1 ]] && echo "$out" | grep -q "mocks/MockClock.ts"; then
    echo "   PASS: exit 1, naming a previously-silent file with a novel injected error"
  else
    echo "   FAIL: exit $rc, or did not name the file -- the gate cannot see a genuinely new class of error"; fail=1
  fi
  mv "$MOCKCLOCK.bak3" "$MOCKCLOCK"

  echo
  echo "-- NEGATIVE control 3: restore the file. The gate MUST come back green."
  set +e
  out="$(run_gate "$WORK/probe" 2>&1)"; rc=$?
  set -e
  echo "$out" | sed 's/^/   /'
  if [[ $rc -eq 0 ]]; then
    echo "   PASS: exit 0 on the restored file"
  else
    echo "   FAIL: exit $rc -- the gate flags the CORRECT code, it would block every unrelated PR"; fail=1
  fi

  echo
  if [[ $fail -eq 0 ]]; then echo "SELF-TEST PASS"; exit 0; fi
  echo "SELF-TEST FAIL — do not trust this gate's number until fixed"; exit 2
fi

exec "$PY" "$GATE" ${EXTRA[@]+"${EXTRA[@]}"}
