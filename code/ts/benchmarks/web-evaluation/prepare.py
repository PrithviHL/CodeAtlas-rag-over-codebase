"""Fetch immutable public evaluation inputs; never execute imported repository code."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

import pyarrow.parquet as pq

LANGUAGES = ["python", "javascript", "go", "java", "ruby"]
REPOS = ["pallets/flask", "honojs/hono", "expressjs/express"]
DATASET = "mteb/CodeSearchNetRetrieval"


def download(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=90) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--results-dir", type=Path, required=True)
    args = parser.parse_args()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    args.results_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = args.results_dir / "inputs.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    revision = previous.get("dataset_revision") or json.loads(download(f"https://huggingface.co/api/datasets/{DATASET}"))["sha"]
    manifest = {"dataset": DATASET, "dataset_revision": revision, "files": [], "repositories": []}

    def fetch_part(pair):
        language, part = pair
        name = f"{language}-{part}/test-00000-of-00001.parquet"
        url = f"https://huggingface.co/datasets/{DATASET}/resolve/{revision}/{name}"
        target = args.work_dir / name.replace("/", "-")
        content = target.read_bytes() if target.exists() else download(url)
        target.write_bytes(content)
        digest = hashlib.sha256(content).hexdigest()
        old = next((x for x in previous.get("files", []) if x["name"] == name), None)
        if old and old["sha256"] != digest:
            raise ValueError(f"Input checksum changed: {name}")
        rows = pq.read_table(target).to_pylist()
        (args.work_dir / f"{language}-{part}.json").write_text(json.dumps(rows))
        return {"name": name, "url": url, "sha256": digest, "bytes": len(content), "records": len(rows)}

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        manifest["files"] = list(pool.map(fetch_part, [(lang, part) for lang in LANGUAGES for part in ["corpus", "queries", "qrels"]]))

    def fetch_repo(repo):
        target = args.work_dir / "repos" / repo.replace("/", "__")
        target.parent.mkdir(parents=True, exist_ok=True)
        old = next((r for r in previous.get("repositories", []) if r["repo"] == repo), None)
        started = time.perf_counter()
        cloned = not (target / ".git").exists()
        env = {"PATH": os.environ["PATH"], "HOME": str(args.work_dir.resolve()), "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1"}
        if cloned:
            subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "clone", "--depth=1", "--single-branch", f"https://github.com/{repo}.git", str(target)], check=True, capture_output=True, env=env)
        elapsed = time.perf_counter() - started
        if old:
            subprocess.run(["git", "-C", str(target), "-c", "core.hooksPath=/dev/null", "fetch", "--depth=1", "origin", old["commit"]], check=True, capture_output=True, env=env)
            subprocess.run(["git", "-C", str(target), "-c", "core.hooksPath=/dev/null", "checkout", "--detach", old["commit"]], check=True, capture_output=True, env=env)
        sha = subprocess.check_output(["git", "-C", str(target), "rev-parse", "HEAD"], text=True).strip()
        return {"repo": repo, "commit": sha, "clone_seconds": old["clone_seconds"] if old else elapsed if cloned else None, "clone_conditions": "one shallow public GitHub clone; network and filesystem included"}

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        manifest["repositories"] = list(pool.map(fetch_repo, REPOS))
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"dataset_revision": revision, "downloaded_records": sum(f["records"] for f in manifest["files"]), "repositories": manifest["repositories"]}, indent=2))


if __name__ == "__main__":
    main()
