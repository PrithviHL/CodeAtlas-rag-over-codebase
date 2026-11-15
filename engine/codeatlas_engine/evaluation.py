"""Held-out retrieval evaluation. All numbers are computed, never target-filled."""

from __future__ import annotations
import hashlib
import json
from pathlib import Path
import statistics
import time


def relevant(hit, judgments):
    return any(
        hit["repo"] == j["repo"]
        and hit["path"] == j["path"]
        and hit["start_line"] <= j["end_line"]
        and hit["end_line"] >= j["start_line"]
        for j in judgments
    )


def evaluate(search, store, dataset, output):
    raw = Path(dataset).read_bytes()
    questions = [json.loads(line) for line in raw.decode().splitlines() if line.strip()]
    if not questions or any(not q.get("relevant") for q in questions):
        raise ValueError("Every evaluation query needs human relevance judgments")
    inventory = {r["repo"]: r for r in store.repos()}
    for q in questions:
        for repo, commit in q["commits"].items():
            if repo not in inventory or inventory[repo]["commit_id"] != commit:
                raise ValueError(f"Benchmark snapshot mismatch: {repo}")
        if set(q["repos"]) != set(q["commits"]):
            raise ValueError("Pin all searched repository commits")
    rows = []
    for q in questions:
        row = {"id": q["id"], "modes": {}}
        for mode in ("bm25f", "fusion", "hybrid"):
            started = time.perf_counter()
            hits = search.query(q["question"], q["repos"], mode=mode, limit=10)
            rank = next(
                (i for i, h in enumerate(hits, 1) if relevant(h, q["relevant"])), None
            )
            row["modes"][mode] = {
                "reciprocal_rank": 1 / rank if rank else 0,
                "seconds": time.perf_counter() - started,
                "ids": [h["id"] for h in hits],
            }
        rows.append(row)
    scores = {
        mode: statistics.mean(r["modes"][mode]["reciprocal_rank"] for r in rows)
        for mode in ("bm25f", "fusion", "hybrid")
    }
    report = {
        "queries": len(rows),
        "dataset_sha256": hashlib.sha256(raw).hexdigest(),
        "mrr_at_10": scores,
        "relative_gain": (
            (scores["hybrid"] / scores["bm25f"] - 1) if scores["bm25f"] else None
        ),
        "fleet": list(inventory.values()),
        "total_indexed_lines": sum(r["lines"] for r in inventory.values()),
        "generated_at": time.time(),
        "rows": rows,
        "scope": "Computed on supplied judgments only; no claim of 2M LOC, 10 repositories, or 38-second indexing without corresponding evidence.",
    }
    Path(output).write_text(json.dumps(report, indent=2) + "\n")
    return report
