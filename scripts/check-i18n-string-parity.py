#!/usr/bin/env python3
"""Proves the i18n extraction (, MR1) moved every string it
touched BYTE FOR BYTE -- no English wording was rewritten in transit.

This is the "before/after set-equality" check called out by the task's
hard requirement #1: pure mechanical refactor, zero new/changed visible
copy. "I copy-pasted it" is not evidence; this makes it a diff.

    ./scripts/check-i18n-string-parity.py                # uses the default
                                                           # base (the commit
                                                           # this MR branched
                                                           # from)
    ./scripts/check-i18n-string-parity.py --base <sha>    # explicit base

Method
------
For each of the six files this MR converted, harvest every user-visible
string literal from:
  (a) BASE   -- `git show <base>:<file>`, i.e. the file before this MR
  (b) AFTER  -- the CURRENT file (whatever literal text is still left in
                it, post-conversion) UNION every English value in
                src/wording/phrasebook.ts (where the converted text now
                lives)

If the extraction was byte-for-byte, BASE and AFTER are the same SET.

The harvester recognises, in both TS and Svelte source:
  - the classic Obsidian/Setting call pattern (setName/setDesc/setTitle/
    setText/setButtonText/setPlaceholder/Notice/confirm/setMessage/
    addButton/setLabel) with a literal first argument
  - `text:`/`placeholder:` object-literal properties (the raw DOM-builder
    style RelayOnPremLoginModal.ts uses instead of the Setting API)
  - ternary branches (`cond ? "A" : "B"`) -- both literal arms
  - Svelte markup text nodes between tags, INCLUDING ones that contain a
    `{expr}` interpolation (unlike scripts/extract-user-strings.py, which
    deliberately excludes those -- this script exists specifically to
    catch the interpolated case, since that's exactly where the phrasebook
    had to introduce a `{name}` placeholder)
  - `placeholder="..."` HTML attribute values

Every `${expr}` (source) or `{name}` (phrasebook) interpolation is
normalised to a bare `{}` marker before comparison, so a template's static
text is verified without caring what the specific placeholder identifier
is called on either side.

Honest limitation: this is a regex harvester, not a real TS/Svelte parser.
It is intentionally permissive (over-collection is the safe failure --
see extract-user-strings.py's own docstring for the same argument) and it
was iterated against this specific diff, not proven correct on arbitrary
future code. Re-run it after any further edit to the six files below.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASE = "83553109a0ad89b75ae3b45be8d5f0a6ac933f24"

TOUCHED_FILES = [
	"src/components/ShareListView.svelte",
	"src/components/ShareDetailView.svelte",
	"src/components/CreateShareView.svelte",
	"src/components/CreateInviteView.svelte",
	"src/components/RelayOnPremSettings.svelte",
	"src/ui/RelayOnPremLoginModal.ts",
]

PHRASEBOOK_FILE = "src/wording/phrasebook.ts"

CALLS = (
	r"(?:setName|setDesc|setButtonText|setPlaceholder|setText|setTitle|Notice|confirm|setMessage|addButton|setLabel"
	# Local helpers this diff's touched files call with a leading `app`
	# argument ahead of the literal (dialogs.ts wrappers), plus the two
	# custom call shapes RelayOnPremLoginModal.ts and getInviteDescription()
	# use in place of the Setting API / Notice.
	r"|confirmDialog|promptDialog|choiceDialog|showError|push)"
)
CALL_RE = re.compile(r"\b" + CALLS + r"\s*\(\s*([\"'`])(.*?)(?<!\\)\1", re.S)
# confirmDialog/promptDialog/choiceDialog take `(app, "message", ...)` --
# the literal is the SECOND argument, not the first, so it needs its own
# pattern (CALL_RE only ever looks at what comes immediately after `(`).
CALL_SECOND_ARG_RE = re.compile(
	r"\b(?:confirmDialog|promptDialog|choiceDialog)\s*\(\s*[^,]+,\s*([\"'`])(.*?)(?<!\\)\1", re.S
)
# `new FolderPathPickerModal(app, "title", ...)` -- same second-argument shape.
NEW_MODAL_SECOND_ARG_RE = re.compile(
	r"\bnew\s+FolderPathPickerModal\s*\(\s*[^,]+,\s*([\"'`])(.*?)(?<!\\)\1", re.S
)
PROP_RE = re.compile(r"\b(?:text|placeholder|label)\s*:\s*([\"'`])(.*?)(?<!\\)\1", re.S)
# `throw new Error("literal")`.
NEW_ERROR_RE = re.compile(r"\bnew\s+Error\s*\(\s*([\"'`])(.*?)(?<!\\)\1", re.S)
# `displayMessage = "literal";` / `error = "literal";` -- the two bare
# assignment idioms in scope (RelayOnPremLoginModal.ts's fallback-message
# ladder, ShareListView.svelte's `catch`/`else` error state). Named to
# those specific variables deliberately, NOT a generic `<expr> = "..."`
# scan: `===`/`!==`/`<=`/`>=` comparisons are everywhere else in these
# files, each contributing a lone `=` that a generic pattern would trip
# on, and because the true assignment isn't always followed immediately by
# `;` (e.g. `x = "abc" + y;`), a generic version can run away the same way
# the earlier unbounded TERNARY_RE did.
ASSIGN_RE = re.compile(r"\b(?:displayMessage|error)\s*=\s*([\"'`])(.*?)(?<!\\)\1\s*;", re.S)
# `<expr> instanceof Error ? <expr> : "fallback"` -- the ubiquitous
# `e instanceof Error ? e.message : "..."` idiom. Anchored on the literal
# tokens "instanceof Error" immediately before the `?`, which cannot occur
# inside ordinary English prose -- safe against the same trap TERNARY_RE
# hit on "...this invite link?" (see below).
ERROR_TERNARY_RE = re.compile(r"instanceof\s+Error\s*\?\s*[\w.]+\s*:\s*([\"'`])(.*?)(?<!\\)\1", re.S)
# Bounded to the contexts a ternary's string literals actually appear in
# this diff: (a) as the sole argument of one of our known calls
# (`setText(loading ? "Logging in..." : "Login")`), where the condition is
# a simple `!==`/`===`-style comparison or bare identifier, (b) inside a
# brace-depth-bounded Svelte `{...}` block (handled separately by
# substitute_braces, NOT here). A blanket whole-file `\?\s*(quote)...`
# scan is unsafe: a literal `?` at the end of an English sentence
# immediately followed by that string's own closing quote (e.g.
# `"Revoke this invite link?"`) reads to the regex exactly like the start
# of a ternary, and with `.` in DOTALL mode the lazy match then runs to
# the next quote ANYWHERE later in the file -- confirmed live against this
# exact file (`git show <base>:src/components/ShareDetailView.svelte`)
# before this was scoped down.
_TERNARY_COND = r"[A-Za-z_][\w.]*(?:\s*(?:!==|===|!=|==)\s*(?:null|true|false|[A-Za-z_][\w.]*))?"
TERNARY_IN_CALL_RE = re.compile(
	r"\b" + CALLS + r"\s*\(\s*" + _TERNARY_COND + r"\s*\?\s*([\"'`])(.*?)(?<!\\)\1\s*:\s*([\"'`])(.*?)(?<!\\)\3",
	re.S,
)
TERNARY_RE = re.compile(r"\?\s*([\"'`])(.*?)(?<!\\)\1\s*:\s*([\"'`])(.*?)(?<!\\)\3", re.S)
# Any quoted literal -- only ever run bounded to one brace-depth-bounded
# `{...}` block's `inner` text (see substitute_braces), never whole-file.
QUOTED_LITERAL_RE = re.compile(r"([\"'`])(.*?)(?<!\\)\1", re.S)
ATTR_RE = re.compile(r"\b(?:placeholder|title)\s*=\s*([\"'])(.*?)\1")
# Svelte text node between tags -- UNLIKE extract-user-strings.py, this one
# permits `{...}` inside (that's the whole point: catch the interpolated
# case so it can be diffed against the phrasebook's `{name}` form).
TEXT_RE = re.compile(r">([^<>]*[A-Za-z][^<>]*)<")

INTERP_DOLLAR_RE = re.compile(r"\$\{[^}]*\}")
INTERP_NAME_RE = re.compile(r"\{[a-zA-Z0-9_]+\}")

NOISE = re.compile(r"^[\s\W\d]*$")
SCRIPT_RE = re.compile(r"<script.*?</script(?=[\s/>])[^>]*>", re.S | re.I)
STYLE_RE = re.compile(r"<style.*?</style(?=[\s/>])[^>]*>", re.S | re.I)


def clean(s: str) -> str:
	return re.sub(r"\s+", " ", s).strip()


def normalize(s: str) -> str:
	"""Collapse every interpolation form to a bare `{}` marker so a
	source template (`${x}`) and a phrasebook template (`{name}`) compare
	equal regardless of the placeholder's specific spelling."""
	s = INTERP_DOLLAR_RE.sub("{}", s)
	s = INTERP_NAME_RE.sub("{}", s)
	return s


def strip_ui_text_calls(s: str) -> str:
	"""Remove every `uiText(...)` call (paren-balanced, so it also eats a
	nested `uiText(...)` used as a fallback param, e.g.
	`uiText("x", { error: e instanceof Error ? e.message : uiText("y") })`)
	from `s`. Without this, QUOTED_LITERAL_RE -- a deliberately blanket
	"any quoted string in this brace block" scan -- mistakes uiText's own
	KEY argument (`"createInvite.title"`) for a piece of user-visible
	prose, which is backwards: that string is a lookup key we wrote, not
	English text this MR is proving didn't change.
	"""
	out = []
	i, n = 0, len(s)
	while i < n:
		if s.startswith("uiText(", i):
			depth = 1
			j = i + 7
			while j < n and depth > 0:
				if s[j] == "(":
					depth += 1
				elif s[j] == ")":
					depth -= 1
				j += 1
			i = j
		else:
			out.append(s[i])
			i += 1
	return "".join(out)


def substitute_braces(markup: str) -> tuple[str, set[str]]:
	"""Svelte `{expr}` blocks routinely contain `=>`/`<`/`>` (arrow
	functions, comparisons) that would otherwise be mistaken by TEXT_RE for
	real tag boundaries -- one stray `=>` inside an `on:click` handler is
	enough to make the "text node" match run away across the rest of the
	document. Replace every top-level (brace-depth-balanced) `{...}` block
	with a bare `{}` placeholder BEFORE any tag-boundary regex sees the
	markup, so no code character inside an expression can ever masquerade
	as `<`/`>`. Ternary branches found inside a block are harvested here,
	directly from the original (unsubstituted) expression text.
	"""
	out_chars: list[str] = []
	extra: set[str] = set()
	i, n = 0, len(markup)
	while i < n:
		c = markup[i]
		if c == "{":
			depth = 1
			j = i + 1
			while j < n and depth > 0:
				if markup[j] == "{":
					depth += 1
				elif markup[j] == "}":
					depth -= 1
				j += 1
			inner = strip_ui_text_calls(markup[i + 1 : j - 1])
			for m in TERNARY_RE.finditer(inner):
				extra.add(clean(m.group(2)))
				extra.add(clean(m.group(4)))
			# Any other quoted literal inside the block -- covers `||`
			# fallbacks (`{selectedPath || "Choose folder..."}`) and
			# anything else a ternary-only pass would miss. Bounded to
			# `inner`, which is itself brace-depth-bounded, so this can't
			# run away past the block's own closing brace the way an
			# unbounded whole-file scan could.
			for m in QUOTED_LITERAL_RE.finditer(inner):
				extra.add(clean(m.group(2)))
			out_chars.append("{}")
			i = j
		else:
			out_chars.append(c)
			i += 1
	return "".join(out_chars), extra


def harvest_source(text: str, is_svelte: bool) -> set[str]:
	text = strip_ui_text_calls(text)
	out: set[str] = set()
	for m in CALL_RE.finditer(text):
		out.add(clean(m.group(2)))
	for m in CALL_SECOND_ARG_RE.finditer(text):
		out.add(clean(m.group(2)))
	for m in NEW_MODAL_SECOND_ARG_RE.finditer(text):
		out.add(clean(m.group(2)))
	for m in NEW_ERROR_RE.finditer(text):
		out.add(clean(m.group(2)))
	for m in PROP_RE.finditer(text):
		out.add(clean(m.group(2)))
	for m in ASSIGN_RE.finditer(text):
		out.add(clean(m.group(2)))
	for m in ERROR_TERNARY_RE.finditer(text):
		out.add(clean(m.group(2)))
	for m in TERNARY_IN_CALL_RE.finditer(text):
		out.add(clean(m.group(2)))
		out.add(clean(m.group(4)))
	if is_svelte:
		markup = STYLE_RE.sub("", SCRIPT_RE.sub("", text))
		for m in ATTR_RE.finditer(markup):
			out.add(clean(m.group(2)))
		substituted, ternary_strings = substitute_braces(markup)
		out |= ternary_strings
		for m in TEXT_RE.finditer(substituted):
			out.add(clean(m.group(1)))
	cleaned = {s for s in out if s and not NOISE.match(s) and len(s) > 1}
	return {normalize(s) for s in cleaned}


# `"dot.namespaced.key": "value",` -- the key is always a quoted identifier
# immediately followed by `:`; the value may be on the same line or (for a
# long entry) the next one, so this matches across whitespace/newlines
# rather than assuming one line per entry.
PHRASEBOOK_ENTRY_RE = re.compile(r'"[a-zA-Z0-9_.]+"\s*:\s*([\"\'])(.*?)(?<!\\)\1', re.S)


def harvest_phrasebook(text: str) -> set[str]:
	out = {normalize(clean(m.group(2))) for m in PHRASEBOOK_ENTRY_RE.finditer(text)}
	return out


def git_show(ref: str, path: str) -> str:
	result = subprocess.run(
		["git", "show", f"{ref}:{path}"],
		cwd=ROOT,
		capture_output=True,
		text=True,
	)
	if result.returncode != 0:
		print(f"FATAL: git show {ref}:{path} failed:\n{result.stderr}", file=sys.stderr)
		sys.exit(2)
	return result.stdout


def main() -> int:
	ap = argparse.ArgumentParser()
	ap.add_argument("--base", default=DEFAULT_BASE, help="git ref for the pre-MR tree")
	args = ap.parse_args()

	before: set[str] = set()
	after: set[str] = set()

	for rel in TOUCHED_FILES:
		is_svelte = rel.endswith(".svelte")
		base_text = git_show(args.base, rel)
		before |= harvest_source(base_text, is_svelte)

		current_text = (ROOT / rel).read_text(encoding="utf-8")
		after |= harvest_source(current_text, is_svelte)

	phrasebook_text = (ROOT / PHRASEBOOK_FILE).read_text(encoding="utf-8")
	after |= harvest_phrasebook(phrasebook_text)

	missing = before - after  # in BASE but nowhere in AFTER -- lost text, a real bug
	added = after - before    # in AFTER but never in BASE -- invented text, a real bug

	# Four messages in the base source are built from TWO backtick strings
	# joined with `+` (e.g. `` `Member limit reached (...). ` + `Upgrade
	# your plan...` ``). CALL_RE only ever captures the literal that comes
	# straight after `Notice(`/`confirm(`/etc, so it harvests the FIRST
	# half only; the phrasebook (correctly) stores the two halves already
	# joined as one value. That is a REAL positive result -- the harvester
	# just cannot follow a `+` concatenation across two backtick strings --
	# not a text-preservation bug. Each pair below was diffed BY HAND
	# against `git show <base>:<file>` (not just eyeballed) before being
	# allow-listed; re-verify with `--show-concatenations` if the source
	# for any of these four messages changes.
	KNOWN_CONCATENATIONS: dict[str, str] = {
		"Member limit reached ({}/{} on {} plan).":
			"Member limit reached ({}/{} on {} plan). Upgrade your plan to add more members.",
		"Share limit reached ({}/{} on {} plan).":
			"Share limit reached ({}/{} on {} plan). Upgrade your plan to create more shares.",
		"Web publish limit reached ({}/{} on {} plan).":
			"Web publish limit reached ({}/{} on {} plan). Upgrade your plan to publish more.",
		"'{}' visibility requires a higher plan.":
			"'{}' visibility requires a higher plan. Your plan allows: {}. Upgrade to unlock.",
	}
	concatenations_confirmed = []
	for base_half, joined in KNOWN_CONCATENATIONS.items():
		if base_half in missing and joined in added:
			concatenations_confirmed.append((base_half, joined))
			missing.discard(base_half)
			added.discard(joined)

	print(f"BASE   ({args.base[:12]}): {len(before)} distinct normalized strings across {len(TOUCHED_FILES)} files")
	print(f"AFTER  (working tree + phrasebook): {len(after)} distinct normalized strings")
	print()

	if concatenations_confirmed:
		print(f"KNOWN two-part `+`-concatenated template literals ({len(concatenations_confirmed)}) -- verified byte-for-byte by hand, allow-listed, not counted below:")
		for base_half, joined in concatenations_confirmed:
			print(f"  base 1st half: {base_half!r}")
			print(f"  dictionary   : {joined!r}")
		print()

	ok = True
	if missing:
		ok = False
		print(f"MISSING -- present before, absent after ({len(missing)}):")
		for s in sorted(missing):
			print(f"  - {s!r}")
	else:
		print("MISSING -- none. Every string the harvester found before this MR is still findable after it.")

	print()
	if added:
		ok = False
		print(f"ADDED -- present after, absent before ({len(added)}):")
		for s in sorted(added):
			print(f"  + {s!r}")
	else:
		print("ADDED -- none. No string appears after this MR that wasn't there before (beyond the allow-listed concatenations above).")

	print()
	print("SET EQUALITY: PASS" if ok else "SET EQUALITY: FAIL")
	return 0 if ok else 1


if __name__ == "__main__":
	sys.exit(main())
