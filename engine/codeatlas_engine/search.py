from __future__ import annotations
from collections import defaultdict
from urllib.parse import quote


class Search:
    def __init__(self, store, embedder, vectors, reranker):
        self.store, self.embedder, self.vectors, self.reranker = (
            store,
            embedder,
            vectors,
            reranker,
        )

    def query(self, question, repos, mode="hybrid", limit=10):
        known = {r["repo"]: r["commit_id"] for r in self.store.repos()}
        if not repos or any(repo not in known for repo in repos):
            raise ValueError("Select only indexed, permitted repositories")
        sparse = self.store.lexical(question, repos, 60)
        if mode == "bm25f":
            ranked = sparse
        else:
            dense = self.vectors.search(
                self.embedder.encode([question], query=True)[0], repos, 60
            )
            fused = defaultdict(float)
            for branch in (sparse, dense):
                for rank, (identity, _) in enumerate(branch, 1):
                    fused[identity] += 1 / (60 + rank)
            ranked = sorted(fused.items(), key=lambda item: (-item[1], item[0]))[:60]
        found = self.store.get([identity for identity, _ in ranked], repos)
        candidates = [found[i] for i, _ in ranked if i in found]
        if mode == "hybrid":
            final = self.reranker.rank(question, candidates)[:limit]
        elif mode in {"bm25f", "fusion"}:
            scores = dict(ranked)
            final = [(c, scores[c.id]) for c in candidates[:limit]]
        else:
            raise ValueError("Unknown retrieval mode")
        return [
            {
                **c.dict(),
                "score": float(score),
                "commit": known[c.repo],
                "url": f"https://github.com/{c.repo}/blob/{known[c.repo]}/{quote(c.path)}#L{c.start_line}-L{c.end_line}",
            }
            for c, score in final
        ]
