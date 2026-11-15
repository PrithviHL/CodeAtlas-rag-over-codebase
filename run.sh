#!/bin/sh
set -eu
cd "$(dirname "$0")/code/ts"
if command -v node >/dev/null 2>&1; then
  atlas_node="$(command -v node)"
else
  atlas_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [ ! -x "$atlas_node" ]; then
  echo "Install Node.js 22+ and run npm run setup from the project root." >&2
  exit 1
fi
if [ ! -f node_modules/tsx/dist/cli.mjs ]; then
  echo "Dependencies are missing. Run npm run setup from the project root." >&2
  exit 1
fi
exec "$atlas_node" node_modules/tsx/dist/cli.mjs src/app.ts
