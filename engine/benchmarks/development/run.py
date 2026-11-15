"""Development-only pilot: resets CodeAtlas metadata to a historical revision before updating. Run from the repository root; results are not held-out or fleet-scale."""

from pathlib import Path
import hashlib, hmac, json, os, secrets, subprocess, time, threading, platform

root = Path.cwd()
data = root / ".runtime/local-engine"
data.mkdir(parents=True, exist_ok=True)
settings = data / "env.json"
if settings.exists():
    env = json.loads(settings.read_text())
else:
    env = {
        "ENGINE_API_KEY": secrets.token_urlsafe(48),
        "GITHUB_WEBHOOK_SECRET": secrets.token_urlsafe(48),
    }
    settings.write_text(json.dumps(env))
    settings.chmod(0o600)
env.update(
    ENGINE_DATA=str(data),
    QDRANT_URL="http://127.0.0.1:6434",
    HF_HOME=str(root / ".runtime/huggingface"),
    CHAT_PROVIDER="groq",
    CHAT_MODEL="openai/gpt-oss-20b",
    OMP_NUM_THREADS="4",
    TOKENIZERS_PARALLELISM="false",
)
os.environ.update(env)
from tree_sitter_language_pack import configure, PackConfig

configure(PackConfig(cache_dir=str(data / "grammars")))
from codeatlas_engine.runtime import components
from codeatlas_engine.providers import CrossEncoderReranker, Chat
from codeatlas_engine.indexing import GitSnapshot, Indexer
from codeatlas_engine.search import Search
from codeatlas_engine.evaluation import evaluate
from codeatlas_engine.service import create_app
from codeatlas_engine.worker import process
from fastapi.testclient import TestClient
import torch

torch.set_num_threads(4)
report_dir = root / "engine/benchmarks/development/results"
report_dir.mkdir(parents=True, exist_ok=True)
RAG = "PrithviHL/rag-over-codebase"
BUS = (
    "PrithviHL/LeaveNow-Real-Time-Bus-Location-Tracking-and-Smart-Departure-Prediction"
)
branches = {RAG: "feature/render-public-app", BUS: "feature/streamlit-containers"}
old = "a3280a67966908de973ceeeb69bd013e707d8376"
rag_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
bus_commit = subprocess.check_output(
    ["git", "-C", str(root.parent / "leavenow"), "rev-parse", "HEAD"], text=True
).strip()
store, embedding, vectors = components(data)
reranker = CrossEncoderReranker()
search = Search(store, embedding, vectors, reranker)
indexer = Indexer(store, embedding, vectors)
reports = []
for repo, commit in [(RAG, old), (BUS, bus_commit)]:
    print("Indexing", repo, commit, flush=True)
    started = time.perf_counter()
    snap = GitSnapshot(
        data / "mirrors", {"repo": repo, "branch": branches[repo], "commit": commit}
    )
    report = indexer.update(repo, snap)
    report["fetch_and_index_seconds"] = time.perf_counter() - started
    reports.append(report)
    print(json.dumps(report), flush=True)
catalog = {r: {"repo": r, "branch": b, "commit": None} for r, b in branches.items()}
app = create_app(store, search, Chat(), catalog)
headers = {"Authorization": "Bearer " + env["ENGINE_API_KEY"]}
with TestClient(app) as client:
    raw = json.dumps(
        {
            "repository": {"full_name": RAG},
            "ref": "refs/heads/" + branches[RAG],
            "after": rag_commit,
        }
    ).encode()
    delivery = "local-pilot-" + secrets.token_hex(8)
    signature = (
        "sha256="
        + hmac.new(
            env["GITHUB_WEBHOOK_SECRET"].encode(), raw, hashlib.sha256
        ).hexdigest()
    )
    started = time.perf_counter()
    response = client.post(
        "/webhooks/github",
        content=raw,
        headers={
            "x-hub-signature-256": signature,
            "x-github-event": "push",
            "x-github-delivery": delivery,
        },
    )
    response.raise_for_status()
    job = store.claim()
    assert job and job["id"] == response.json()["job_id"]
    update = process(store, indexer, data, catalog[RAG], job)
    result = client.post(
        "/search",
        headers=headers,
        json={
            "question": "How does incremental indexing avoid generating the same embedding again?",
            "repos": [RAG],
        },
    ).json()
    assert any(
        h["path"] == "engine/codeatlas_engine/indexing.py" and h["commit"] == rag_commit
        for h in result["results"]
    ), result
    update["local_webhook_to_verified_search_seconds"] = time.perf_counter() - started
    update["measurement_scope"] = (
        "Signed FastAPI TestClient delivery -> durable job -> real Git fetch -> index -> real-model search. Not an actual GitHub push, not a network-hosted API, not a 2M-LOC fleet."
    )
    print("Incremental update:", json.dumps(update), flush=True)
    (report_dir / "incremental.json").write_text(json.dumps(update, indent=2) + "\n")
# Resolve annotations against exact indexed source text; never change them based on ranks.
snapshots = {
    RAG: GitSnapshot(
        data / "mirrors", {"repo": RAG, "branch": branches[RAG], "commit": rag_commit}
    ),
    BUS: GitSnapshot(
        data / "mirrors", {"repo": BUS, "branch": branches[BUS], "commit": bus_commit}
    ),
}
blobs = {r: s.files() for r, s in snapshots.items()}
rows = []
for item in json.loads(
    (root / "engine/benchmarks/development/pilot_queries.json").read_text()
):
    repo = RAG if item["repo"] == "atlas" else BUS
    source = snapshots[repo].read(item["path"], blobs[repo][item["path"]])
    lines = source.splitlines()
    matching = [i + 1 for i, line in enumerate(lines) if item["needle"] in line]
    assert len(matching) == 1, (item["id"], item["needle"], matching)
    start = matching[0]
    rows.append(
        {
            "id": item["id"],
            "question": item["question"],
            "repos": [RAG, BUS],
            "commits": {RAG: rag_commit, BUS: bus_commit},
            "relevant": [
                {
                    "repo": repo,
                    "path": item["path"],
                    "start_line": max(1, start - 2),
                    "end_line": min(len(lines), start + 3),
                }
            ],
        }
    )
dataset = report_dir / "judgments.jsonl"
dataset.write_text("".join(json.dumps(r) + "\n" for r in rows))
print("Evaluating", len(rows), "development queries", flush=True)
report = evaluate(search, store, dataset, report_dir / "retrieval.json")
report["benchmark_type"] = (
    "Agent-authored development pilot; not independently labeled, not held-out, not a production-quality MRR estimate."
)
report["hardware"] = {
    "platform": platform.platform(),
    "machine": platform.machine(),
    "logical_cpus": os.cpu_count(),
    "torch_threads": torch.get_num_threads(),
}
report["models"] = {
    "embedding": embedding.model,
    "reranker": reranker.model,
    "vector_store": "Qdrant server 1.15.5, local Docker, persistent disk",
}
(report_dir / "retrieval.json").write_text(json.dumps(report, indent=2) + "\n")
(report_dir / "initial-indexing.json").write_text(json.dumps(reports, indent=2) + "\n")
print(
    "BENCHMARK COMPLETE",
    json.dumps({k: v for k, v in report.items() if k not in {"rows", "fleet"}}),
    flush=True,
)
