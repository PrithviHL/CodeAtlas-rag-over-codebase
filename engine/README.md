# CodeAtlas fleet engine

An opt-in retrieval and indexing backend integrated with the existing Google-protected CodeAtlas UI. It uses **LangGraph + Groq by default**; Claude is an optional provider. It does not represent the old hashed-vector demo as dense semantic retrieval.

**Implemented:** syntax-aware chunking, actual Sentence Transformer embeddings, an indexed SQLite BM25F posting list, Qdrant dense search, reciprocal-rank fusion, CrossEncoder reranking, a bounded LangGraph query planner/retriever/refinement/answer workflow, incremental Git snapshots, signed GitHub pushes, a durable indexing queue, benchmark tools, and the `/fleet` UI.

**Not established:** 2M+ indexed lines, 10+ indexed repositories, MRR@10 of 0.61 or 0.83, or a 38-second fleet update. Those are measurement targets, not results. The improvement from 0.61 to 0.83 would be 36.07% relative if independently measured on the same held-out judgments.

## Run locally

Requires Python 3.12+, Git, and enough disk/memory for two model copies (API + worker), Qdrant, mirrors, and metadata. Start with several GB of RAM and measure capacity; this profile does not fit the existing 512 MB free Render demo. Docker image builds download model dependencies; first use downloads public model weights and language grammars. No paid cloud resources are provisioned by these files.

```sh
cp engine/.env.example engine/.env
cp engine/config/repos.example.json engine/config/repos.json
```

Edit `engine/.env` to add distinct random `ENGINE_API_KEY` and `GITHUB_WEBHOOK_SECRET` values, and your existing **Groq** key as `GROQ_API_KEY`. Generate random secrets with `python3 -c 'import secrets; print(secrets.token_urlsafe(48))'`. Export `ENGINE_API_KEY` in your shell with the same value. Keep these files untracked. Only add public repositories you have permission to index to the manifest. No credentials are passed to Git, repository code is never executed, and submodules/symlinks/hidden/vendor files are excluded.

```sh
docker compose -f compose.engine.yaml up --build -d
docker compose -f compose.engine.yaml exec engine codeatlas-engine bootstrap
```

Open http://localhost:3000/fleet. The single worker drains queued imports; bootstrap does not synchronously index. The API endpoint at localhost:8000 requires `Authorization: Bearer <ENGINE_API_KEY>` except for health and the separately HMAC-protected webhook. Qdrant is not exposed on a public host port.

Alternatively, for development:

```sh
python3 -m venv .runtime/engine-venv
.runtime/engine-venv/bin/pip install -r engine/requirements.lock
.runtime/engine-venv/bin/pip install --no-deps -e engine
# Export ENGINE_DATA, REPOS_MANIFEST, QDRANT_URL, CHAT_PROVIDER=groq,
# CHAT_MODEL=openai/gpt-oss-20b, GROQ_API_KEY, ENGINE_API_KEY, GITHUB_WEBHOOK_SECRET.
.runtime/engine-venv/bin/uvicorn codeatlas_engine.service:app --host 127.0.0.1 --port 8000
# In a separate terminal, with the same settings:
.runtime/engine-venv/bin/python -m codeatlas_engine.worker
```

## Hosted connection and Google login

The current Node app remains the Google login boundary. Set its `ENGINE_URL` to a reachable **private** engine API base URL and its `ENGINE_API_KEY` to the shared server-only secret. The browser calls `/api/fleet/*`; Node proxies only an explicit route/method allowlist and never sends that secret to the browser. No user-supplied upstream URL is accepted. Each signed-in user can search the operator-approved public fleet; this is **not** per-user private repository authorization. Never add private code without implementing explicit per-user repository ACLs first.

Deploy API, a **single** indexing worker, Qdrant, and durable storage deliberately. The API/worker share the same SQLite WAL database on a local volume; do not put WAL on a network filesystem or scale writers across machines. For multi-host deployments, migrate metadata/jobs to Postgres and use an object store for mirrors. Do not configure a private Render URL until those services exist. The existing free Render service continues its original retrieval pipeline until `ENGINE_URL` is set; this engine is not silently substituted or billed.

## Groq or Claude

Groq: `CHAT_PROVIDER=groq`, `CHAT_MODEL=openai/gpt-oss-20b`, `GROQ_API_KEY=<secret>`. This reuses a Groq account, not the local runner. Free-plan quotas apply to query planning and answers separately and can interrupt a public demo; errors become visible evidence-only answers rather than invented success.

Claude: `CHAT_PROVIDER=claude`, `CHAT_MODEL=<a Claude model enabled in your account>`, `ANTHROPIC_API_KEY=<secret>`. Anthropic's official SDK is used. An existing Claude subscription does not include API usage. Switching providers does not change the retrieval benchmark.

## Chunking and retrieval

Python uses the stdlib AST; TypeScript/JavaScript/Go/Rust/Java/C/C++/Ruby use Tree-sitter declarations. Unsupported text and syntax errors use explicitly tagged windows. All file content, including imports and gaps between declarations, is considered. Long declarations split into bounded 2,400-character/80-line chunks. A chunk records parser strategy, repository, path, symbol, content hash, and exact line span. Code is never imported or executed.

The embedding identity includes path/symbol/body/chunker version but excludes commit/line offsets. Line shifts therefore update citations without re-embedding identical content. Cache keys are namespaced by real embedding model. Changing the chunker version or embedding model triggers reprocessing. Rename paths are re-embedded because path is part of embedding text.

BM25F normalizes path, symbol, and body term frequency separately with field weights and saturation. Posting lists and aggregate corpus stats are persisted. Query identifier splitting supports camelCase and snake_case. Up to 60 lexical and 60 dense candidates are fused; a real cross-encoder scores up to 60 fused candidates. The LangGraph agent plans at most three queries, performs at most two retrieval rounds, and answers from six commit-pinned citations. Query planning errors fall back to the original question; missing/out-of-range citation labels fall back to evidence. Citation-label validation does not prove semantic correctness: users must inspect source.

## Git-push updates

Create a GitHub repository webhook pointing to:

```text
https://YOUR-CODEATLAS-HOST/api/fleet/webhooks/github
```

Choose `application/json`, **push events only**, and the `GITHUB_WEBHOOK_SECRET` value. The browser login exemption applies only to this exact endpoint; GitHub HMAC-SHA256 authentication remains mandatory. Node forwards exact raw bytes and signature/delivery/event headers. Invalid/tampered signatures are rejected; delivery IDs are deduplicated; unapproved repository/branch and pinned manifests cannot enqueue updates. GitHub must have permission to send this repository's webhook.

The handler acknowledges a durable queued job. The single worker fetches the configured branch head and compares versioned Git blob hashes. It reads/re-chunks only changed files; cached unchanged chunk embeddings are reused. It upserts new vectors in batches, publishes metadata transactionally, then deletes stale vector IDs. Git, model, or vector failures cannot publish a new metadata snapshot prematurely. Failed cleanup can leave orphaned vectors; current metadata filters prevent orphaned IDs from appearing, but an operator should reconcile/rebuild the vector collection after persistent cleanup errors. Qdrant/SQLite publication is not a distributed atomic transaction; readers may briefly see fewer results during an update. A single worker preserves update order; delayed push deliveries are coalesced to the configured branch's latest head rather than rolling it back.

Jobs persist across restarts. A single worker requeues interrupted jobs on startup. Failed jobs retain an error type; retry explicitly with `codeatlas-engine retry JOB_ID`. There is no infinite paid-provider retry loop. A failed job does not satisfy a latency target. Git fetch has a five-minute timeout, and source files above 1 MB/binary files are skipped. Fetch transfer size is not hard capped; only approve repositories whose size is suitable for your hardware.

## Evidence for résumé claims

1. Add at least 10 approved repositories to `engine/config/repos.json`. Pin immutable SHAs for retrieval evaluation. Bootstrap and wait for every job to complete.
2. Run `codeatlas-engine inventory`. It outputs actual indexed LOC, repository count, and commit SHAs; it does not count unindexed/generated/vendor/binary code as coverage. Retain this report, hardware specification, model identifiers, dependency lock, and logs.
3. Label at least 100–200 representative natural-language queries with relevant repository/file/line intervals. Include paraphrases that do not repeat identifiers, no-match cases in a separate set, and queries spanning multiple repos. Split development and held-out evaluation sets before tuning weights. The example JSONL is a format example, not a benchmark result. Replace its SHA and have a human verify its relevant lines.
4. Run:

   ```sh
   codeatlas-engine evaluate --dataset /benchmarks/heldout.jsonl --output /benchmarks/retrieval-results.json
   ```

   The tool verifies indexed SHAs and computes **MRR@10** for BM25F, fusion, and full cross-encoder retrieval on the same judgments. It saves per-query ranks, retrieved IDs, query latency, dataset SHA-256, and fleet inventory. Scores are calculated from observed results. Tune on development queries only; do not insert desired values or silently exclude failures.

5. For incremental latency, push a controlled change to a configured unpinned branch, then measure a signed delivery after GitHub can fetch that commit:

   ```sh
   codeatlas-engine measure-push --repo owner/repository --branch main \
     --commit FULL_NEW_SHA --probe "unique behavior introduced by the change" \
     --expected-path src/changed.py --output /benchmarks/push-result.json
   ```

   Set `ENGINE_URL` to the API base, plus the API/webhook secrets in the measurement process. This measures **webhook submission → verified retrieval**, including queue/fetch/embed/publish and polling. Worker reports also contain server receipt-to-publication. It is not a measurement from the developer's `git push` command, and it refuses no-op/coalesced events. It verifies the new commit is returned in search and records actual fleet size/LOC. Run this on a representative warm fleet, across many pushes and change sizes; report p50/p95 and cold-start results separately. No claim of “38 seconds” is justified by one sample or an empty fleet.

### Accurate current description

> Built a LangGraph code-search engine with Groq, AST-aware chunks, BM25F, semantic embeddings, cross-encoder reranking, and a signed incremental GitHub webhook. Added reproducible MRR@10, indexed-LOC inventory, and webhook-to-search latency measurement.

Add the scale, quality gain, and latency numbers only after the retained reports demonstrate them. If Groq is used, do not claim Claude API experience from this implementation.

## Tests and limits

`pytest engine/tests` exercises AST chunk identity/line shifts, bounded chunks, embedding reuse, deletion/renames, failure-before-publication, actual local Qdrant client integration (with small test vectors), BM25F repo scope, bounded LangGraph behavior, HMAC validation/deduplication, and benchmark snapshot enforcement. Test vector/chat doubles do not stand in for a successful external API call or real model quality. A separate real-model smoke report can validate embedding/reranking wiring, but is not an evaluation at fleet scale.

Model downloads and first inference can dominate startup. CPU embedding throughput, cross-encoder latency, Git host throttling, and free Groq quotas affect results. The deployment has no automatic 2M-LOC capacity guarantee. SQLite metadata is single-host, not a horizontally distributed search platform. Credentials and benchmark corpora are excluded from Docker builds and Git.

The retained [`benchmarks/smoke-report.json`](benchmarks/smoke-report.json) records a real BGE-small + MiniLM cross-encoder functional smoke on three synthetic source files. Reproduce from the repository root with `HF_HOME="$PWD/.runtime/huggingface" .runtime/engine-venv/bin/python engine/benchmarks/smoke.py`. It performs no live Groq/Claude call and supports no fleet-scale performance claim.

Validation in this development session: Python engine tests and Node tests passed; real embedding/cross-encoder smoke and a public Git import followed by a zero-reembedding unchanged update passed. Compose syntax validated. The engine Docker build could not finish because Docker Hub timed out fetching the Python base image; the container build and a live Groq graph round-trip still need environment validation. No 2M-LOC benchmark or paid deployment was run.
