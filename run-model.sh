#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .runtime/ollama/llama-server ] || [ ! -f .runtime/model.gguf ]; then
  echo "Local model runtime is missing. See README.md for model configuration." >&2
  exit 1
fi
exec .runtime/ollama/llama-server --model .runtime/model.gguf --alias qwen2.5-coder:1.5b --host 127.0.0.1 --port 11435 --ctx-size 8192 --parallel 1 --device none --n-gpu-layers 0 --no-op-offload --fit off --no-webui --offline --threads 6
