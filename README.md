# CodeAtlas — Codebase Q&A

Natural-language exploration of public GitHub codebases with generated explanations and commit-pinned source citations.

**[Open the live Render app](https://codeatlas-rag.onrender.com)**

## Current application

The live app and current implementation are on **[`feature/render-public-app`](https://github.com/PrithviHL/rag-over-codebase/tree/feature/render-public-app)**. This `main` branch retains the earlier educational scaffold. This documentation update does not merge the application source into `main`.

- Google OAuth sign-in, account menu, and sign-out.
- Public GitHub imports into isolated, temporary browser workspaces.
- Groq-generated answers when available, with explicit retrieved-evidence fallback.
- Expandable source excerpts and GitHub citations pinned to the indexed revision.
- Hosted demo limits: one repository per browser and bounded indexing; data expires on restart or after inactivity.

The hosted app uses the lightweight TypeScript retrieval pipeline. The more advanced LangGraph fleet engine has been run locally and is not connected to the Render service. Free-service cold starts, Google audience settings, and provider quotas can affect access.

## Documentation

- [Current README and local setup](https://github.com/PrithviHL/rag-over-codebase/blob/feature/render-public-app/README.md)
- [Render deployment, Google callback, and secrets](https://github.com/PrithviHL/rag-over-codebase/blob/feature/render-public-app/docs/deployment.md)
- [LangGraph fleet engine and Groq configuration](https://github.com/PrithviHL/rag-over-codebase/blob/feature/render-public-app/engine/README.md)
- [Measured local benchmark and raw evidence](https://github.com/PrithviHL/rag-over-codebase/blob/feature/render-public-app/engine/benchmarks/development/README.md)

## Run the current app

Requires Node.js 22+, npm, and Git:

```sh
git clone --branch feature/render-public-app https://github.com/PrithviHL/rag-over-codebase.git
cd rag-over-codebase
npm run setup
LLM_MODEL="" npm start
```

Open http://localhost:3000. This selects local evidence-only mode. For generated answers, follow the server-side Groq setup in the current README. Keep API keys and downloaded models out of Git.

## Measured local engine status

The optional engine implements LangGraph + Groq, AST-aware chunks, BM25F, real embeddings, Qdrant, cross-encoder reranking, and signed incremental GitHub webhook processing.

A **development pilot** covered **12,027 indexed lines across 2 repositories and 20 assistant-authored, source-checked queries**. MRR@10 was 0.0827 for BM25F, 0.1991 for dense fusion, and 0.1735 after reranking. A single signed local update test became searchable in 5.387 seconds. The reranker underperformed fusion alone. These are not independently judged, held-out, production, or fleet-scale results.

**2M+ LOC, 10+ repositories, 0.61→0.83 MRR, and 38-second fleet updates have not been demonstrated.** See the measured report before quoting performance figures.

Share the [live app link](https://codeatlas-rag.onrender.com) for a portfolio or LinkedIn project; link the active source branch for implementation details.
