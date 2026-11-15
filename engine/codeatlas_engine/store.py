"""WAL metadata, persisted jobs, and an indexed BM25F posting list."""

from __future__ import annotations
import json
import math
import sqlite3
import time
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from .chunking import Chunk, terms

FIELDS = {"path": (2.0, 0.3), "symbol": (3.0, 0.3), "body": (1.0, 0.75)}


class Store:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.executescript(
                """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS repos(repo TEXT PRIMARY KEY, commit_id TEXT, lines INTEGER, files INTEGER, updated REAL);
            CREATE TABLE IF NOT EXISTS files(repo TEXT, path TEXT, blob TEXT, PRIMARY KEY(repo,path));
            CREATE TABLE IF NOT EXISTS file_lines(repo TEXT, path TEXT, lines INTEGER, PRIMARY KEY(repo,path));
            CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, repo TEXT, path TEXT, data TEXT);
            CREATE INDEX IF NOT EXISTS chunks_repo_path ON chunks(repo,path);
            CREATE TABLE IF NOT EXISTS postings(term TEXT, chunk TEXT, field TEXT, tf INTEGER, PRIMARY KEY(term,chunk,field));
            CREATE INDEX IF NOT EXISTS postings_chunk ON postings(chunk);
            CREATE TABLE IF NOT EXISTS lengths(chunk TEXT, field TEXT, length INTEGER, PRIMARY KEY(chunk,field));
            CREATE TABLE IF NOT EXISTS stats(repo TEXT PRIMARY KEY, chunks INTEGER, path_len INTEGER, symbol_len INTEGER, body_len INTEGER);
            CREATE TABLE IF NOT EXISTS embeddings(model TEXT, hash TEXT, vector TEXT, PRIMARY KEY(model,hash));
            CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY, delivery TEXT UNIQUE, repo TEXT, requested_commit TEXT, status TEXT DEFAULT 'queued', attempts INTEGER DEFAULT 0, received REAL, started REAL, finished REAL, report TEXT, error TEXT);
            """
            )

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=60)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def repos(self):
        with self.db() as db:
            return [dict(r) for r in db.execute("SELECT * FROM repos ORDER BY repo")]

    def file_hashes(self, repo):
        with self.db() as db:
            return dict(
                db.execute(
                    "SELECT path,blob FROM files WHERE repo=?", (repo,)
                ).fetchall()
            )

    def line_counts(self, repo):
        with self.db() as db:
            return dict(
                db.execute(
                    "SELECT path,lines FROM file_lines WHERE repo=?", (repo,)
                ).fetchall()
            )

    def current_chunks(self, repo, paths=None):
        with self.db() as db:
            if paths is None:
                rows = db.execute(
                    "SELECT data FROM chunks WHERE repo=?", (repo,)
                ).fetchall()
            else:
                rows = []
                paths = sorted(paths)
                for offset in range(0, len(paths), 400):
                    batch = paths[offset : offset + 400]
                    marks = ",".join("?" for _ in batch)
                    rows.extend(
                        db.execute(
                            f"SELECT data FROM chunks WHERE repo=? AND path IN ({marks})",
                            [repo, *batch],
                        ).fetchall()
                    )
            return [Chunk(**json.loads(r[0])) for r in rows]

    def get(self, ids, repos):
        if not ids or not repos:
            return {}
        with self.db() as db:
            marks = ",".join("?" for _ in ids)
            return {
                r["id"]: Chunk(**json.loads(r["data"]))
                for r in db.execute(f"SELECT * FROM chunks WHERE id IN ({marks})", ids)
                if r["repo"] in repos
            }

    def cache(self, model, hashes):
        with self.db() as db:
            return {
                h: json.loads(row[0])
                for h in hashes
                if (
                    row := db.execute(
                        "SELECT vector FROM embeddings WHERE model=? AND hash=?",
                        (model, h),
                    ).fetchone()
                )
            }

    def cache_put(self, model, vectors):
        with self.db() as db:
            db.executemany(
                "INSERT OR REPLACE INTO embeddings VALUES(?,?,?)",
                [(model, h, json.dumps(v)) for h, v in vectors.items()],
            )

    def publish(self, repo, commit, hashes, changed, replacements, line_count, counts):
        with self.db() as db:
            for path in changed:
                ids = [
                    r[0]
                    for r in db.execute(
                        "SELECT id FROM chunks WHERE repo=? AND path=?", (repo, path)
                    )
                ]
                db.executemany(
                    "DELETE FROM postings WHERE chunk=?", [(i,) for i in ids]
                )
                db.executemany("DELETE FROM lengths WHERE chunk=?", [(i,) for i in ids])
                db.execute("DELETE FROM chunks WHERE repo=? AND path=?", (repo, path))
            for chunk in replacements:
                db.execute(
                    "INSERT OR REPLACE INTO chunks VALUES(?,?,?,?)",
                    (chunk.id, repo, chunk.path, json.dumps(chunk.dict())),
                )
                for field in FIELDS:
                    field_counts = Counter(terms(getattr(chunk, field)))
                    db.execute(
                        "INSERT INTO lengths VALUES(?,?,?)",
                        (chunk.id, field, sum(field_counts.values())),
                    )
                    db.executemany(
                        "INSERT INTO postings VALUES(?,?,?,?)",
                        [(t, chunk.id, field, n) for t, n in field_counts.items()],
                    )
            db.execute("DELETE FROM file_lines WHERE repo=?", (repo,))
            db.executemany(
                "INSERT INTO file_lines VALUES(?,?,?)",
                [(repo, p, n) for p, n in counts.items()],
            )
            db.execute("DELETE FROM files WHERE repo=?", (repo,))
            db.executemany(
                "INSERT INTO files VALUES(?,?,?)",
                [(repo, p, b) for p, b in hashes.items()],
            )
            db.execute(
                "INSERT OR REPLACE INTO repos VALUES(?,?,?,?,?)",
                (repo, commit, line_count, len(hashes), time.time()),
            )
            count = db.execute(
                "SELECT count(*) FROM chunks WHERE repo=?", (repo,)
            ).fetchone()[0]
            totals = dict(
                db.execute(
                    "SELECT field,sum(length) FROM lengths JOIN chunks ON chunks.id=lengths.chunk WHERE repo=? GROUP BY field",
                    (repo,),
                )
            )
            db.execute(
                "INSERT OR REPLACE INTO stats VALUES(?,?,?,?,?)",
                (repo, count, *[totals.get(field, 0) for field in FIELDS]),
            )

    def lexical(self, query, repos, k=60):
        query_terms = list(dict.fromkeys(terms(query)))[:40]
        if not query_terms or not repos:
            return []
        with self.db() as db:
            scope = ",".join("?" for _ in repos)
            totals = db.execute(
                f"SELECT coalesce(sum(chunks),0),coalesce(sum(path_len),0),coalesce(sum(symbol_len),0),coalesce(sum(body_len),0) FROM stats WHERE repo IN ({scope})",
                repos,
            ).fetchone()
            n = totals[0]
            averages = {
                field: totals[i + 1] / max(n, 1) for i, field in enumerate(FIELDS)
            }
            scores = Counter()
            for term in query_terms:
                rows = db.execute(
                    f"SELECT p.chunk,p.field,p.tf,l.length FROM postings p JOIN chunks c ON c.id=p.chunk JOIN lengths l ON l.chunk=p.chunk AND l.field=p.field WHERE p.term=? AND c.repo IN ({scope})",
                    [term, *repos],
                ).fetchall()
                tf = Counter()
                for row in rows:
                    weight, b = FIELDS[row["field"]]
                    tf[row["chunk"]] += (
                        weight
                        * row["tf"]
                        / (1 - b + b * row["length"] / max(averages[row["field"]], 1))
                    )
                idf = math.log(1 + (n - len(tf) + 0.5) / (len(tf) + 0.5))
                for identity, frequency in tf.items():
                    scores[identity] += idf * frequency * 2.2 / (1.2 + frequency)
            return scores.most_common(k)

    def enqueue(self, delivery, repo, commit, received=None):
        with self.db() as db:
            db.execute(
                "INSERT OR IGNORE INTO jobs(delivery,repo,requested_commit,received) VALUES(?,?,?,?)",
                (delivery, repo, commit, received or time.time()),
            )
            return dict(
                db.execute(
                    "SELECT * FROM jobs WHERE delivery=?", (delivery,)
                ).fetchone()
            )

    def claim(self):
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            job = db.execute(
                "SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1"
            ).fetchone()
            if not job:
                return None
            db.execute(
                "UPDATE jobs SET status='running',started=?,attempts=attempts+1 WHERE id=?",
                (time.time(), job["id"]),
            )
            return dict(job)

    def finish(self, identity, report=None, error=None):
        with self.db() as db:
            db.execute(
                "UPDATE jobs SET status=?,finished=?,report=?,error=? WHERE id=?",
                (
                    "failed" if error else "complete",
                    time.time(),
                    json.dumps(report),
                    error,
                    identity,
                ),
            )

    def recover(self):
        # Invoke only on startup of the single indexing worker.
        with self.db() as db:
            db.execute("UPDATE jobs SET status='queued' WHERE status='running'")

    def jobs(self):
        with self.db() as db:
            return [
                dict(r)
                for r in db.execute("SELECT * FROM jobs ORDER BY id DESC LIMIT 100")
            ]
