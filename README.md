# CodeAtlas — Codebase Q&A

A local web application for exploring GitHub repositories through questions and source evidence. Built with TypeScript, Hono, and a dependency-free browser interface.

## Start

Requires Node.js 22+ and Git. From the repository root:

```sh
npm run setup
npm start
```

On this machine, dependencies are already installed. You can also start with `./run.sh`, which finds the bundled Codex Node runtime if Node is absent from your shell path.

Open http://localhost:3000. Connect a GitHub HTTPS URL, then ask about functions, routes, or technical terms. Expand a source card to read the matching code, or open the exact commit and lines on GitHub. Imports do not execute project code. Private repositories require existing Git credentials; there is no token input in the browser.

If you use pnpm instead, run `pnpm --dir code/ts install --frozen-lockfile` and `pnpm --dir code/ts start`. The checked-in pnpm lockfile pins dependency versions. npm installation resolves the ranges in package.json.

## Local model configured on this machine

Qwen2.5-Coder 1.5B (Q4, about 986 MB) has been downloaded into the ignored `.runtime/` directory. The app reads the non-secret `codeatlas.config.json` for model defaults; environment variables override these defaults. It connects to a local llama.cpp-compatible CPU runner at `http://127.0.0.1:11435/v1`. The runner is included in the official Ollama distribution. CPU mode is used because Metal initialization failed in the current execution environment.

Start the local model and app together with:

```sh
./start-local.sh
```

Or run `./run-model.sh` in one terminal and `./run.sh` in another.  Overview questions prioritize README/project metadata. No API key is required, and question/source context stays local. A small model can still make mistakes; inspect citations.

The runtime and weights are machine-local and are not committed. Other machines can install Ollama, pull `qwen2.5-coder:1.5b`, and set `LLM_BASE_URL=http://localhost:11434/v1` when starting the app. Docker likewise needs an explicitly configured reachable model endpoint.

## Other model configurations

Set `LLM_MODEL=""` to disable generation. Without a model, the app explicitly runs in **local evidence mode** and returns matching passages rather than fabricated explanations. For generated answers, run a model through Ollama or another trusted OpenAI-compatible chat-completions provider, then start with:

```sh
LLM_MODEL=your-installed-model LLM_BASE_URL=http://localhost:11434/v1 npm start
```

For a hosted provider, also set `LLM_API_KEY`. These variables are read on the server; keys are never sent to the browser. Normal npm start does not load .env files automatically: export variables in your shell. The `.env.example` file documents the settings. Docker Compose reads a root `.env` file.

The model receives the question, up to four retrieved passages, and up to the last two generated question/answer pairs. Choosing a hosted endpoint sends that context to that provider. A local endpoint keeps it on your machine. Failed model calls fall back to evidence with a visible notice. Responses are displayed as plain text, with source excerpts kept separately. Model claims and citation numbers should be checked against the source. Ollama protocol reference: https://docs.ollama.com/api/openai-compatibility

## Features

- GitHub repository import with shallow snapshots and commit-pinned citations
- Multiple repository selection and persistent per-repository question history
- Overlapping source chunks; field-weighted BM25 plus deterministic hashed-vector retrieval, fused with reciprocal rank fusion
- Lexical evidence requirement so vector hash collisions alone cannot produce a citation
- Expandable code excerpts, empty states, errors, progress, responsive layout
- Optional model explanations grounded in retrieved passages
- Index deletion, bounded file sizes, hidden-file/symlink/binary/generated-directory exclusion
- Existing sample API retained through `npm --prefix code/ts run demo`

## Validation

```sh
npm test
npm run typecheck
```

The tests cover ranking, input validation, URL restrictions, source indexing, symlink and binary exclusion, evidence/no-match queries, persistence, deletion, and HTTP origin boundaries.

## Docker

```sh
docker compose up --build
```

Visit http://localhost:3000. A named volume persists indexes. Docker is configured for public repositories; private Git credentials are not automatically copied from your host. For a local model running on the host, use `http://host.docker.internal:11434/v1` as the base URL, and ensure that service permits container connections.

## Architecture

```text
Browser → Hono API → Workspace → git clone (temporary checkout)
                       ↓            ↓
                 JSON snapshots   source chunks
                       ↓            ↓
                 question history  BM25 + hash vectors → RRF → citations
                                                           ↓
                                              optional chat-completions model
```

`code/ts/src/workspace.ts` owns ingestion, indexes, retrieval, model calls, and persistence. `web.ts` defines the app API. `app.ts` bridges Node HTTP to Hono. `public/` contains the interface. The original learning materials, sample API, and tests remain available.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | /api/health | Mode and configured model |
| GET | /api/repos | Repository summaries |
| POST | /api/repos | Import `{ "url": "https://github.com/owner/repo" }` |
| GET | /api/repos/:id/messages | Saved question history |
| POST | /api/repos/:id/ask | Ask `{ "question": "Where is authorize defined?" }` |
| DELETE | /api/repos/:id | Remove the local index and history |

## Scope and limits

The default local application is single-user and binds to loopback. `PUBLIC_DEMO=true` enables separate anonymous browser workspaces with no login. Public mode allows the exact Render hostname, up to eight concurrent browsers, one repository per browser, one import at a time, and 100 files / 1 MB indexed per repository. HttpOnly/Secure/SameSite cookies identify browsers. Public GitHub repositories only; Git subprocesses do not receive hosting secrets. Workspaces expire after an idle hour or service restart. Avoid confidential questions in this public demo. Source imports are snapshots: remove and reconnect a repository to refresh it. Data is plaintext JSON under `code/ts/data` when launched through npm from the root, excluded from Git. Back up that directory if needed. Run only one app process against a data directory.

An import indexes up to 1,500 text files / 15 MB total, 200 KB per file, and skips hidden files, symlinks, binaries, common build/vendor directories, and unsupported extensions. Supported extensions are listed in workspace.ts. Skipped-file counts are visible in the UI. Git clones have a two-minute timeout; this does not cap transfer size, so large repositories can still require significant disk space. Dependencies, submodules, and Git LFS content are not installed. Hash vectors are a lightweight lexical approximation, not semantic model embeddings. Large-codebase semantic retrieval and production hosting are future extensions.


## Render public demo

Deploy the root Dockerfile on a free Render web service with `PUBLIC_DEMO=true`, `HOST=0.0.0.0`, `DATA_DIR=/app/data`, and `LLM_MODEL=` (empty). Render supplies `PORT` and `RENDER_EXTERNAL_HOSTNAME`. The health endpoint is `/api/health`. No login or Google OAuth configuration is used. Indexes and questions are stored in isolated temporary browser workspaces and disappear when the service restarts; free services also sleep after inactivity.

The local 1.5B model is not included in the image and cannot run within the free service's memory allowance. The initial public deployment uses explicitly labelled evidence search. To enable generated answers later, configure a reachable OpenAI-compatible endpoint with `LLM_MODEL`, `LLM_BASE_URL`, and a server-only `LLM_API_KEY` in Render's environment settings. Do not commit provider keys. Hosted model calls send retrieved source excerpts and questions to that provider.
