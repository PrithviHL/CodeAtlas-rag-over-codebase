# Local development pilot

This is a measured **development pilot**, not a held-out evaluation, independently human-labeled benchmark, production load test, or 2M-line capacity result. Questions and narrow source-interval labels were authored by the coding assistant after inspecting source, before evaluating rankings. No relevance labels or model settings were changed in response to the observed scores.

## Corpus and runtime

- CodeAtlas: `863964a290cffcec050a9e9dccc80e247928bed4`, 5,087 indexed lines.
- LeaveNow: `ea7ba7521891b962b9dd16c31d81bbae9b83982e`, 6,940 indexed lines.
- Total: **12,027 indexed lines, 2 repositories, 20 questions**. Every question searches both repos.
- macOS arm64, 12 logical CPUs, CPU model inference with 4 Torch threads.
- Actual `BAAI/bge-small-en-v1.5` embeddings and `cross-encoder/ms-marco-MiniLM-L-6-v2` reranking.
- Persistent local Docker Qdrant 1.15.5 with compatible qdrant-client 1.15.1. The original client warning was fixed and retrieval evaluation repeated; rankings were unchanged.
- No Groq/Claude calls or paid services were used for these measurements.

## Retrieval results

| Retrieval mode | MRR@10 | Median query time | p95 query time |
|---|---:|---:|---:|
| BM25F | 0.0827 | 4.8 ms | 24.0 ms |
| BM25F + dense fusion | 0.1991 | 15.4 ms | 21.4 ms |
| Fusion + cross-encoder | 0.1735 | 651.5 ms | 722.6 ms |

The full pipeline improved over the lexical baseline on these particular labels, but **the general-purpose cross-encoder hurt quality compared with fusion alone**, while adding latency. Absolute retrieval quality is low on this pilot. These results do not support an MRR@10 claim of 0.83. Inspect the per-query results, then use a separate development set for changes and a larger independently judged held-out set to evaluate them. Do not tune against this set and call the resulting score held-out.

## Incremental result

A signed push payload was submitted through FastAPI TestClient, persisted as a job, and processed with a **real Git fetch** from the pre-engine CodeAtlas revision `a3280a67966908de973ceeeb69bd013e707d8376` to the revision above. The first search returning newly added indexing code completed in **5.387 seconds** from local submission. The run observed:

- 32 changed files; 133 chunk upserts.
- 108 newly generated embeddings; 25 embeddings reused.
- 15 obsolete chunks deleted.
- 4.705 seconds from server receipt to metadata/vector publication.

This was **one local delivery**, not an actual developer `git push` followed through GitHub, and not a network-hosted webhook. The replay used fresh metadata and embedding caches, cached model files, and a pre-existing Qdrant collection. It does not establish 38-second updates across a 2M-line fleet or p95 indexing latency. Model startup is excluded. Background applications and CPU scheduling were not controlled.

## Evidence and reproduction

- `pilot_queries.json`: questions and source needles used to resolve exact labels.
- `results/judgments.jsonl`: pinned repository SHAs and resolved relevant line intervals.
- `results/retrieval.json`: per-query ranks, retrieved chunk IDs, query times, and corpus/model metadata.
- `results/incremental.json`: complete observed incremental update measurements and limitations.
- `results/initial-indexing.json`: initial source-index measurements from the compatible-version replay.
- `results/failure-analysis.json`: source locations retrieved for non-top-1 reranked queries; no source content or secrets.

From the repository root, with the dependencies in `engine/requirements.lock` installed and local Qdrant on port 6434:

```sh
.runtime/engine-venv/bin/python engine/benchmarks/development/run.py
```

**Do not run this while the local worker is active:** this pilot deliberately rolls the CodeAtlas metadata back to a historical revision before testing an update. It uses `.runtime/local-engine` by default and may reuse cached vectors/embeddings on subsequent runs. The corpus and results will change if the current Git HEAD changes; retained results pin the revisions actually measured. To rerun just evaluation, use `codeatlas-engine evaluate` with the retained judgment file and exactly those indexed SHAs.
