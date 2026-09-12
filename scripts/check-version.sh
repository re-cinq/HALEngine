#!/usr/bin/env bash
# Fails when a release tag and the committed package.json version disagree.
#
# Usage:
#   bash scripts/check-version.sh v0.2.0   # before pushing the tag
#   bash scripts/check-version.sh          # in CI, reads GITHUB_REF_NAME
#
# A committed script rather than an inline workflow step: a tag that has already
# fired a publish cannot be un-pushed, so the check has to be runnable before the
# tag exists.
#
# It also holds CHANGELOG.md to the version being tagged. check-changelog.sh only
# asks that the file was touched, so the release rename was ungated and the
# version shipped under a heading that never named it.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="${1:-${GITHUB_REF_NAME:-}}"
version="$(node -p "require('$repo/package.json').version")"

if [ -z "$tag" ]; then
  echo "check-version: no tag given and GITHUB_REF_NAME is unset" >&2
  echo "check-version: package.json is at $version, so the tag to push is v$version" >&2
  exit 2
fi

# The workflow's `v*` filter accepts far more than a release tag does.
if ! printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "check-version: FAILED - '$tag' is not a vMAJOR.MINOR.PATCH release tag" >&2
  # Nothing here passes --tag, so a prerelease would publish as `latest` and
  # every plain `npm install` would resolve to it.
  echo "check-version: prerelease tags are rejected because no dist-tag is set" >&2
  exit 1
fi

if [ "$tag" != "v$version" ]; then
  echo "check-version: FAILED - tag '$tag' and package.json '$version' disagree" >&2
  echo "check-version: bump package.json to ${tag#v}, or tag v$version instead" >&2
  exit 1
fi

# Keep a Changelog writes the released version as a `## [x.y.z]` heading, optionally dated.
if ! grep -Eq "^## \\[${version//./\\.}\\]" "$repo/CHANGELOG.md"; then
  echo "check-version: FAILED - CHANGELOG.md has no '## [$version]' heading" >&2
  echo "check-version: rename '## [Unreleased]' to '## [$version]' and open a fresh one above it" >&2
  exit 1
fi

echo "check-version: OK - $tag matches package.json $version, and CHANGELOG.md names it"
