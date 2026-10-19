#!/usr/bin/env bash
# Wires scripts/check-svelte-events.py into CI (job `svelte-events` in
# CI) the same way the other check scripts are wired in.
# scripts/check-tests-types.sh wire their own gates: a thin bash wrapper
# providing argument handling and a `--self-test` that proves the underlying
# check can actually go red on a LIVE sample, not just that it runs.
#
#   ./scripts/check-svelte-events.sh                  # gate: exit 0/1/2, see .py docstring
#   ./scripts/check-svelte-events.sh --update-baseline
#   ./scripts/check-svelte-events.sh --self-test      # controls; run before trusting it
#
# Background:. A Svelte producer/consumer event pair is
# joined by nothing but two string literals in two different files
# (`dispatch("name", ...)` / `on:name={handler}`), and nothing in this
# repo's gates checks that match -- confirmed by renaming a definitely-LIVE
# listener (SettingsPanel.svelte's `on:goBack`, wired to the panel's own
# visible "back" button) to a bogus name and finding tsc/svelte-check/lint/
# build/jest all unchanged. See check-svelte-events.py's docstring for the
# full mechanism and for the mistake ('s own "nothing reddened =
# proof of dead" methodology, which cannot distinguish live from dead
# because NOTHING here executes a click) that this gate exists to not
# repeat.
#
# THREE controls, not two, and specifically NOT skippable: this gate's own
# origin story is a false negative control (a positive control that could
# never fail), so a self-test lacking a genuine live-sample positive control
# is exactly the failure mode being guarded against.
#   1. POSITIVE on a well-known LIVE pair (ModalBackBar -> SettingsPanel's
#      `on:goBack`) -- break it, must go red, naming the file.
#   2. NEGATIVE -- restore, must go green.
#   3. POSITIVE on a DIFFERENT, previously-uninvolved live pair
#      (RelayOnPremServerList's `serversChanged` -> RelayOnPremSettings) --
#      break it, must go red. Proves this isn't hardcoded to recognize only
#      the one case it was built to catch (same "previously silent file"
#      distinction and drew for their own gates).
#   4. NEGATIVE -- restore, must go green, baseline count back to the frozen
#      value (0 as of this card).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PYTHON:-python3}"
GATE="$REPO_ROOT/scripts/check-svelte-events.py"
BASELINE="$REPO_ROOT/scripts/svelte-events-baseline.json"
SELFTEST=0
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --self-test) SELFTEST=1; shift ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

run_gate() {
  "$PY" "$GATE" --src "$1" --baseline "$BASELINE"
}

if [[ "$SELFTEST" == "1" ]]; then
  fail=0
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  echo "== copying src/ into a scratch workspace =="
  cp -R "$REPO_ROOT/src" "$WORK/src"
  MBB="$WORK/src/components/ModalBackBar.svelte"
  ROPSL="$WORK/src/components/RelayOnPremServerList.svelte"

  echo
  echo "-- POSITIVE control 1: break ModalBackBar's dispatch(\"goBack\") --"
  echo "   the panel's own visible back button. The gate MUST go red, naming"
  echo "   the consumer that can no longer reach it."
  cp "$MBB" "$MBB.bak"
  sed -i.tmp 's/dispatch("goBack"/dispatch("goBackBOGUS"/' "$MBB"
  rm -f "$MBB.tmp"
  if diff -q "$MBB" "$MBB.bak" >/dev/null; then
    echo "   FATAL: sed did not change the file -- probe layout drifted, self-test cannot proceed"; exit 2
  fi
  set +e
  out="$(run_gate "$WORK/src" 2>&1)"; rc=$?
  set -e
  echo "$out" | sed 's/^/   /'
  if [[ $rc -eq 1 ]] && echo "$out" | grep -q '"goBack"'; then
    echo "   PASS: exit 1, naming a broken LIVE listener"
  else
    echo "   FAIL: exit $rc, or did not name it -- the gate cannot distinguish live from dead"; fail=1
  fi
  mv "$MBB.bak" "$MBB"

  echo
  echo "-- NEGATIVE control 1: restore. The gate MUST come back green. --"
  set +e
  out="$(run_gate "$WORK/src" 2>&1)"; rc=$?
  set -e
  echo "$out" | sed 's/^/   /'
  if [[ $rc -eq 0 ]]; then
    echo "   PASS: exit 0 on the fixed file"
  else
    echo "   FAIL: exit $rc -- the gate flags CORRECT code, it would block every unrelated PR"; fail=1
  fi

  echo
  echo "-- POSITIVE control 2: break RelayOnPremServerList's dispatch(\"serversChanged\")"
  echo "   -- a live pair unrelated to control 1's file. The gate MUST go red."
  cp "$ROPSL" "$ROPSL.bak"
  sed -i.tmp 's/dispatch("serversChanged")/dispatch("serversChangedBOGUS")/g' "$ROPSL"
  rm -f "$ROPSL.tmp"
  if diff -q "$ROPSL" "$ROPSL.bak" >/dev/null; then
    echo "   FATAL: sed did not change the file -- probe layout drifted, self-test cannot proceed"; exit 2
  fi
  set +e
  out="$(run_gate "$WORK/src" 2>&1)"; rc=$?
  set -e
  echo "$out" | sed 's/^/   /'
  if [[ $rc -eq 1 ]] && echo "$out" | grep -q '"serversChanged"'; then
    echo "   PASS: exit 1, naming a second, independent broken LIVE listener"
  else
    echo "   FAIL: exit $rc, or did not name it -- the gate only recognizes its one built-for case"; fail=1
  fi
  mv "$ROPSL.bak" "$ROPSL"

  echo
  echo "-- NEGATIVE control 2: restore. The gate MUST come back green, matching"
  echo "   the frozen baseline exactly. --"
  set +e
  out="$(run_gate "$WORK/src" 2>&1)"; rc=$?
  set -e
  echo "$out" | sed 's/^/   /'
  if [[ $rc -eq 0 ]]; then
    echo "   PASS: exit 0 on the fixed tree"
  else
    echo "   FAIL: exit $rc -- the gate flags CORRECT code"; fail=1
  fi

  echo
  if [[ $fail -eq 0 ]]; then echo "SELF-TEST PASS"; exit 0; fi
  echo "SELF-TEST FAIL — do not trust this gate's number until fixed"; exit 2
fi

exec "$PY" "$GATE" --src "$REPO_ROOT/src" --baseline "$BASELINE" ${EXTRA[@]+"${EXTRA[@]}"}
