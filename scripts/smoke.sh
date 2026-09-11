#!/usr/bin/env bash
# Packs the package, installs the tarball into a temp directory OUTSIDE this
# repository, and runs smoke/ against it.
#
# Usage:
#   bash scripts/smoke.sh
#
# Outside the tree on purpose: installed inside it, Node and tsc walk up to this
# repo's own node_modules and every missing dependency resolves anyway, so the
# check passes on a package that would fail for a real consumer. No optional peer
# is installed either - a bare `npm install` of this package installs neither,
# which is exactly the state a consumer of the mock provider is in.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/hal-engine-smoke.XXXXXX")"
trap 'rm -rf "$work"' EXIT

echo "smoke: packing $repo"
tarball="$(cd "$repo" && npm pack --silent --pack-destination "$work")"
echo "smoke: packed $tarball"

cp "$repo"/smoke/package.json "$repo"/smoke/index.mjs "$repo"/smoke/types.ts "$repo"/smoke/tsconfig.json "$work"/

cd "$work"
# One install: npm prunes packages absent from package.json on a later --no-save
# run, which silently removes the subject and turns the type check into a
# "cannot find module" false negative.
echo "smoke: installing tarball + typescript into $work"
npm install --silent --save "./$tarball" typescript@"$(node -p "require('$repo/package.json').devDependencies.typescript")" >/dev/null

for peer in @google-cloud/vertexai @aws-sdk/client-bedrock-runtime; do
  if [ -d "node_modules/$peer" ]; then
    echo "smoke: FAILED - optional peer $peer was installed; it must not be" >&2
    exit 1
  fi
done
echo "smoke: neither optional peer installed, as expected"

echo "smoke: running runtime check"
node index.mjs

echo "smoke: type-checking against the published .d.ts"
npx --no-install tsc -p tsconfig.json
echo "smoke: types OK"

echo "smoke: PASSED"
