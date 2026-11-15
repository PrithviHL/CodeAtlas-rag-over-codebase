#!/bin/sh
set -eu
cd "$(dirname "$0")"
atlas_model_pid=""
cleanup() {
  if [ -n "$atlas_model_pid" ]; then kill "$atlas_model_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if ! curl -fsS --max-time 2 http://127.0.0.1:11435/health >/dev/null 2>&1; then
  ./run-model.sh > .runtime/model-server.log 2>&1 &
  atlas_model_pid=$!
  atlas_attempt=0
  until curl -fsS --max-time 2 http://127.0.0.1:11435/health >/dev/null 2>&1; do
    atlas_attempt=$((atlas_attempt + 1))
    if [ "$atlas_attempt" -ge 30 ] || ! kill -0 "$atlas_model_pid" 2>/dev/null; then
      echo "Model failed to start. Check .runtime/model-server.log." >&2
      exit 1
    fi
    sleep 1
  done
fi
./run.sh
