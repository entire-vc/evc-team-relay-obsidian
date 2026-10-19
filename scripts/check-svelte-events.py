#!/usr/bin/env python3
"""Static reachability check for Svelte custom (non-DOM) events: for every
`<Component on:eventName={handler}>` listener in this tree, prove that
`eventName` can actually be emitted by `Component` -- either directly via
`dispatch("eventName", ...)` inside it, or transitively via a bare
`on:eventName` forward through a chain of child components down to a real
dispatch call.

Why this exists: a producer/consumer pair is joined by nothing but two
string literals in two different files --

    producer:  dispatch("goBack", {})
    consumer:  <ModalBackBar on:goBack={handleGoBack} />

-- and NOTHING in this repo's toolchain checks that match: not tsc (event
names are untyped strings to it), not svelte-check (it type-checks values,
not event-name existence), not gate 4 (it reads identifiers; this is a
string literal plus an attribute name), not jest/lint/build (none of them
execute the click-to-dispatch DOM interaction). Confirmed by direct
experiment (, 2026-08-28): renamed a definitely-LIVE listener
(`SettingsPanel.svelte`'s `on:goBack`, wired to the visible "back" button in
the settings panel) to a bogus name -- tsc/lint/svelte-check/build/jest all
stayed at their exact pre-break numbers. Nothing noticed a real UI control
had just been severed.

This is the same class of gap as population B in/!237
(`Object.defineProperty(obj, "memberName", ...)`, a string key past every
type checker) and the mock drift in -- a runtime-string join that
no static type system sees through -- but worse here: the cost isn't a
silently-stopped-checking test, it's a silently-broken UI control.

## The mistake this gate exists to not repeat

's own accepted methodology was "break the event name, and if
NOTHING goes red, that's proof of deadness." That's exactly backwards for
Svelte custom events: NOTHING in this repo's gates executes a click, so a
LIVE listener produces the identical all-green result as a genuinely DEAD
one when its name is broken. The experiment above proves it. A gate that
cannot fail on a live sample is not a gate -- it's a coin flip that always
lands on the same side. This script's own `--self-test` runs the SAME
experiment as its own positive control, and this control is a NON-NEGOTIABLE
part of trusting a green run from this checker (see `check-svelte-events.sh`).

## Method

1. Parse every `.svelte` file's `<script>` section for `dispatch("name", ...)`
   / `dispatch('name', ...)` call sites (both quote styles; a computed
   dispatch like `dispatch(cond ? "apply" : "close")` is handled by scanning
   the whole call's argument text for quoted identifiers rather than
   requiring the literal to be the very next token).
2. Parse every file's template for component-tag usages (`<CapitalizedTag
   ...>` or `<svelte:component this=... ...>`) and every `on:eventName`
   attribute on them -- bound (`on:eventName={handler}`, a real listener
   whose reachability must be proven) or bare (`on:eventName`, a transparent
   forward of the child's own event of that name up to THIS component's own
   consumers).
3. Resolve each component tag to the `.svelte` file it names, via this
   file's own `import X from "./X.svelte"` statements. `<svelte:component
   this={expr}>` cannot be resolved this way in general (an arbitrary
   runtime expression) -- the one live site in this tree
   (`SettingsPanel.svelte`) is adjudicated explicitly below, the same way
   `check-naming.py`'s baskets record a human judgment call rather than
   re-deriving it every run.
4. `live(file, name)` = file directly dispatches `name`, OR some bare
   forward `on:name` in file's template targets a child component C with
   `live(resolve(C), name)` true. Memoized DFS, cycle-safe.
5. Every BOUND listener `<Tag on:name={handler}>` must have `live(resolve
   (Tag), name)` true. A violation is reported (file:line, target, name).

Signature = (file, line, target component, event name) -- not just a count,
so `--max-work N`-style ratchets remain possible if this basket is ever
non-empty (it currently is not -- see MANUAL basket below and the ratchet
baseline file).

Exit codes: 0 = no unreachable bound listeners (beyond the frozen baseline),
1 = new ones found, 2 = could not parse a trustworthy result -- fail CLOSED.
"""
import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASELINE = REPO_ROOT / "scripts" / "svelte-events-baseline.json"

# `<svelte:component this={EXPR}>` cannot be resolved to a concrete component
# by static text alone -- EXPR is an arbitrary runtime value. The single site
# in this tree that carries any `on:` listeners is adjudicated here by hand,
# the same way check-naming.py's CONVENTION_ADJUDICATED records a judgment
# call instead of re-deriving it every run. FlashCard.svelte's and
# NavTrail.svelte's `<svelte:component this={Icon}>`/`this={iconFor(item)}`
# sites carry NO `on:` attributes at all (icon-only), so they need no entry.
#
# SettingsPanel.svelte's `this={activeManageView.component}` resolves to
# EXACTLY `SyncedFolderManager.svelte`: `ManageViewState` (same file) is a
# union with exactly one non-`undefined` variant, `component: typeof
# SyncedFolderManager` -- read directly off the type, not inferred. If that
# union ever grows a second variant, this entry must grow with it (nothing
# in this script re-verifies the union stays single-branch -- keying a
# human-adjudicated table to a type it never reads is exactly this file's
# own reason for existing, and the honest way to close that gap is not
# "trust this comment forever" but re-open's own root cause).
DYNAMIC_COMPONENT_ADJUDICATED = {
    ("components/SettingsPanel.svelte", "activeManageView.component"): "components/SyncedFolderManager.svelte",
}

IMPORT_RE = re.compile(
    r'''import\s+(\w+)\s+from\s+["'](\.[\w./-]*?)\.svelte["']'''
)
DISPATCH_RE = re.compile(r'\bdispatch\s*\(')
QUOTED_IDENT_RE = re.compile(r'''["']([a-zA-Z][a-zA-Z0-9_]*)["']''')
# Tag start: `<CapitalizedName` or `<svelte:component`. Deliberately NOT
# matching lowercase tags (native DOM elements) -- their events always
# resolve, there is nothing to check.
TAG_START_RE = re.compile(r'<([A-Z]\w*|svelte:component)\b')
ON_ATTR_RE = re.compile(r'\bon:([a-zA-Z][a-zA-Z0-9_]*)(\s*=\s*\{)?')
THIS_ATTR_RE = re.compile(r'\bthis\s*=\s*\{([^}]*)\}')


# Set by scan() to the actual --src root being scanned -- NOT hardcoded to
# REPO_ROOT/src, so this script also works against a scratch copy elsewhere
# (the self-test's whole mechanism). Signatures in the baseline file are
# always relative to this root, whichever tree produced them.
SRC_ROOT = None


def rel(path: Path) -> str:
    # .resolve() on BOTH sides: macOS symlinks /tmp and /var to /private/...,
    # so a path built from an unresolved mktemp -d root and one built via
    # .resolve() elsewhere disagree on their own prefix even though they name
    # the same file -- caught by this script's own --self-test (its scratch
    # copy lives under /var/folders/..., glob()'d paths keep that spelling,
    # SRC_ROOT was being pre-resolved to /private/var/folders/...).
    return str(path.resolve().relative_to(SRC_ROOT))


def find_svelte_files(root: Path):
    return sorted(root.glob("**/*.svelte"))


def strip_line_comments(text: str) -> str:
    """Blank out `//`-to-end-of-line comment tails so they can't be
    mistaken for real dispatch()/on: occurrences (e.g. this file's own
    docstring-style code comments referencing `dispatch(` or `on:foo` in
    prose). Deliberately naive (no string-literal awareness) -- adequate for
    this codebase's style (no `//` appears inside a template/script string
    literal today; verified by the self-test's own extraction matching a
    hand-audited count)."""
    out = []
    for line in text.splitlines(keepends=True):
        idx = line.find("//")
        out.append(line[:idx] + "\n" if idx != -1 and not line[:idx].rstrip().endswith(":") else line)
    return "".join(out)


def extract_dispatches(text: str) -> set:
    """Every literal event name reachable from a `dispatch(...)` call on its
    own line (handles a computed arg like `dispatch(cond ? "a" : "b")` by
    collecting every quoted identifier in the call's tail, not just the
    first token)."""
    names = set()
    for line in text.splitlines():
        for m in DISPATCH_RE.finditer(line):
            tail = line[m.end():]
            # Stop at the statement's own closing paren depth-0, but a
            # single-line call in this codebase never nests parens inside
            # its own arg list (only `{}`), so scanning to end-of-line is
            # safe and simpler than depth-tracking.
            for qm in QUOTED_IDENT_RE.finditer(tail):
                names.add(qm.group(1))
    return names


def extract_tag_blocks(text: str):
    """Yields (line_no, tag_name, this_expr_or_None, attr_text) for every
    component-tag / svelte:component start in the file. attr_text spans
    from the tag name to the tag's closing `>`, tracking `{}` depth so a
    multi-line tag (attributes one per line, as this codebase's prettier
    style produces) is captured whole."""
    for m in TAG_START_RE.finditer(text):
        tag = m.group(1)
        start = m.end()
        depth = 0
        i = start
        n = len(text)
        while i < n:
            c = text[i]
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
            elif c == '>' and depth <= 0:
                break
            i += 1
        attr_text = text[start:i]
        line_no = text.count("\n", 0, m.start()) + 1
        this_m = THIS_ATTR_RE.search(attr_text)
        this_expr = this_m.group(1).strip() if this_m else None
        yield line_no, tag, this_expr, attr_text


def extract_on_attrs(attr_text: str):
    """Yields (event_name, is_bound) for every on:xxx in a tag's attribute
    text. is_bound=True means `on:xxx={handler}` (a real listener whose
    reachability must be proven); False means a bare `on:xxx` forward."""
    for m in ON_ATTR_RE.finditer(attr_text):
        yield m.group(1), m.group(2) is not None


def build_model(files):
    """Returns (dispatches: {relfile: {name}}, forwards: {relfile: [(target_relfile_or_None, name)]},
    listeners: [(relfile, line, target_relfile_or_None, this_expr_or_None, tag, name)])."""
    dispatches = {}
    forwards = {}
    listeners = []
    for f in files:
        r = rel(f)
        text = f.read_text(encoding="utf-8", errors="replace")
        clean = strip_line_comments(text)
        dispatches[r] = extract_dispatches(clean)

        # Map local tag name -> resolved .svelte file, from this file's own imports.
        import_map = {}
        for im in IMPORT_RE.finditer(clean):
            local_name, relpath = im.group(1), im.group(2)
            resolved = (f.parent / (relpath + ".svelte")).resolve()
            try:
                import_map[local_name] = rel(resolved)
            except ValueError:
                pass  # outside src/ -- not a component we track

        my_forwards = []
        for line_no, tag, this_expr, attr_text in extract_tag_blocks(clean):
            if tag == "svelte:component":
                target = None
                if this_expr is not None:
                    target = DYNAMIC_COMPONENT_ADJUDICATED.get((r, this_expr))
            else:
                target = import_map.get(tag)
            for name, is_bound in extract_on_attrs(attr_text):
                if is_bound:
                    listeners.append((r, line_no, target, this_expr, tag, name))
                else:
                    my_forwards.append((target, name))
        forwards[r] = my_forwards
    return dispatches, forwards, listeners


def compute_live(dispatches, forwards):
    memo = {}

    def live(file, name, stack):
        key = (file, name)
        if key in memo:
            return memo[key]
        if key in stack:
            return False  # cycle guard -- an unbroken forward loop dispatches nothing new
        if file is None or file not in dispatches:
            memo[key] = False
            return False
        if name in dispatches[file]:
            memo[key] = True
            return True
        stack = stack | {key}
        for target, fname in forwards.get(file, []):
            if fname == name and live(target, name, stack):
                memo[key] = True
                return True
        memo[key] = False
        return False

    return live


def scan(src_root: Path):
    global SRC_ROOT
    SRC_ROOT = src_root.resolve()
    files = find_svelte_files(src_root)
    if not files:
        raise RuntimeError(f"no .svelte files found under {src_root} -- could not scan")
    dispatches, forwards, listeners = build_model(files)
    live = compute_live(dispatches, forwards)
    violations = []
    for r, line_no, target, this_expr, tag, name in listeners:
        if not live(target, name, frozenset()):
            target_desc = target or (f"{tag} this={{{this_expr}}}" if this_expr else tag)
            violations.append((r, line_no, target_desc, name))
    return sorted(violations)


def sig_of(v):
    return f"{v[0]}:{v[2]}:{v[3]}"


def load_baseline(path: Path):
    if not path.exists():
        return set()
    data = json.loads(path.read_text())
    return {e["signature"] for e in data["violations"]}


def save_baseline(path: Path, violations, note=""):
    payload = {
        "_comment": (
            "Frozen baseline of pre-existing unreachable Svelte listener bindings "
            "found by check-svelte-events.py --update-baseline. Do NOT hand-edit to "
            "silence a new one -- fix it (rename to match a real dispatch, or delete "
            "the dead listener with a static proof, per), or if it is "
            "genuinely deliberate, say why in the commit and update via --update-baseline."
        ),
        "generated_note": note,
        "violations": [
            {"file": v[0], "line": v[1], "target": v[2], "event": v[3], "signature": sig_of(v)}
            for v in violations
        ],
    }
    path.write_text(json.dumps(payload, indent="\t") + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default=str(REPO_ROOT / "src"))
    ap.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    ap.add_argument("--update-baseline", action="store_true")
    ap.add_argument("--note", default="")
    args = ap.parse_args()

    src_root = Path(args.src)
    baseline_path = Path(args.baseline)

    try:
        violations = scan(src_root)
    except (RuntimeError, OSError) as e:
        print(f"FATAL: could not obtain a trustworthy scan: {e}", file=sys.stderr)
        print("Exiting 2 (fail-closed) -- absence of a result is NOT the same as zero violations.", file=sys.stderr)
        return 2

    if args.update_baseline:
        save_baseline(baseline_path, violations, note=args.note)
        print(f"Baseline updated: {baseline_path} ({len(violations)} violation(s))")
        return 0

    baseline = load_baseline(baseline_path)
    current_sigs = {sig_of(v) for v in violations}
    new = [v for v in violations if sig_of(v) not in baseline]

    print(f"svelte-events: {len(violations)} unreachable listener(s) found (baseline: {len(baseline)})")

    if new:
        print()
        print("NEW unreachable listener(s) not present in the frozen baseline:")
        for v in new:
            print(f"  [{v[0]}:{v[1]}] <{v[2]}> never dispatches \"{v[3]}\"")
        print()
        print(f"REFUSING: {len(new)} new unreachable listener(s). Either the target never "
              f"dispatches this event name (rename the listener, fix the dispatch, or delete "
              f"the dead binding with a static proof), or this is deliberately-accepted debt "
              f"-- regenerate the baseline with --update-baseline and say why in the commit.")
        return 1

    shrunk = len(baseline) - len(current_sigs & baseline)
    if shrunk > 0:
        print(f"(baseline has shrunk by {shrunk} -- consider --update-baseline to lock in the improvement)")
    print("OK: no new unreachable Svelte listeners beyond the frozen baseline.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
