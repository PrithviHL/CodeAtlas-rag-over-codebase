from __future__ import annotations
import os
from pathlib import Path
from .store import Store
from .providers import SentenceEmbeddings, VectorStore, CrossEncoderReranker, Chat
from .search import Search
from .indexing import manifest


def settings():
    root = Path(os.getenv("ENGINE_DATA", "/data"))
    root.mkdir(parents=True, exist_ok=True)
    from tree_sitter_language_pack import configure, PackConfig

    configure(PackConfig(cache_dir=str(root / "grammars")))
    return root, manifest(os.getenv("REPOS_MANIFEST", "/config/repos.json"))


def components(root):
    store = Store(str(root / "metadata.sqlite3"))
    embeddings = SentenceEmbeddings()
    vectors = VectorStore(embeddings)
    return store, embeddings, vectors


def search_components(root):
    store, embedding, vectors = components(root)
    return store, Search(store, embedding, vectors, CrossEncoderReranker()), Chat()
