"""Git snapshots and incremental content-hash indexing, with phase timings."""

from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import time
from .chunking import chunks, TEXT, VERSION

IGNORED = {
    "node_modules",
    "vendor",
    "dist",
    "build",
    "__pycache__",
    "data",
    "coverage",
    ".venv",
}


def manifest(path):
    value = json.loads(Path(path).read_text())
    if not isinstance(value, list) or not value:
        raise ValueError("Manifest must be a nonempty JSON array")
    result = {}
    for item in value:
        repo = item["repo"]
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo) or repo in result:
            raise ValueError("Repository names must be unique owner/name values")
        branch = item.get("branch", "main")
        if (
            not re.fullmatch(r"[\w./-]+", branch)
            or branch.startswith(("-", "/"))
            or ".." in branch
        ):
            raise ValueError("Invalid configured branch")
        commit = item.get("commit")
        if commit and not re.fullmatch(r"[a-f0-9]{40}", commit):
            raise ValueError("Pin commits with full 40-character SHA values")
        result[repo] = {"repo": repo, "branch": branch, "commit": commit}
    return result


class GitSnapshot:
    def __init__(self, root, spec):
        self.spec = spec
        self.path = Path(root) / hashlib.sha256(spec["repo"].encode()).hexdigest()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.run("init", "--bare", str(self.path), cwd=str(self.path.parent))
        self.run(
            "fetch",
            "--depth=1",
            "--no-tags",
            "--force",
            f"https://github.com/{spec['repo']}.git",
            f"{spec.get('commit') or ('refs/heads/'+spec['branch'])}:refs/heads/indexed",
        )
        self.commit = (
            self.run("rev-parse", spec.get("commit") or "refs/heads/indexed")
            .strip()
            .decode()
        )

    def run(self, *args, cwd=None):
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.path.parent),
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_LFS_SKIP_SMUDGE": "1",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
        }
        return subprocess.run(
            [
                "git",
                "-c",
                "credential.helper=",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "http.followRedirects=false",
                *args,
            ],
            cwd=cwd or self.path,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
            check=True,
        ).stdout

    def files(self):
        result = {}
        for entry in self.run("ls-tree", "-r", "-z", self.commit).split(b"\0"):
            if not entry:
                continue
            meta, filename = entry.split(b"\t", 1)
            mode, kind, blob = meta.split()
            name = filename.decode("utf-8", errors="strict")
            p = PurePosixPath(name)
            if (
                mode not in {b"100644", b"100755"}
                or kind != b"blob"
                or any(part.startswith(".") or part in IGNORED for part in p.parts)
            ):
                continue
            if p.suffix not in TEXT and p.name.lower() not in {
                "readme",
                "dockerfile",
                "license",
            }:
                continue
            result[name] = blob.decode()
        return result

    def read(self, path, blob):
        size = int(self.run("cat-file", "-s", blob))
        if size > 1_000_000:
            return None
        raw = self.run("cat-file", "blob", blob)
        if b"\0" in raw:
            return None
        return raw.decode("utf-8", errors="replace")


class Indexer:
    def __init__(self, store, embedder, vectors):
        self.store, self.embedder, self.vectors = store, embedder, vectors

    def update(self, repo, snapshot):
        started = time.perf_counter()
        old = self.store.file_hashes(repo)
        current = snapshot.files()
        # Blob hashes also incorporate chunker version: upgrades trigger re-chunking.
        hashes = {p: f"{VERSION}:{self.embedder.model}:{h}" for p, h in current.items()}
        changed = {p for p in old.keys() | hashes.keys() if old.get(p) != hashes.get(p)}
        old_chunks = self.store.current_chunks(repo, changed)
        replacements, skipped = [], 0
        counts = self.store.line_counts(repo)
        for path in sorted(changed):
            counts.pop(path, None)
            if path in current:
                source = snapshot.read(path, current[path])
                if source is None:
                    skipped += 1
                    continue
                produced = chunks(repo, path, source)
                replacements.extend(produced)
                counts[path] = len(source.splitlines())
        parsed = time.perf_counter()
        encoded, reused = 0, 0
        for offset in range(0, len(replacements), 128):
            batch = replacements[offset : offset + 128]
            unique = {c.content_hash: c for c in batch}
            values = self.store.cache(self.embedder.model, list(unique))
            reused += len(values)
            todo = [c for h, c in unique.items() if h not in values]
            for start in range(0, len(todo), 32):
                part = todo[start : start + 32]
                embeddings = self.embedder.encode([c.embedding_text for c in part])
                if len(embeddings) != len(part) or any(
                    len(v) != self.embedder.dimension for v in embeddings
                ):
                    raise ValueError("Embedding provider returned an unexpected shape")
                cached = dict(zip([c.content_hash for c in part], embeddings))
                self.store.cache_put(self.embedder.model, cached)
                values.update(cached)
                encoded += len(part)
            self.vectors.upsert(batch, values)
        embedded = time.perf_counter()
        # Publish metadata only after dense upserts are acknowledged.
        self.store.publish(
            repo,
            snapshot.commit,
            hashes,
            changed,
            replacements,
            sum(counts.values()),
            counts,
        )
        stale = {c.id for c in old_chunks} - {c.id for c in replacements}
        self.vectors.delete(stale)
        finished = time.perf_counter()
        return {
            "repo": repo,
            "commit": snapshot.commit,
            "changed_files": len(changed),
            "chunks_upserted": len(replacements),
            "embeddings_created": encoded,
            "embeddings_reused": reused,
            "chunks_deleted": len(stale),
            "skipped_files": skipped,
            "parse_seconds": parsed - started,
            "embed_and_upsert_seconds": embedded - parsed,
            "publish_seconds": finished - embedded,
            "index_seconds": finished - started,
            "measured_at": time.time(),
        }
