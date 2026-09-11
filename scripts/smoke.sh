#!/usr/bin/env bash
# Packs the package, installs the tarball into a temp directory OUTSIDE this
# repository, and runs smoke/ against it.
#
# Usage:
#   bash scripts/smoke.sh            # both variants
#   bash scripts/smoke.sh bare       # no optional peer installed
#   bash scripts/smoke.sh full       # both optional peers installed
#
# Outside the tree on purpose: installed inside it, Node and tsc walk up to this
# repo's own node_modules and every missing dependency resolves anyway, so the
# check passes on a package that would fail for a real consumer.
#
# Two variants because a consumer is in one of two states, and they fail
# differently: `bare` is a mock-provider consumer, where an absent peer must fail
# at construction with a named error; `full` is a Bedrock or Vertex consumer,
# where the SDK must actually load.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
variant="${1:-all}"
typescript_version="$(node -p "require('$repo/package.json').devDependencies.typescript")"

case "$variant" in
  bare | full | all) ;;
  *)
    echo "usage: smoke.sh [bare|full|all]" >&2
    exit 2
    ;;
esac

pack() {
  local into="$1"
  cd "$repo" && npm pack --silent --pack-destination "$into"
}

# A consumer directory inside the repository would resolve this repo's node_modules by walking up,
# which is the one thing this check exists to rule out.
assert_outside_repo() {
  local dir="$1"
  case "$(cd "$dir" && pwd -P)/" in
    "$(cd "$repo" && pwd -P)"/*)
      echo "smoke: FAILED - consumer directory $dir is inside $repo" >&2
      exit 1
      ;;
  esac
}

# The process must end on its own. A smoke test that needs killing is hiding a leaked handle from
# every consumer, and the engine's own heartbeat timer was once exactly that.
run_and_require_exit() {
  local entry="$1"
  local limit=15
  node "$entry" &
  local pid=$!
  local waited=0

  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      echo "smoke: FAILED - $entry did not exit within ${limit}s; something is holding the event loop open" >&2
      kill -9 "$pid" 2>/dev/null || true
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  wait "$pid"
}

run_variant() {
  local name="$1"
  local work
  work="$(mktemp -d "${TMPDIR:-/tmp}/hal-engine-smoke-$name.XXXXXX")"
  trap 'rm -rf "$work"' RETURN
  assert_outside_repo "$work"

  echo "smoke [$name]: packing $repo"
  local tarball
  tarball="$(pack "$work")"
  echo "smoke [$name]: packed $tarball"

  cp "$repo"/smoke/package.json "$repo"/smoke/index.mjs "$repo"/smoke/full.mjs "$repo"/smoke/types.ts \
    "$repo"/smoke/tsconfig.json "$repo"/smoke/tsconfig.bundler.json "$work"/
  cd "$work"

  # One install: npm prunes packages absent from package.json on a later --no-save run, which
  # silently removes the subject and turns the type check into a "cannot find module" false negative.
  local peers=()
  if [ "$name" = "full" ]; then
    peers=(
      "@google-cloud/vertexai@$(node -p "require('$repo/package.json').peerDependencies['@google-cloud/vertexai']")"
      "@aws-sdk/client-bedrock-runtime@$(node -p "require('$repo/package.json').peerDependencies['@aws-sdk/client-bedrock-runtime']")"
    )
  fi

  echo "smoke [$name]: installing tarball + typescript${peers:+ + optional peers} into $work"
  npm install --silent --save "./$tarball" "typescript@$typescript_version" "${peers[@]}" >/dev/null

  for peer in @google-cloud/vertexai @aws-sdk/client-bedrock-runtime; do
    if [ -d "node_modules/$peer" ] && [ "$name" = "bare" ]; then
      echo "smoke [$name]: FAILED - optional peer $peer was installed; it must not be" >&2
      exit 1
    fi
    if [ ! -d "node_modules/$peer" ] && [ "$name" = "full" ]; then
      echo "smoke [$name]: FAILED - optional peer $peer is absent; this variant installs both" >&2
      exit 1
    fi
  done

  if [ "$name" = "bare" ]; then
    echo "smoke [$name]: neither optional peer installed, as expected"
    echo "smoke [$name]: running runtime check"
    run_and_require_exit index.mjs

    # NodeNext reads exports.types through the node condition; bundler is what a Next.js consumer
    # uses and resolves differently. A package can satisfy one and not the other.
    for config in tsconfig.json tsconfig.bundler.json; do
      echo "smoke [$name]: type-checking against the published .d.ts ($config)"
      npx --no-install tsc -p "$config"
    done
    echo "smoke [$name]: types OK under both resolution modes"
  else
    echo "smoke [$name]: both optional peers installed, as expected"
    echo "smoke [$name]: running runtime check"
    run_and_require_exit full.mjs
  fi

  echo "smoke [$name]: PASSED"
}

if [ "$variant" = "all" ]; then
  run_variant bare
  run_variant full
else
  run_variant "$variant"
fi

echo "smoke: PASSED"
