#!/bin/sh
# Version-sync check: package.json, package-lock.json, manifest.json,
# versions.json and CHANGELOG.md must agree on one bare
# semver. Run by the CI workflow before the build step.
#
# This must never run in a workspace that has run `npm run build`:
# `npm run build` rewrites manifest.json's version in place with
# `git describe --tags` (esbuild.config.mjs `updateManifest`), so a check that
# ran after a build in the same directory would compare package.json against a
# git-describe string and fail on every green build. Run it before the build step.
set -eu
PKG_VER=$(node -p "require('./package.json').version")
MFT_VER=$(node -p "require('./manifest.json').version")
MFT_MIN=$(node -p "require('./manifest.json').minAppVersion")
echo "package.json:       $PKG_VER"
echo "manifest.json:      $MFT_VER  (minAppVersion: $MFT_MIN)"
if [ "$PKG_VER" != "$MFT_VER" ]; then
  echo "REFUSING: manifest.json version ($MFT_VER) != package.json version ($PKG_VER)."
  exit 1
fi
# package-lock.json carries its own copy of the version at two JSON
# paths (root "version" and packages[""].version) that `npm version`
# does NOT touch -- it edits package.json only. Nothing else in this
# pipeline reads either path, so a lockfile frozen at some earlier point
# drifts silently forever: this project shipped four releases
# (0.0.1..0.0.4) with the lock still reading a stale version the whole
# time. Fixed once with `npm install
# --package-lock-only`; this check is what keeps the next `npm version`
# bump from re-opening the same gap.
LOCK_ROOT_VER=$(node -p "require('./package-lock.json').version")
LOCK_PKG_VER=$(node -p "require('./package-lock.json').packages[''].version")
echo "package-lock.json:   $LOCK_ROOT_VER / $LOCK_PKG_VER  (root / packages[\"\"])"
if [ "$LOCK_ROOT_VER" != "$PKG_VER" ] || [ "$LOCK_PKG_VER" != "$PKG_VER" ]; then
  echo "REFUSING: package-lock.json version(s) ($LOCK_ROOT_VER / $LOCK_PKG_VER) != package.json version ($PKG_VER)."
  echo "  Run 'npm install --package-lock-only' after bumping package.json."
  exit 1
fi
# Форма версии, а не только согласованность файлов. Равенство выше ловит
# расхождение, но пропускает СОГЛАСОВАННЫЙ мусор: одна и та же кривая строка
# в обоих файлах плюс запись в versions.json проходит все прежние барьеры.
# Реальный случай: сборка вписала в манифест сырой вывод `git describe`
# (тег, число коммитов над ним и хеш) вместо чистого релизного номера —
# и это уехало в публичный первый коммит. Аллоулист, а не денилист по
# суффиксу: голый sha денилист пропустил бы, а это та же грязь в другой форме.
SHAPE_OK=$(node -e 'process.stdout.write(/^\d+\.\d+\.\d+$/.test(process.argv[1])?"1":"0")' "$MFT_VER")
if [ "$SHAPE_OK" != "1" ]; then
  echo "REFUSING: version \"$MFT_VER\" is not a bare semver (X.Y.Z)."
  echo "  A committed manifest must carry a release version, not a build string."
  exit 1
fi
if ! grep -q "\"$MFT_VER\"" versions.json; then
  echo "REFUSING: versions.json has no entry for $MFT_VER."
  exit 1
fi
# A release has shipped with CHANGELOG.md still naming the PREVIOUS
# version three times now (including once for 0.0.2 itself).
# All three were fixed by appending a line after the fact, which repairs
# that one release and leaves the next one free to drift the same way —
# nothing earlier in the chain than a human remembering stops it. This is the fourth
# file in the version-sync set; it belongs in the same job that already
# holds the other three so there is exactly one place "did the version
# bump land everywhere" is answered.
CHG_VER=$(node -e '
  const fs = require("fs");
  const txt = fs.readFileSync("CHANGELOG.md", "utf8");
  const m = txt.match(/^##\s*([^\s#][^\n]*)$/m);
  if (!m) { process.exit(1); }
  process.stdout.write(m[1].trim());
') || { echo "REFUSING: CHANGELOG.md has no top-level '## <version>' entry to read."; exit 1; }
echo "CHANGELOG.md:        $CHG_VER  (top entry)"
if [ "$CHG_VER" != "$MFT_VER" ]; then
  echo "REFUSING: CHANGELOG.md's top entry ($CHG_VER) != manifest.json version ($MFT_VER)."
  echo "  Add a \"## $MFT_VER\" entry describing this release before it ships."
  exit 1
fi
echo "OK: package.json, manifest.json, versions.json, CHANGELOG.md all agree on $PKG_VER ✓"
echo
echo "NOT CHECKED HERE: that $PKG_VER is strictly greater than the latest"
echo "published GitHub release. That guard needs a GitHub token this"
echo "pipeline does not have — see the header of this file."
