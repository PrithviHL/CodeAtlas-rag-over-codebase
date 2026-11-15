"""Run the API, one indexing worker and web UI locally; no cloud resources."""

from __future__ import annotations
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / ".runtime/local-engine"


def environment():
    DATA.mkdir(parents=True, exist_ok=True)
    secret_file = DATA / "env.json"
    if secret_file.exists():
        values = json.loads(secret_file.read_text())
    else:
        values = {
            key: secrets.token_urlsafe(48)
            for key in ("ENGINE_API_KEY", "GITHUB_WEBHOOK_SECRET")
        }
        secret_file.write_text(json.dumps(values))
        secret_file.chmod(0o600)
    # Only load the small documented secret/settings file, never execute shell text.
    source = ROOT / "engine/.env"
    if source.exists():
        for line in source.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                if key.strip() in {
                    "GROQ_API_KEY",
                    "LLM_API_KEY",
                    "CHAT_MODEL",
                    "CHAT_PROVIDER",
                }:
                    values[key.strip()] = value.strip().strip('"').strip("'")
    catalog = DATA / "catalog.json"
    if not catalog.exists():
        catalog.write_text((ROOT / "engine/config/repos.example.json").read_text())
    values.update(
        ENGINE_DATA=str(DATA),
        REPOS_MANIFEST=str(catalog),
        QDRANT_URL="http://127.0.0.1:6434",
        HF_HOME=str(ROOT / ".runtime/huggingface"),
        OMP_NUM_THREADS="4",
        TOKENIZERS_PARALLELISM="false",
    )
    for key, value in values.items():
        os.environ.setdefault(key, value)
    return dict(os.environ)


def main():
    env = environment()
    from codeatlas_engine.runtime import settings, search_components
    from codeatlas_engine.indexing import Indexer
    from codeatlas_engine.service import create_app
    from codeatlas_engine.worker import process
    import torch
    import uvicorn

    torch.set_num_threads(4)
    root, catalog = settings()
    store, search, chat = search_components(root)
    indexer = Indexer(store, search.embedder, search.vectors)
    store.recover()
    stop = threading.Event()

    def work():
        while not stop.wait(1):
            job = store.claim()
            if job:
                try:
                    process(store, indexer, root, catalog[job["repo"]], job)
                except Exception as error:
                    store.finish(job["id"], error=type(error).__name__)

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    node = shutil.which("node") or str(
        Path.home()
        / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
    )
    web_env = dict(
        env,
        HOST="127.0.0.1",
        PORT="3100",
        PUBLIC_DEMO="false",
        DATA_DIR=str(ROOT / ".runtime/local-web"),
        LLM_MODEL="",
        ENGINE_URL="http://127.0.0.1:8100",
    )
    child = subprocess.Popen(
        [node, "code/ts/node_modules/tsx/dist/cli.mjs", "code/ts/src/app.ts"],
        cwd=ROOT,
        env=web_env,
    )
    print("Local CodeAtlas: http://localhost:3100/fleet", flush=True)
    print(
        "Private engine API: http://127.0.0.1:8100; Qdrant: http://127.0.0.1:6434",
        flush=True,
    )
    try:
        uvicorn.run(
            create_app(store, search, chat, catalog), host="127.0.0.1", port=8100
        )
    finally:
        stop.set()
        child.terminate()
        child.wait(timeout=10)
        thread.join(timeout=10)


if __name__ == "__main__":
    main()
