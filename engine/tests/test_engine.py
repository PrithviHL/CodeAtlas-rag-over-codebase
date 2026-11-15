import hashlib
import hmac
import json
import os
from pathlib import Path
from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient
from qdrant_client import QdrantClient
from codeatlas_engine.chunking import chunks, terms
from codeatlas_engine.store import Store
from codeatlas_engine.indexing import Indexer, manifest
from codeatlas_engine.providers import VectorStore
from codeatlas_engine.search import Search
from codeatlas_engine.agent import Agent
from codeatlas_engine.service import create_app
from codeatlas_engine.evaluation import evaluate


class Embeddings:
    model = "test-only-semantic-adapter"
    dimension = 3

    def __init__(self):
        self.calls = []

    def encode(self, texts, query=False):
        self.calls.extend(texts)
        return [
            [1.0, float("auth" in text.lower()), float("retry" in text.lower())]
            for text in texts
        ]


class Reranker:
    def rank(self, query, candidates):
        return [
            (c, float("authorize" in c.body))
            for c in sorted(candidates, key=lambda c: "authorize" not in c.body)
        ]


class Snapshot:
    def __init__(self, files, commit="a" * 40):
        self.content = files
        self.commit = commit
        self.reads = []

    def files(self):
        return {
            p: hashlib.sha256(s.encode()).hexdigest() for p, s in self.content.items()
        }

    def read(self, path, blob):
        self.reads.append(path)
        return self.content[path]


class Chat:
    def complete(self, system, prompt, max_tokens=1000):
        if "queries array" in system:
            return '{"queries":["authorize policy"]}'
        return "Authorization evaluates the policy [1]."


@pytest.fixture
def engine(tmp_path):
    store = Store(str(tmp_path / "metadata.sqlite3"))
    embedding = Embeddings()
    vectors = VectorStore(embedding, client=QdrantClient(":memory:"))
    indexer = Indexer(store, embedding, vectors)
    return (
        store,
        embedding,
        vectors,
        indexer,
        Search(store, embedding, vectors, Reranker()),
    )


def test_ast_chunks_keep_symbols_and_reuse_line_shifts():
    before = chunks(
        "owner/repo", "auth.py", "def authorize(user):\n    return policy(user)\n"
    )
    after = chunks(
        "owner/repo", "auth.py", "\n\ndef authorize(user):\n    return policy(user)\n"
    )
    assert before[0].symbol == "authorize" and before[0].strategy == "python-ast"
    assert before[0].id == after[0].id
    assert after[0].start_line == 3
    assert chunks("r/x", "bad.py", "def broken(")[0].strategy == "syntax-error-window"
    assert terms("authorizeUser user_token") == ["authorize", "user", "user", "token"]


def test_large_declarations_remain_bounded():
    source = "def big():\n" + "".join(f"    x{i} = {i}\n" for i in range(900))
    result = chunks("owner/repo", "big.py", source)
    assert len(result) > 10 and all(len(c.body) <= 2400 for c in result)
    assert result[-1].end_line == 901


def test_incremental_reembedding_rename_delete_and_commit_citations(engine):
    store, embedding, vectors, indexer, search = engine
    first = Snapshot(
        {
            "auth.py": "def authorize(user):\n    return policy(user)\n",
            "retry.py": "def retry():\n    return True\n",
        }
    )
    report = indexer.update("owner/repo", first)
    assert report["embeddings_created"] == 2 and store.repos()[0]["lines"] == 4
    second = Snapshot(dict(first.content), "b" * 40)
    report = indexer.update("owner/repo", second)
    assert (
        report["changed_files"] == 0
        and report["embeddings_created"] == 0
        and second.reads == []
    )
    third = Snapshot(
        {"auth.py": "\n\ndef authorize(user):\n    return policy(user)\n"}, "c" * 40
    )
    report = indexer.update("owner/repo", third)
    assert (
        report["embeddings_created"] == 0
        and report["embeddings_reused"] == 1
        and report["chunks_deleted"] == 1
    )
    hit = search.query("authorize", ["owner/repo"])[0]
    assert hit["start_line"] == 3 and hit["commit"] == "c" * 40
    assert store.repos()[0]["lines"] == 4
    fourth = Snapshot({"auth.py": "def authorize(user):\n    return False\n"}, "d" * 40)
    assert indexer.update("owner/repo", fourth)["embeddings_created"] == 1
    assert all("policy" not in c.body for c in store.current_chunks("owner/repo"))
    renamed = Snapshot({"access.py": fourth.content["auth.py"]}, "e" * 40)
    assert indexer.update("owner/repo", renamed)["chunks_deleted"] == 1
    assert search.query("authorize", ["owner/repo"])[0]["path"] == "access.py"


def test_failed_embedding_does_not_publish_new_snapshot(engine):
    store, embedding, _, indexer, _ = engine
    indexer.update("owner/repo", Snapshot({"a.py": "def old():\n return 1\n"}))
    with patch.object(embedding, "encode", side_effect=RuntimeError("offline")):
        with pytest.raises(RuntimeError):
            indexer.update(
                "owner/repo",
                Snapshot({"a.py": "def changed():\n return 2\n"}, "b" * 40),
            )
    assert store.repos()[0]["commit_id"] == "a" * 40


def test_bm25f_scope_fusion_and_agent(engine):
    store, _, _, indexer, search = engine
    indexer.update(
        "owner/repo", Snapshot({"a.py": "def authorize(user):\n return policy(user)\n"})
    )
    indexer.update(
        "other/repo", Snapshot({"secret.py": "def authorize():\n return private()\n"})
    )
    hits = search.query("authorize", ["owner/repo"], mode="bm25f")
    assert hits and all(h["repo"] == "owner/repo" for h in hits)
    result = Agent(search, Chat()).ask(
        "Where is authorization checked?", ["owner/repo"]
    )
    assert result["answer"].endswith("[1].")
    assert [n["node"] for n in result["trace"]] == ["plan", "retrieve", "answer"]
    assert all(c["repo"] == "owner/repo" for c in result["citations"])
    with pytest.raises(ValueError):
        search.query("x", ["missing/repo"])


def test_agent_bounded_refinement_and_invalid_citation():
    class Empty:
        def query(self, *args, **kwargs):
            return []

    result = Agent(Empty(), Chat()).ask("missing", ["r/x"])
    assert [t["node"] for t in result["trace"]].count("retrieve") == 2

    class Hits:
        def query(self, *args, **kwargs):
            return [
                {
                    "id": "1",
                    "repo": "r/x",
                    "path": "a",
                    "start_line": 1,
                    "end_line": 2,
                    "body": "text",
                    "score": 1,
                }
            ]

    class Invalid(Chat):
        def complete(self, system, prompt, max_tokens=1000):
            return '{"queries":[]}' if "queries array" in system else "Made up [99]."

    assert (
        "invalid citations" in Agent(Hits(), Invalid()).ask("test", ["r/x"])["answer"]
    )


def test_jobs_deduplicate_claim_recovery(engine):
    store, *_ = engine
    a = store.enqueue("delivery", "owner/repo", "a" * 40)
    assert store.enqueue("delivery", "owner/repo", "a" * 40)["id"] == a["id"]
    assert store.claim()["id"] == a["id"] and store.claim() is None
    store.recover()
    assert store.claim()["id"] == a["id"]
    store.finish(a["id"], {"seconds": 1})
    assert store.jobs()[0]["status"] == "complete"


def test_signed_webhook_api_boundary_and_duplicate_delivery(engine, monkeypatch):
    store, _, _, _, search = engine
    monkeypatch.setenv("ENGINE_API_KEY", "test-token")
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "test-signing-secret")
    app = create_app(
        store, search, Chat(), {"owner/repo": {"branch": "main", "commit": None}}
    )
    raw = json.dumps(
        {
            "repository": {"full_name": "owner/repo"},
            "ref": "refs/heads/main",
            "after": "a" * 40,
        }
    ).encode()
    signature = (
        "sha256=" + hmac.new(b"test-signing-secret", raw, hashlib.sha256).hexdigest()
    )
    headers = {
        "x-hub-signature-256": signature,
        "x-github-delivery": "delivery-1",
        "x-github-event": "push",
    }
    with TestClient(app) as client:
        assert client.get("/repos").status_code == 401
        assert client.post("/webhooks/github", content=raw).status_code == 401
        a = client.post("/webhooks/github", content=raw, headers=headers)
        assert a.status_code == 202
        assert (
            client.post("/webhooks/github", content=raw, headers=headers).json()[
                "job_id"
            ]
            == a.json()["job_id"]
        )
        assert (
            client.post(
                "/webhooks/github", content=raw + b" ", headers=headers
            ).status_code
            == 401
        )
        assert (
            client.get(
                "/repos", headers={"Authorization": "Bearer test-token"}
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/search",
                json={"question": "x", "repos": ["unapproved/repo"]},
                headers={"Authorization": "Bearer test-token"},
            ).status_code
            == 403
        )


def test_evaluation_uses_real_judgments_and_snapshot_pins(engine, tmp_path):
    store, _, _, indexer, search = engine
    indexer.update(
        "owner/repo", Snapshot({"auth.py": "def authorize():\n return True\n"})
    )
    dataset = tmp_path / "judgments.jsonl"
    output = tmp_path / "report.json"
    q = {
        "id": "q1",
        "question": "authorize",
        "repos": ["owner/repo"],
        "commits": {"owner/repo": "a" * 40},
        "relevant": [
            {"repo": "owner/repo", "path": "auth.py", "start_line": 1, "end_line": 2}
        ],
    }
    dataset.write_text(json.dumps(q) + "\n")
    report = evaluate(search, store, dataset, output)
    assert report["mrr_at_10"]["hybrid"] == 1 and report["queries"] == 1
    assert report["total_indexed_lines"] == 2
    q["commits"]["owner/repo"] = "b" * 40
    dataset.write_text(json.dumps(q))
    with pytest.raises(ValueError, match="snapshot"):
        evaluate(search, store, dataset, output)


def test_manifest_rejects_credentials_and_duplicate_repos(tmp_path):
    p = tmp_path / "repos.json"
    p.write_text('[{"repo":"https://user:password@github.com/x/y"}]')
    with pytest.raises(ValueError):
        manifest(p)
