#!/usr/bin/env python3
"""Type-check .svelte <script> (and template expression) blocks via svelte-check,
ratcheted against a frozen baseline of pre-existing errors.

Why this exists: tsconfig.json's `include` is TS-only (**/*.ts), and jest never
transforms .svelte files, so nothing in this repo's gates ever type-checked a
.svelte file. A class member renamed across the TS surface (e.g. by the gate-4
naming waves) can go stale in a .svelte consumer -- script block OR template
expression -- with zero red from tsc/jest/lint/build/check-naming.sh. Two real
runtime regressions of exactly this shape shipped past 4 rounds of independent
review before a manual sweep caught them (NavTrail.svelte, FolderPathAutocomplete
.svelte -- see). A third (EditorStatusActions.svelte, W15) was
caught by a similar manual sweep the same day, including a case embedded in
template markup rather than a <script> block (`data-filename={liveView.view...}`).

Why a ratchet, not a bare "zero errors" gate: a full `svelte-check` run across
this codebase surfaces 37 pre-existing type errors (measured 2026-08-28) that
predate this task and are out of its scope to fix -- unrelated bugs (missing
generic type arguments, mismatched literal-union types, a stale import,
duplicate `<script context="module">` declarations parsed incorrectly, etc.)
scattered across 18 files. Gating on zero would either block CI on unrelated
debt indefinitely, or invite disabling the whole gate at the first false-start
-- both worse than the blind spot this closes. Same shape as
`scripts/check-naming.sh --max-work N`: freeze what's already there, fail only
on anything NEW. The baseline shrinks over time as that debt gets fixed
elsewhere; it must never be edited to silence a genuinely new error.

CLOSED GAP: EditorStatusActions.svelte used to declare
`export let liveView: DocumentViewBinding;` with a MISSING generic type
argument (DocumentViewBinding<ViewType extends TextFileView> has no default
-- src/ViewBindings.ts:475). That made TypeScript give up on `liveView`'s type
before it ever reached property access, SILENCING property-mismatch errors on
every member read off `liveView` in that one file -- verified directly: with
the three W15 renames (.tracking/.toggleConnection/.view ->
.isTracking/.toggleConnectionIntent/.hostView) reverted to their stale
pre-rename names, svelte-check reported the SAME single generic-arg error and
nothing about the reverted properties.

The one-line fix this comment used to propose (`DocumentViewBinding
<TextFileView>`, "confirmed sufficient in a scratch copy") does NOT actually
work: `ViewActionsMount.render()` (src/ViewBindings.ts) is the single mount
point for BOTH `DocumentViewBinding<ViewType>` and `CanvasViewBinding` --
its `target` param passes `liveView` a value of the common `ViewBinding`
base type, and narrowing the Svelte prop to `DocumentViewBinding<TextFileView>`
makes the canvas call site (`this._actions.render(this.hostView.containerEl,
this, this.canvasDocument)`, CanvasViewBinding) a genuine structural-typing
error -- `CanvasViewBinding` is missing 20+ `DocumentViewBinding`-only members.
Confirmed by actually trying it, not by re-deriving from the scratch-copy
claim above (which never accounted for the canvas call site at all).

Actually closed by a narrower interface, `TrackedViewBinding extends
ViewBinding` (src/ViewBindings.ts), declaring only the two members
`EditorStatusActions.svelte` reads that AREN'T already on `ViewBinding`
(`isTracking`, `toggleConnectionIntent`) -- both `DocumentViewBinding` and
`CanvasViewBinding` already declare these independently, so both satisfy it
structurally with no `implements` needed and no narrowing of `render()`'s
canvas call site. `render()`'s `target` param and the Svelte prop both
retyped to `TrackedViewBinding`. Fixing this ALSO surfaced a second, real,
previously-masked bug in the same props object literal: `linked` was typed
as non-optional `RemoteFolderRecord` while `doc.sharedFolder.linked` is
genuinely `RemoteFolderRecord | undefined` (VaultShare.ts's `_linked` field);
the template already guarded reads with `{#if linked}`, only the prop's own
type declaration was wrong -- widened to `RemoteFolderRecord | undefined`.

Signature = (file, error message) -- deliberately NOT (file, line, col). Line
numbers shift on any unrelated edit above the error in the same file; keying on
them would make the gate flap on every nearby diff. Keying on the message text
means a *reworded* error can look "new" even if nothing about its underlying
cause changed -- an accepted false-positive-toward-caution tradeoff, same one
check-naming.sh's frozen name-lists already make.

Usage:
    check-svelte-types.py                          # compare against baseline, exit 0/1/2
    check-svelte-types.py --update-baseline         # regenerate the baseline file
    check-svelte-types.py --tsconfig PATH           # override tsconfig (self-test uses this)
    check-svelte-types.py --cwd PATH                # run svelte-check from a different directory

Exit codes: 0 = no new errors (baseline holds or has shrunk), 1 = new/regressed
errors found, 2 = could not run or parse svelte-check output -- fail CLOSED,
never silently "clean" on a probe that could not look.
"""
import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASELINE = REPO_ROOT / "scripts" / "svelte-check-baseline.json"
DEFAULT_TSCONFIG = "tsconfig.svelte-check.json"

# Matches one machine-output diagnostic line, e.g.:
#   1787875179922 ERROR "src/components/Foo.svelte" 7:23 "Some message.\nMore."
# The message itself may contain escaped quotes/backslashes/newlines (it is a
# JS-string-literal-style escape, not JSON) -- captured verbatim, unescaped
# only for readability in reports, never re-escaped differently than svelte-check
# emits it, so the same real error always yields the same signature run to run.
LINE_RE = re.compile(
    r'^\d+\s+(ERROR|WARNING)\s+"((?:[^"\\]|\\.)*)"\s+(\d+):(\d+)\s+"((?:[^"\\]|\\.)*)"\s*$'
)


def unescape(s: str) -> str:
    return s.replace('\\"', '"').replace("\\\\", "\\").replace("\\n", "\n")


def run_svelte_check(cwd: Path, tsconfig: str) -> str:
    proc = subprocess.run(
        ["npx", "svelte-check", "--tsconfig", tsconfig, "--output", "machine", "--threshold", "error"],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=300,
    )
    # svelte-check's own exit code is not the signal we gate on (it exits
    # non-zero on ANY error, including the 37 pre-existing ones) -- but a
    # completely empty stdout (crash before writing anything, wrong cwd, npx
    # failing to resolve the binary) means we could not check at all, and that
    # must fail closed rather than be read as "zero errors".
    if not proc.stdout.strip():
        print("FATAL: svelte-check produced no output at all.", file=sys.stderr)
        print("--- stderr ---", file=sys.stderr)
        print(proc.stderr, file=sys.stderr)
        raise RuntimeError("svelte-check produced no output")
    return proc.stdout


def parse_errors(output: str) -> Counter:
    """Returns Counter[(file, message)] for ERROR-severity diagnostics only.

    Warnings (a11y hints etc.) are intentionally excluded from the gate -- this
    check's job is type-safety (the class of bug in scope: a rename or any
    other type error going unseen in a .svelte file), not linting.
    """
    sig = Counter()
    saw_completed = False
    for line in output.splitlines():
        line = line.strip()
        m = LINE_RE.match(line)
        if m:
            severity, file, _line, _col, msg = m.groups()
            if severity == "ERROR":
                sig[(file, unescape(msg))] += 1
        elif "COMPLETED" in line:
            saw_completed = True
    if not saw_completed:
        # svelte-check always prints a COMPLETED summary line on a normal run.
        # Its absence means the run was truncated/killed/errored before
        # finishing -- a partial diagnostic list must not be trusted as complete.
        raise RuntimeError(
            "svelte-check output has no COMPLETED line -- the run did not finish; "
            "refusing to trust a partial error list"
        )
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
            "Frozen baseline of pre-existing svelte-check ERROR diagnostics, "
            "generated by `scripts/check-svelte-types.py --update-baseline`. "
            "Do NOT hand-edit to silence a new error -- fix the error, or if it "
            "is genuinely unrelated pre-existing debt being consciously "
            "deferred, regenerate via --update-baseline and say why in the "
            "commit message. New entries here with no accompanying source fix "
            "defeat the entire point of this gate."
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
        output = run_svelte_check(cwd, args.tsconfig)
        current = parse_errors(output)
    except (RuntimeError, subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        print(f"FATAL: could not obtain a trustworthy svelte-check result: {e}", file=sys.stderr)
        print("Exiting 2 (fail-closed) -- absence of a result is NOT the same as zero errors.", file=sys.stderr)
        return 2

    if args.update_baseline:
        save_baseline(baseline_path, current, note=args.note)
        print(f"Baseline updated: {baseline_path} ({sum(current.values())} errors across {len(current)} signatures)")
        return 0

    baseline = load_baseline(baseline_path)
    new = diff_new(baseline, current)

    print(f"svelte-check: {sum(current.values())} error(s) across {len(current)} signature(s) "
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
              f"(e.g. a stale reference to a renamed class member in a .svelte file), fix the source. "
              f"If it is deliberately-accepted pre-existing debt being surfaced for the first time, "
              f"regenerate the baseline with --update-baseline and say why in the commit.")
        return 1

    shrunk = sum(baseline.values()) - sum(current.values())
    if shrunk > 0:
        print(f"(baseline has shrunk by {shrunk} -- consider running --update-baseline to lock in the improvement)")
    print("OK: no new svelte-check errors beyond the frozen baseline.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
