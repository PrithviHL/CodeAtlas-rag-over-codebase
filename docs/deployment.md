# CodeAtlas deployment and operations

## Current public deployment

- Live app: https://codeatlas-rag.onrender.com
- Health: https://codeatlas-rag.onrender.com/api/health
- Source branch: `feature/render-public-app`
- Render service: `codeatlas-rag`, Docker, Ohio, free instance.
- Build: root `Dockerfile`; listen on Render's `PORT` and `HOST=0.0.0.0`.
- Google authentication protects the interface and repository APIs. Health and the login flow are public. The fleet webhook bypasses browser login only at its exact path and requires a valid GitHub HMAC at the engine.

The current public service runs the TypeScript retrieval implementation, configured for Groq `openai/gpt-oss-20b`. It does not run the LangGraph fleet engine. Health describes configuration and process readiness, not model answer accuracy or a successful API-generation round trip.

## Environment settings

| Variable | Purpose |
| --- | --- |
| `PUBLIC_DEMO=true` | Temporary isolated browser workspaces and hosted Google gate |
| `HOST=0.0.0.0` | Public container listener |
| `DATA_DIR=/app/data` | Ephemeral hosted indexes/history |
| `GOOGLE_CLIENT_ID` | Google Web application OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google client secret; Render secret only |
| `LLM_BASE_URL=https://api.groq.com/openai/v1` | Hosted chat endpoint |
| `LLM_MODEL=openai/gpt-oss-20b` | Hosted chat model |
| `LLM_API_KEY` | Groq API credential; Render secret only |
| `ENGINE_URL` / `ENGINE_API_KEY` | Optional private fleet-engine connection; currently not configured |

Render supplies `PORT` and `RENDER_EXTERNAL_HOSTNAME`. No Google cookie-signing secret is required for this Node implementation: its unguessable identity sessions are kept server-side, expire within 24 hours, and are invalidated on restart. Do not set `GOOGLE_AUTH_REQUIRED=false` on the public service unless intentionally removing the access gate.

Create a Google Web application OAuth client. Register JavaScript origin `https://codeatlas-rag.onrender.com` and redirect URI `https://codeatlas-rag.onrender.com/auth/google/callback`. If reusing LeaveNow's client, add this callback without deleting LeaveNow's callback. Test users must be configured while the Google consent audience is in Testing. Public access requires the appropriate Google audience/publishing setup.

After changing secrets, save and deploy. A restart of an old deployment may not apply newly saved settings. No tokens or secrets should appear in Git, logs, screenshots, or frontend configuration. When changing the public hostname, update Google's callback and hosting configuration together.

## Hosted data and access

Only public GitHub repos are imported. Git subprocesses receive no hosting secrets or private Git credentials. Data is separated by browser workspace, not persistent account storage; signing out clears the browser workspace cookie. All source imports are snapshots. Remove and reconnect to refresh the lightweight demo. Hosted indexes/history are deleted on restart/redeployment and expire after an idle hour.

The hosted limits are eight active workspaces, one repository per browser, one import at a time, and 100 files/1 MB indexed per repo. Files over 200 KB and excluded directories are skipped. Clone timeout is two minutes, but transferred Git data is not hard capped. Use small repositories. Cold starts and shared Groq quotas may cause delays; model errors fall back to cited evidence.

## Fleet engine and local development

The local native runner and pilot are documented in [engine setup](../engine/README.md) and [the measured report](../engine/benchmarks/development/README.md). That runner does not depend on Render or a paid provider for retrieval. To generate answers locally, place `GROQ_API_KEY` in ignored `engine/.env` and restart it. Do not copy a secret into documentation.

The fleet deployment needs a private engine API, a single indexing worker, Qdrant, and durable local metadata/mirror storage. SQLite WAL requires a single host; migrate metadata/jobs before scaling across machines. The existing free Render container cannot host all model processes and persist this larger profile. `ENGINE_URL` is not a command to provision services: it must refer to an API that already exists.

## Verification

1. Check `/api/health` returns 200.
2. Open a fresh browser session: the login screen should appear and `/api/repos` should return 401.
3. Complete Google sign-in yourself, confirm the account menu, import a small public repository, and ask a question with citations.
4. Sign out and confirm access is blocked again.
5. For the fleet engine, separately test its private health/API authentication, a signed webhook, worker completion, and retrieval of the actual new commit.

Do not infer a successful user login or successful provider call from the root page or health response alone.
