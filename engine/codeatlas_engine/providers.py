"""Real inference adapters. Test doubles live in tests, never production defaults."""

from __future__ import annotations
import hashlib
import os
from typing import Protocol
import httpx


class Embedder(Protocol):
    model: str
    dimension: int

    def encode(self, texts: list[str], query: bool = False) -> list[list[float]]: ...


class SentenceEmbeddings:
    def __init__(self):
        from sentence_transformers import SentenceTransformer

        self.model = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
        self.encoder = SentenceTransformer(self.model, trust_remote_code=False)
        self.dimension = self.encoder.get_sentence_embedding_dimension()

    def encode(self, texts, query=False):
        if query:
            texts = [
                "Represent this sentence for searching relevant passages: " + text
                for text in texts
            ]
        return self.encoder.encode(
            texts, batch_size=32, normalize_embeddings=True, show_progress_bar=False
        ).tolist()


class CrossEncoderReranker:
    def __init__(self):
        from sentence_transformers import CrossEncoder

        self.model = os.getenv("RERANK_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")
        self.encoder = CrossEncoder(self.model, trust_remote_code=False)

    def rank(self, query, candidates):
        if not candidates:
            return []
        scores = self.encoder.predict(
            [(query, chunk.embedding_text) for chunk in candidates],
            batch_size=16,
            show_progress_bar=False,
        )
        return sorted(
            zip(candidates, map(float, scores)), key=lambda pair: (-pair[1], pair[0].id)
        )


class VectorStore:
    def __init__(self, embedder, url=None, client=None):
        from qdrant_client import QdrantClient, models

        self.client = client or QdrantClient(
            url=url or os.getenv("QDRANT_URL", "http://qdrant:6333"),
            api_key=os.getenv("QDRANT_API_KEY"),
            timeout=60,
        )
        self.collection = (
            "codeatlas_" + hashlib.sha256(embedder.model.encode()).hexdigest()[:16]
        )
        if not self.client.collection_exists(self.collection):
            try:
                self.client.create_collection(
                    self.collection,
                    vectors_config=models.VectorParams(
                        size=embedder.dimension,
                        distance=models.Distance.COSINE,
                        on_disk=True,
                    ),
                )
            except Exception:
                if not self.client.collection_exists(self.collection):
                    raise
            self.client.create_payload_index(
                self.collection, "repo", models.PayloadSchemaType.KEYWORD
            )

    def upsert(self, chunks, vectors):
        from qdrant_client import models

        if chunks:
            self.client.upsert(
                self.collection,
                [
                    models.PointStruct(
                        id=c.id,
                        vector=vectors[c.content_hash],
                        payload={"repo": c.repo},
                    )
                    for c in chunks
                ],
                wait=True,
            )

    def delete(self, identities):
        from qdrant_client import models

        if identities:
            self.client.delete(
                self.collection, models.PointIdsList(points=list(identities)), wait=True
            )

    def search(self, vector, repos, k=60):
        from qdrant_client import models

        return [
            (str(p.id), p.score)
            for p in self.client.query_points(
                self.collection,
                query=vector,
                query_filter=models.Filter(
                    must=[
                        models.FieldCondition(
                            key="repo", match=models.MatchAny(any=repos)
                        )
                    ]
                ),
                limit=k,
                with_payload=False,
            ).points
        ]


class Chat:
    def __init__(self):
        self.provider = os.getenv("CHAT_PROVIDER", "groq")
        self.model = os.getenv(
            "CHAT_MODEL", "openai/gpt-oss-20b" if self.provider == "groq" else ""
        )
        if self.provider not in {"groq", "claude"}:
            raise ValueError("CHAT_PROVIDER must be groq or claude")

    def complete(self, system, prompt, max_tokens=1000):
        if self.provider == "claude":
            from anthropic import Anthropic

            if not self.model:
                raise ValueError(
                    "Set CHAT_MODEL to a Claude model available in your account"
                )
            client = Anthropic(timeout=60, max_retries=2)
            reply = client.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": prompt}],
            )
            return "".join(b.text for b in reply.content if b.type == "text")
        key = os.getenv("GROQ_API_KEY") or os.getenv("LLM_API_KEY")
        if not key:
            raise ValueError("Set the engine's GROQ_API_KEY secret")
        response = httpx.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
                "max_completion_tokens": max_tokens,
            },
            timeout=60,
        )
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"]
