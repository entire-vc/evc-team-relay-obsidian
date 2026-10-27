# Contributing to the Team Relay Sync Obsidian Plugin

Thanks for your interest in contributing! This plugin enables live team editing and sync in Obsidian via EVC Team Relay.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies: `npm install`
4. Create a feature branch: `git checkout -b feature/my-feature`

## Development

```bash
# Development build with watch mode
npm run dev

# Production build
npm run build

# Lint
npm run lint
```

### Testing in Obsidian

1. Build the plugin: `npm run build`
2. Copy `main.js` and `manifest.json` to your vault's `.obsidian/plugins/team-relay-sync/`
3. Enable the plugin in Obsidian Settings > Community Plugins
4. Point it at your local Team Relay instance

## Releases

**`main.js`, `manifest.json` and `styles.css`, and the GitHub Release that carries
them, are produced by the pipeline only.** A manual build is fine for debugging and
sideloading. Publishing one by hand is not.

Releases are batched. A fix, merge or QA retry does not imply a new stable.
Collect the intended fixes on one release card, merge one version change, and freeze
one full candidate SHA. Run acceptance against that SHA and the same recorded artifact
digests on RU and Entire, using both MacBook and Mini. Any candidate change invalidates
the receipt. Missing cells or failed scenarios block publication.

Daedalus authorizes the batch; Ralph publishes it after independent review. The JSON
receipt supplied to `workflow_dispatch` must name the candidate SHA, contain a PASS and
an HTTPS evidence link for each of `ru-macbook`, `ru-mini`, `entire-macbook`, `entire-mini`
in `matrix`, accepted SHA-256 digests for `main.js`, `manifest.json`, `styles.css`
in `artifacts`, and an HTTPS `decision` link to Daedalus's release decision. The decision
and evidence must identify the same SHA and artifact digests. The workflow validates
receipt structure and SHA binding; independent reviewers verify the linked evidence.

The release workflow is dispatch-only: provide `version`, `candidate_sha` (40 hex
characters), and `qa_receipt`. It checks that the accepted commit is on main and that
an existing version tag points to that exact commit. It then builds and attests the
candidate, restores the committed manifest, checks that the built artifact digests equal the accepted digests, and publishes
the assets. A non-reproducible build fails before publication. Tag pushes alone
do not publish. Do not create a stable release to obtain a QA build: use CI build
artifacts/test sideloads, record their digests, and compare the stable artifact digests
after publication. Promoting the stored artifacts directly remains a future improvement.

Critical production security, data-loss/corruption or outage fixes may get their own
urgent hotfix batch with incident, urgency, narrow diff and rollback recorded. This
accelerates scheduling; the candidate, independent review and four-cell gate remain.
Never silently replace stable assets or move a published tag. Re-running an interrupted
publication for an existing version still requires the same accepted SHA and receipt;
`allow_overwrite` is only an explicit recovery operation authorized on that card.

### Why hand-publishing is refused

`npm run build` rewrites `manifest.json`'s version in place from `git describe`
(`esbuild.config.mjs`, `updateManifest`). A hand-published artifact therefore carries
whatever the build stamped rather than the release version, and it skips both the
`tag == manifest.version` check and the provenance attestation. This is not
hypothetical: a published manifest once shipped a raw `git describe` string — a tag, a
commit count and a source-tree hash — in the file Obsidian's catalogue reads.

So: after any local `npm run build`, check `git status --short` and restore the file
before committing.

```bash
git checkout -- manifest.json
```

### The guards that will stop you, and why they stay

Three checks exist specifically to make the failure above loud. If one blocks you,
the answer is to tag properly — not to loosen the check.

- `esbuild.config.mjs` runs `git describe --tags` **without** `--always`. In a git
  repository with no reachable tag it throws. `--always` would turn "no usable tag"
  into a bare hash and hand you a string instead of an error.
- Under `CI_COMMIT_TAG`, a version that is not `^\d+\.\d+\.\d+$` refuses to build.
- CI's `manifest-check` refuses a *committed* manifest whose version is not bare
  semver, and keeps `package.json`, `manifest.json` and
  `versions.json` in agreement. It deliberately runs in its own clone: sharing a
  workspace with `build` would compare against a just-stamped manifest and fail on
  every green build.

## Pull Requests

1. Create a branch from `main`
2. Make your changes
3. Ensure `npm run build` succeeds with no errors
4. Ensure `npm run lint` passes
5. Write a clear PR description explaining what and why
6. Submit the PR

## Reporting Bugs

Use the [Bug Report](https://github.com/entire-vc/evc-team-relay-obsidian/issues/new?template=bug_report.md) issue template.

## Requesting Features

Use the [Feature Request](https://github.com/entire-vc/evc-team-relay-obsidian/issues/new?template=feature_request.md) issue template.

## Code Style

- TypeScript with strict mode
- No React/Svelte - vanilla DOM with Obsidian API
- Follow existing patterns in the codebase
- Keep changes focused and minimal

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
