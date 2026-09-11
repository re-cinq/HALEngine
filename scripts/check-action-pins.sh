#!/usr/bin/env bash
# Fails when a `uses:` reference in .github/workflows/ is not pinned to a full
# 40-hex commit SHA. A tag is a mutable pointer its owner can repoint, and these
# workflows run with repository credentials - after the release workflow lands,
# one of them holds id-token: write and signs what it publishes.
#
# Usage:
#   bash scripts/check-action-pins.sh
#
# Local `./` and `docker://` references are not pinnable this way and are skipped.
set -uo pipefail

workflows_dir="${1:-.github/workflows}"
findings=0

while IFS= read -r line; do
  file="${line%%:*}"
  rest="${line#*:}"
  lineno="${rest%%:*}"
  ref="$(printf '%s' "$rest" | sed -E 's/^[0-9]+:[[:space:]]*-?[[:space:]]*uses:[[:space:]]*//; s/[[:space:]]*(#.*)?$//')"

  case "$ref" in
    ./*|docker://*) continue ;;
  esac

  sha="${ref##*@}"
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'check-action-pins: %s:%s pins "%s" — expected a 40-hex commit SHA\n' "$file" "$lineno" "$ref" >&2
    findings=$((findings + 1))
  fi
done < <(grep -rn -E '^[[:space:]]*-?[[:space:]]*uses:' "$workflows_dir" 2>/dev/null || true)

if [[ "$findings" -gt 0 ]]; then
  printf '\ncheck-action-pins: %d unpinned reference(s).\n' "$findings" >&2
  printf 'Pin with: gh api repos/<owner>/<repo>/commits/<tag> --jq .sha\n' >&2
  printf 'and keep the tag in a trailing comment, e.g. `uses: actions/checkout@<sha> # v4.2.2`\n' >&2
  exit 1
fi

printf 'check-action-pins: every uses: reference is SHA-pinned.\n'
