#!/usr/bin/env bash
# Fails when a diff touches src/ and leaves CHANGELOG.md alone.
#
# Usage:
#   bash scripts/check-changelog.sh [base-ref]     # default: origin/main
#
# The rule is about what a consumer can observe, not about effort: anything that
# changes shipped behaviour needs a sentence they can read on npm. A change to
# src/ that genuinely is not user-visible - an internal refactor, a test-only
# edit - takes the `no-changelog` label instead, which is a deliberate, visible
# act rather than a silent omission.
set -uo pipefail

base="${1:-origin/main}"

# A base ref that does not resolve means nothing was compared. On a laptop that
# is ordinary - a fresh clone has no origin/main - and skipping is right. In CI
# it is the gate passing without running, which is the one outcome a gate must
# never have, and it is exactly how a fetch that failed went unnoticed.
if ! git rev-parse --verify --quiet "$base" >/dev/null; then
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "check-changelog: FAILED - base ref '$base' does not resolve, so nothing was checked" >&2
    exit 1
  fi
  echo "check-changelog: base ref '$base' not found; skipping" >&2
  exit 0
fi

merge_base="$(git merge-base "$base" HEAD)"
changed="$(git diff --name-only "$merge_base"..HEAD)"

src_changed="$(printf '%s\n' "$changed" | grep -E '^src/' | grep -vE '\.test\.ts$' || true)"

if [ -z "$src_changed" ]; then
  echo "check-changelog: no shipped source changed since ${base}."
  exit 0
fi

if printf '%s\n' "$changed" | grep -qx 'CHANGELOG.md'; then
  echo "check-changelog: src/ changed and CHANGELOG.md was updated."
  exit 0
fi

{
  echo "check-changelog: these files under src/ changed since ${base} and CHANGELOG.md did not:"
  printf '%s\n' "$src_changed" | sed 's/^/  /'
  echo
  echo "Add an entry under ## [Unreleased], written for somebody installing the package."
  echo "If the change genuinely is not user-visible, apply the 'no-changelog' label to the pull request."
} >&2
exit 1
