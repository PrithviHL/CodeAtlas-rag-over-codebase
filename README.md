# CodeAtlas — Codebase Q&A

Explore public GitHub repositories with natural-language questions, generated explanations, and commit-pinned source citations.

**[Open the live app](https://codeatlas-rag.onrender.com)** · [Deployment and Google sign-in](docs/deployment.md) · [Fleet engine](engine/README.md) · [Measured local benchmark](engine/benchmarks/development/README.md)

The live app runs from **`feature/render-public-app`**. Google sign-in is required. The repository's `main` branch retains the earlier learning scaffold; use this branch for the deployed application.

## What is live

- Google OAuth login, a top-right account menu, and sign-out.
- Public GitHub imports into separate temporary browser workspaces.
- Natural-language questions with Groq-generated answers when the provider is available; explicit evidence fallback on failure.
- AST-aware declaration chunks using bundled Tree-sitter WASM parsers; bounded text windows for unsupported files or syntax errors.
- Search combining field-weighted BM25 and lightweight hashed vectors, followed by reciprocal-rank fusion.
- Expandable source excerpts and GitHub links pinned to the indexed commit and line range.
- Source snapshots, question history, and index removal within the browser workspace.

**The live demo uses the lightweight TypeScript pipeline.** The LangGraph engine with real semantic embeddings and cross-encoder reranking has been run locally and is not connected to the Render deployment. Its Fleet search link appears only when an engine is configured.

Hosted demo limits: one repository per browser, eight active workspaces, 100 files / 1 MB indexed per repository, and 200 KB per file. Workspaces expire after one idle hour or a service restart. Git fetch size is not capped by these indexing limits. Public imports never execute repository code or receive hosting credentials. Do not use the demo for confidential source or questions.

## Try it

1. Open [CodeAtlas](https://codeatlas-rag.onrender.com) and continue with Google.
2. Connect a small public GitHub repository, such as `https://github.com/octocat/Spoon-Knife`.
3. Ask “What is this project about?” or a specific implementation question.
4. Expand the cited passages and check the exact source on GitHub.

Google's consent configuration may restrict sign-in to listed test users until the owner publishes its audience. Provider quotas and Render cold starts can affect availability. The interface reports evidence mode when generation is not configured; a configured model name in health is not proof of a successful model call.

## Run the lightweight app locally

Requires Node.js 22+, Git, and npm (or pnpm).

```sh
git clone --branch feature/render-public-app https://github.com/PrithviHL/rag-over-codebase.git
cd rag-over-codebase
npm run setup
LLM_MODEL="" npm start
```

Open [localhost:3000](http://localhost:3000). This local single-user mode binds to loopback and does not require Google login. `LLM_MODEL=""` selects evidence-only mode explicitly instead of the machine-local defaults in `codeatlas.config.json`.

To use Groq, export `LLM_BASE_URL=https://api.groq.com/openai/v1`, `LLM_MODEL=openai/gpt-oss-20b`, and a private `LLM_API_KEY` before starting. Native `npm start` does not load `.env` automatically. The key stays on the server; questions, selected source excerpts, and limited conversation history are sent to the configured provider. Free-provider quotas apply.

Optional local-model scripts (`run-model.sh`, `start-local.sh`) require separately downloaded llama.cpp-compatible runtime/model files under ignored `.runtime/`; weights are not part of this repository. See `.env.example` for model settings. `./run.sh` can locate the bundled Codex Node runtime on machines where that runtime is installed.

### Web chunking

The web app parses TypeScript/TSX, JavaScript/JSX, Python, Go, Rust, Java, Ruby, C/C++ (using the C++ grammar), shell, and CSS on the server. Declaration chunks retain symbols and exact source line ranges; imports and gaps are included. Large spans split into windows of at most 60 lines / 2,400 characters with overlap. Unsupported formats (including Vue/Svelte) and syntax errors use text windows. Parsers are bundled with the application: no parsing API, extra service, or API key is needed. For named function/class/method requests, source evidence returns the entire AST declaration from the retained commit snapshot, including nested methods and decorators, without the search chunk’s length limit or a four-result cap. Duplicate names return every matching declaration; specify a file or qualified name such as `Auth.authorize` to narrow them. Generic search also expands enclosing declarations when available; fallback text is labelled “Excerpt”. Only the explanation’s model context uses bounded previews. File/repository import limits still apply. Remove and re-import an existing index to enable complete declarations. This does not establish a retrieval-quality improvement.

## Measured web evaluation

A reproducible evaluation of the deployed web pipeline measured **96.6% exact-source recovery (281/291 parser-checked lookups)** across capped Flask, Hono and Express snapshots. On **5,000 CodeSearchNet-derived queries across five languages**, AST chunks + BM25 scored **0.4565 MRR@10**, up **16.2%** over fixed-line chunks in a lexical component ablation. The full web evidence path scored lower (**0.2596 MRR@10**), so this is not an end-to-end hybrid-search improvement. Local retrieval/evidence-selection p95 was **3.59 ms**, excluding HTTP and LLM generation.

[Protocol, complete results, limitations, reproduction commands and resume wording](code/ts/benchmarks/web-evaluation/README.md). These web metrics are separate from the experimental semantic-engine pilot below.

## Local fleet engine

The optional Python engine implements:

- **LangGraph + Groq**, with an optional Claude adapter.
- Python AST and Tree-sitter declaration chunking with bounded long-function chunks.
- Actual Sentence Transformer embeddings, BM25F, Qdrant dense retrieval, rank fusion, and cross-encoder reranking.
- Operator-approved cross-repository search and commit-pinned citations.
- HMAC-signed GitHub push ingestion, a durable job queue, content-hash comparison, and changed-chunk embedding reuse.
- Corpus inventory, pinned-snapshot MRR@10 evaluation, and update-to-search measurement tools.

Follow [engine setup](engine/README.md) for a new machine. On the development machine with its existing database container and installed environment:

```sh
docker start codeatlas-local-qdrant
.runtime/engine-venv/bin/python engine/local.py
```

Open [localhost:3100/fleet](http://localhost:3100/fleet). Qdrant, the private API, and the web app use loopback ports 6434, 8100, and 3100 respectively. Add `GROQ_API_KEY` only to the ignored `engine/.env` for generated answers; retrieval benchmarking requires no chat API. Stop the runner with Ctrl+C and Qdrant with `docker stop codeatlas-local-qdrant`.

### Measured development pilot

Two pinned repositories, **12,027 indexed lines**, and **20 assistant-authored, source-checked development queries**:

| Retrieval | MRR@10 | Median query time |
| --- | ---: | ---: |
| BM25F | 0.0827 | 4.8 ms |
| BM25F + dense fusion | 0.1991 | 15.4 ms |
| Fusion + cross-encoder | 0.1735 | 651.5 ms |

A single signed **local** webhook test made a real 32-file revision update searchable in **5.387 seconds**. It included a Git fetch, 108 new embeddings, and 25 reused embeddings. This was not an actual GitHub-hosted push-delivery measurement or a fleet-scale latency test. The reranker reduced quality relative to fusion alone on this pilot.

These results are not independently judged or held-out. **2M+ LOC, 10+ repositories, MRR 0.61→0.83, and 38-second fleet updates have not been demonstrated.** See [the full report, raw results, and limitations](engine/benchmarks/development/README.md). No paid services were used for the local pilot.

## Render deployment

The public app is a Docker web service at [codeatlas-rag.onrender.com](https://codeatlas-rag.onrender.com), built from the root `Dockerfile`. The health endpoint is [`/api/health`](https://codeatlas-rag.onrender.com/api/health). The free service may sleep, and its filesystem/workspaces are temporary.

Google callback: `https://codeatlas-rag.onrender.com/auth/google/callback`.

Set Google credentials and the Groq key in Render's environment secrets, never Git or browser code. The larger fleet engine needs a separate API/worker/vector-store setup and durable storage; no paid resources are provisioned by these files. [Deployment configuration and troubleshooting](docs/deployment.md) describe the current boundaries.

## Tests

```sh
npm test
npm run typecheck
# With the engine environment installed:
.runtime/engine-venv/bin/python -m pytest engine/tests -q
```

CI checks the Node application and Python engine. The local pilot also exercised real model weights, persistent Qdrant, and a real Git revision update. The separate engine Docker image build previously timed out fetching its base image; do not treat its complete container build as verified by the native tests.

## Repository guide

| Path | Purpose |
| --- | --- |
| `code/ts/src/` | Web API, Google OAuth, lightweight indexing, and private engine proxy |
| `code/ts/public/` | Browser interface and optional Fleet search page |
| `code/ts/tests/` | TypeScript tests |
| `engine/codeatlas_engine/` | Search, LangGraph agent, ingestion, workers, and evaluation |
| `engine/benchmarks/development/` | Retained pilot dataset and actual measurements |
| `engine/local.py` | Native local API, worker, and web runner |
| `compose.yaml` / `compose.engine.yaml` | Lightweight and larger local container profiles |
| `docs/deployment.md` | Hosting, secrets, callbacks, and operational limits |

Local indexes, provider keys, downloaded model weights, and generated secrets are excluded from Git. The original educational scaffold remains available in the repository history and learning materials.
