# Contributing to EVC Team Relay Obsidian Plugin

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
2. Copy `main.js` and `manifest.json` to your vault's `.obsidian/plugins/evc-team-relay/`
3. Enable the plugin in Obsidian Settings > Community Plugins
4. Point it at your local Team Relay instance

## Releases

**`main.js`, `manifest.json` and `styles.css`, and the GitHub Release that carries
them, are produced by the pipeline only.** A manual build is fine for debugging and
sideloading. Publishing one by hand is not.

To release: bump `manifest.json`'s `version` on `main` (normal PR/merge), then dispatch
the release workflow with that version — **no tag-push rights needed**:

```bash
gh workflow run release.yml --repo entire-vc/evc-team-relay-obsidian -f version=1.2.3
```

CI verifies `1.2.3` matches the committed `manifest.json` on `main`, creates+pushes the
`1.2.3` tag itself (as the CI identity), then builds and releases in the same run. If the
tag already exists — e.g. re-running attestation, or `-f allow_overwrite=true` to
deliberately republish — CI builds that existing tag instead of cutting a new one.

Tagging by hand still works the same way it always did (and still triggers the same
pipeline), it's just no longer the only path:

```bash
git tag 1.2.3          # bare — a 'v' prefix will NOT trigger the workflow
git push origin 1.2.3
```

`.github/workflows/release.yml` then builds the tagged tree, restores the committed
`manifest.json`, verifies the tag equals `manifest.version`, attests build provenance
for `main.js`/`styles.css`, and creates the release with the three assets. The tag is
the version — there is no step where a human types the version anywhere else.

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
