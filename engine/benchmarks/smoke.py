from pathlib import Path
import hashlib, json, time
from tree_sitter_language_pack import configure, PackConfig
from codeatlas_engine.providers import (
    SentenceEmbeddings,
    CrossEncoderReranker,
    VectorStore,
)
from codeatlas_engine.store import Store
from codeatlas_engine.indexing import Indexer
from codeatlas_engine.search import Search
from qdrant_client import QdrantClient

root = Path(".runtime/engine-real-smoke").resolve()
root.mkdir(parents=True, exist_ok=True)
configure(PackConfig(cache_dir=str(root / "grammars")))


class Snapshot:
    commit = "a" * 40
    content = {
        "auth.py": 'def authorize(user, permission):\n    """Verify that the user can access the requested resource."""\n    return permission in user.permissions\n',
        "retry.ts": "export async function retryRequest(request: () => Promise<void>) {\n  for (let attempt = 0; attempt < 3; attempt++) {\n    try { return await request(); } catch (error) {\n      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));\n    }\n  }\n}\n",
        "catalog.py": "def list_products(database):\n    return database.products.all()\n",
    }

    def files(self):
        return {
            p: hashlib.sha256(v.encode()).hexdigest() for p, v in self.content.items()
        }

    def read(self, path, blob):
        return self.content[path]


started = time.perf_counter()
e = SentenceEmbeddings()
r = CrossEncoderReranker()
s = Store(str(root / "metadata.sqlite3"))
v = VectorStore(e, client=QdrantClient(":memory:"))
i = Indexer(s, e, v)
# Clear metadata from earlier runs; Qdrant memory is intentionally a fresh store.
with s.db() as db:
    for table in (
        "files",
        "chunks",
        "postings",
        "lengths",
        "repos",
        "stats",
        "file_lines",
    ):
        db.execute("DELETE FROM " + table)
report = i.update("smoke/example", Snapshot())
search = Search(s, e, v, r)
hits = search.query(
    "Where are failed network calls retried with increasing delays?", ["smoke/example"]
)
report.update(
    test_kind="real-model functional smoke; not a representative benchmark",
    embedding_model=e.model,
    rerank_model=r.model,
    top_source=hits[0]["path"],
    sources=len(hits),
    startup_and_run_seconds=time.perf_counter() - started,
)
assert hits[0]["path"] == "retry.ts", [(h["path"], h["score"]) for h in hits]
(root / "report.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
