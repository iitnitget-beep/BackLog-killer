#!/usr/bin/env bash
# Runs the CLI. Uses esbuild to bundle first, because Node's type-stripping
# requires explicit .js extensions in imports which the source does not carry.
set -euo pipefail
cd "$(dirname "$0")/.."
BUNDLE=".cli/cli.mjs"
mkdir -p .cli
npx esbuild scripts/cli.ts --bundle --platform=node --format=esm \
  --external:node:* --outfile="$BUNDLE" --log-level=error
exec node "$BUNDLE" "$@"
