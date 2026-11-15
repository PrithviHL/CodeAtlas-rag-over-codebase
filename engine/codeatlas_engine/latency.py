"""Measure signed webhook submission through verified retrieval, not just enqueue."""

from __future__ import annotations
import hashlib
import hmac
import json
import os
from pathlib import Path
import time
import uuid
import httpx


def measure(repo, branch, commit, probe, expected_path, output, timeout=300):
    base = os.environ["ENGINE_URL"].rstrip("/")
    api_key = os.environ["ENGINE_API_KEY"]
    secret = os.environ["GITHUB_WEBHOOK_SECRET"]
    delivery = str(uuid.uuid4())
    raw = json.dumps(
        {
            "repository": {"full_name": repo},
            "ref": "refs/heads/" + branch,
            "after": commit,
        }
    ).encode()
    signed = {
        "x-github-delivery": delivery,
        "x-github-event": "push",
        "x-hub-signature-256": "sha256="
        + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest(),
        "Content-Type": "application/json",
    }
    admin = {"Authorization": "Bearer " + api_key}
    started = time.perf_counter()
    with httpx.Client(timeout=120) as client:
        response = client.post(base + "/webhooks/github", content=raw, headers=signed)
        response.raise_for_status()
        job_id = response.json()["job_id"]
        while time.perf_counter() - started < timeout:
            response = client.get(base + "/jobs", headers=admin)
            response.raise_for_status()
            job = next((j for j in response.json() if j["id"] == job_id), None)
            if job and job["status"] == "failed":
                raise RuntimeError("Indexing failed; inspect the job error type")
            if job and job["status"] == "complete":
                report = json.loads(job["report"])
                if report["commit"] != commit:
                    raise RuntimeError(
                        "Commit was coalesced; rerun with a distinct controlled push"
                    )
                if not report["changed_files"]:
                    raise RuntimeError(
                        "No-op delivery cannot substantiate changed-code indexing latency"
                    )
                response = client.post(
                    base + "/search",
                    headers=admin,
                    json={"question": probe, "repos": [repo]},
                )
                response.raise_for_status()
                if any(
                    h["path"] == expected_path and h["commit"] == commit
                    for h in response.json()["results"]
                ):
                    fleet = client.get(base + "/repos", headers=admin)
                    fleet.raise_for_status()
                    rows = fleet.json()
                    measured = {
                        "delivery": delivery,
                        "commit": commit,
                        "webhook_submission_to_verified_search_seconds": time.perf_counter()
                        - started,
                        "job_report": report,
                        "fleet_repositories": len(rows),
                        "fleet_indexed_lines": sum(r["lines"] for r in rows),
                        "fleet_snapshots": rows,
                        "probe": probe,
                        "expected_path": expected_path,
                        "measured_at": time.time(),
                    }
                    Path(output).write_text(json.dumps(measured, indent=2) + "\n")
                    return measured
            time.sleep(0.5)
    raise TimeoutError(
        "Changed code did not become searchable in the measurement window"
    )
