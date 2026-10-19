#!/usr/bin/env python3
"""Type-check __tests__/ via `tsc -p tsconfig.tests.json`, ratcheted against a
frozen baseline of pre-existing errors.

Why this exists: tsconfig.json's `include` is `**/*.ts` but its `exclude`
drops `__tests__` entirely, and ts-jest runs with `isolatedModules: true`
(per-file transpile, no type-checking) -- so nothing in this repo's gates
ever type-checked a file under __tests__. A hand-rolled mock that declares
its OWN shape instead of referencing the real production type can drift
after a rename with ZERO signal from tsc/jest/lint/build, because the mock's
interface is self-consistent on its own terms; only an assertion that
happens to read the now-stale field turns it into a *test* failure, and even
then only by accident. Confirmed twice in one evening in the same file
(__tests__/crdtBackgroundSyncPoller.test.ts):

  - FakeFolder.connected -> isOnline (MR !228): the real VaultShare/
    ProviderBacked field was renamed; the mock's own `connected: boolean`
    field was left behind, every mock folder read `isOnline` as `undefined`
    (falsy) in the real _poll() code, and 8 assertions failed for a reason
    that had nothing to do with what they were testing.
  - FakeFile.guid -> entityGuid (MR !235, closing): same
    shape, one field later. Reverting `entityGuid` to `guid` was proven
    (verifier's own subsitution) to make 2 tests silently stop checking
    what they claimed to check, rather than fail loudly.

Fix applied alongside this gate (not by this gate -- see
__tests__/crdtBackgroundSyncPoller.test.ts): `FakeFile`/`FakeFolder` now
`extends Pick<Document, ...>` / `Pick<VaultShare, ...>` for the specific
fields the real production code under test actually reads off them
(`isOnline`, `entityGuid`, `workspaceId`), instead of declaring those fields
freehand. That convention is what gives a *rename* teeth: renaming
`Document.entityGuid` breaks the `Pick<Document, "entityGuid">` reference
itself, at the mock's own declaration, independent of whatever this gate
does. This gate is the OTHER half -- without it, `__tests__` is still
outside tsc's reach and that broken `Pick<>` reference would never be
compiled in the first place. Fields that are the mock's own bookkeeping (not
a mirror of a real field the production code reads through this mock, e.g.
FakeFile.path/`__isDocument`) are deliberately NOT forced through `Pick<>` --
there is nothing in production to pin them to.

Why a ratchet, not a bare "zero errors" gate: a full `tsc -p
tsconfig.tests.json` run surfaces 209 pre-existing errors (measured
2026-08-28) across 17 files that predate this task and are out of its scope
to fix -- missing `import type` under verbatimModuleSyntax, `Response`/mock
type mismatches, wrong argument counts against an already-changed real
signature, etc. Gating on zero would either block CI on unrelated debt
indefinitely, or invite disabling the whole gate at the first false start --
both worse than the blind spot this closes. Same shape as
`scripts/check-naming.sh --max-work N` and
`scripts/check-svelte-types.py`'s own svelte-check baseline. The baseline
shrinks over time as that debt gets fixed elsewhere; it must never be edited
to silence a genuinely new error.

Signature = (file, code, message) -- deliberately NOT (file, line, col).
Line numbers shift on any unrelated edit above the error in the same file;
keying on them would make the gate flap on every nearby diff. The error
CODE is included (unlike check-svelte-types.py's (file, message) alone)
because tsc's own messages are short and generic enough ("Expected 0
arguments, but got 1.") to collide across genuinely different bugs in the
same file more often than svelte-check's longer prose does; the code adds a
cheap extra dimension of precision at no cost.

Usage:
    check-tests-types.py                          # compare against baseline, exit 0/1/2
    check-tests-types.py --update-baseline         # regenerate the baseline file
    check-tests-types.py --tsconfig PATH           # override tsconfig (self-test uses this)
    check-tests-types.py --cwd PATH                # run tsc from a different directory

Exit codes: 0 = no new errors (baseline holds or has shrunk), 1 = new/
regressed errors found, 2 = could not run or parse a trustworthy tsc result
-- fail CLOSED, never silently "clean" on a probe that could not look.
"""
import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASELINE = REPO_ROOT / "scripts" / "tests-typecheck-baseline.json"
DEFAULT_TSCONFIG = "tsconfig.tests.json"

# Matches one tsc plain-text diagnostic header line, e.g.:
#   __tests__/AgentKeysClient.test.ts(32,25): error TS2352: Conversion of ...
# Any line that does NOT match is either a continuation of the previous
# diagnostic's message (tsc wraps multi-line explanations with no per-line
# file/code prefix) or blank. `--pretty false` is passed explicitly so this
# format is stable regardless of whether stdout is a TTY.
DIAG_RE = re.compile(r'^(\S.*?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$')


def run_tsc(cwd: Path, tsconfig: str) -> tuple[str, int]:
    proc = subprocess.run(
        ["npx", "tsc", "-p", tsconfig, "--noEmit", "--pretty", "false"],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=300,
    )
    return proc.stdout, proc.returncode


def parse_errors(output: str) -> Counter:
    """Returns Counter[(file, "CODE: message")] for error-severity diagnostics.

    Warnings are excluded (tsc --noEmit does not normally emit any under this
    repo's config, but the parser handles them defensively the same way
    check-svelte-types.py handles a11y hints: recognized, then dropped).
    """
    sig: Counter = Counter()
    current_key = None
    current_extra: list[str] = []

    def flush():
        nonlocal current_key, current_extra
        if current_key is not None:
            file, code, first = current_key
            msg = f"{code}: {first}"
            if current_extra:
                msg += "\n" + "\n".join(current_extra)
            sig[(file, msg)] += 1
        current_key = None
        current_extra = []

    for line in output.splitlines():
        m = DIAG_RE.match(line)
        if m:
            flush()
            file, _line, _col, severity, code, msg = m.groups()
            current_key = (file, code, msg) if severity == "error" else None
        elif line.strip() == "":
            flush()
        elif current_key is not None:
            current_extra.append(line)
        # else: stray line with no open diagnostic (e.g. a config-error line
        # in an unrecognized shape) -- dropped, not attributed to anything.
    flush()
    return sig


def load_baseline(path: Path) -> Counter:
    if not path.exists():
        return Counter()
    data = json.loads(path.read_text())
    return Counter({(e["file"], e["message"]): e["count"] for e in data["errors"]})


def save_baseline(path: Path, sig: Counter, note: str = "") -> None:
    errors = [
        {"file": f, "message": m, "count": c}
        for (f, m), c in sorted(sig.items())
    ]
    payload = {
        "_comment": (
            "Frozen baseline of pre-existing `tsc -p tsconfig.tests.json` "
            "ERROR diagnostics, generated by "
            "`scripts/check-tests-types.py --update-baseline`. Do NOT "
            "hand-edit to silence a new error -- fix the error, or if it is "
            "genuinely unrelated pre-existing debt being consciously "
            "deferred, regenerate via --update-baseline and say why in the "
            "commit message. New entries here with no accompanying source "
            "fix defeat the entire point of this gate."
        ),
        "generated_note": note,
        "total_errors": sum(sig.values()),
        "errors": errors,
    }
    path.write_text(json.dumps(payload, indent="\t") + "\n")


def diff_new(baseline: Counter, current: Counter):
    """Returns list of (file, message, baseline_count, current_count) for every
    signature whose count in `current` exceeds its count in `baseline`
    (includes brand-new signatures, where baseline_count is 0)."""
    new = []
    for key, count in current.items():
        base_count = baseline.get(key, 0)
        if count > base_count:
            new.append((key[0], key[1], base_count, count))
    return sorted(new)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tsconfig", default=DEFAULT_TSCONFIG)
    ap.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    ap.add_argument("--cwd", default=str(REPO_ROOT))
    ap.add_argument("--update-baseline", action="store_true")
    ap.add_argument("--note", default="")
    args = ap.parse_args()

    cwd = Path(args.cwd)
    baseline_path = Path(args.baseline)

    try:
        output, returncode = run_tsc(cwd, args.tsconfig)
        current = parse_errors(output)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        print(f"FATAL: could not run tsc at all: {e}", file=sys.stderr)
        print("Exiting 2 (fail-closed) -- absence of a result is NOT the same as zero errors.", file=sys.stderr)
        return 2

    # tsc prints nothing at all on a clean run and exits 0 -- there is no
    # "COMPLETED" footer to check (unlike svelte-check's machine output).
    # The fail-closed signal here is the combination: a non-zero exit with
    # NOTHING parsed means either a config-level error (unrecognized tsc
    # output shape) or a crash -- never trust that as "zero errors".
    if returncode != 0 and not current:
        print("FATAL: tsc exited non-zero but produced no parseable diagnostics.", file=sys.stderr)
        print("--- raw output ---", file=sys.stderr)
        print(output, file=sys.stderr)
        print("Exiting 2 (fail-closed) -- could not obtain a trustworthy result.", file=sys.stderr)
        return 2

    if args.update_baseline:
        save_baseline(baseline_path, current, note=args.note)
        print(f"Baseline updated: {baseline_path} ({sum(current.values())} errors across {len(current)} signatures)")
        return 0

    baseline = load_baseline(baseline_path)
    new = diff_new(baseline, current)

    print(f"tsc (tests): {sum(current.values())} error(s) across {len(current)} signature(s) "
          f"(baseline: {sum(baseline.values())} across {len(baseline)})")

    if new:
        print()
        print("NEW or REGRESSED errors not present in the frozen baseline:")
        for file, msg, base_c, cur_c in new:
            print(f"  [{file}] (seen {base_c} -> {cur_c}x)")
            for l in msg.splitlines():
                print(f"      {l}")
        print()
        print(f"REFUSING: {len(new)} new error signature(s). If this is a genuine new type error "
              f"(e.g. a stale reference to a renamed class member in a __tests__ mock), fix the "
              f"source. If it is deliberately-accepted pre-existing debt being surfaced for the "
              f"first time, regenerate the baseline with --update-baseline and say why in the commit.")
        return 1

    shrunk = sum(baseline.values()) - sum(current.values())
    if shrunk > 0:
        print(f"(baseline has shrunk by {shrunk} -- consider running --update-baseline to lock in the improvement)")
    print("OK: no new tsc errors beyond the frozen baseline.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
