"""Private search API and HMAC-authenticated GitHub ingestion endpoint."""

from __future__ import annotations
from contextlib import asynccontextmanager
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from .agent import Agent
from .runtime import settings, search_components


class Question(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    repos: list[str] = Field(min_length=1, max_length=50)


def verified_webhook(body: bytes, signature: str, secret: str):
    return bool(secret) and hmac.compare_digest(
        "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest(),
        signature,
    )


def create_app(store=None, search=None, chat=None, catalog=None):
    @asynccontextmanager
    async def lifespan(app):
        if store is None:
            root, specs = settings()
            app.state.store, app.state.search, app.state.chat = search_components(root)
            app.state.catalog = specs
        else:
            app.state.store, app.state.search, app.state.chat, app.state.catalog = (
                store,
                search,
                chat,
                catalog or {},
            )
        yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def access(request, call_next):
        if request.url.path not in {"/health", "/webhooks/github"}:
            expected = os.getenv("ENGINE_API_KEY", "")
            value = request.headers.get("authorization", "")
            if not expected or not secrets.compare_digest(value, "Bearer " + expected):
                from fastapi.responses import JSONResponse

                return JSONResponse({"error": "Unauthorized"}, status_code=401)
        return await call_next(request)

    @app.get("/health")
    def health():
        return {
            "ok": True,
            "engine": "langgraph-hybrid",
            "provider": os.getenv("CHAT_PROVIDER", "groq"),
        }

    @app.get("/repos")
    def repos():
        return app.state.store.repos()

    @app.get("/jobs")
    def jobs():
        return app.state.store.jobs()

    @app.post("/search")
    def search_route(body: Question):
        scope = sorted(set(body.repos))
        if any(r not in app.state.catalog for r in scope):
            raise HTTPException(403, "Repository is not in the approved fleet")
        try:
            return {"results": app.state.search.query(body.question, scope)}
        except ValueError as error:
            raise HTTPException(400, str(error)) from None

    @app.post("/ask")
    def ask(body: Question):
        scope = sorted(set(body.repos))
        if any(r not in app.state.catalog for r in scope):
            raise HTTPException(403, "Repository is not in the approved fleet")
        try:
            return Agent(app.state.search, app.state.chat).ask(body.question, scope)
        except ValueError as error:
            raise HTTPException(400, str(error)) from None

    @app.post("/webhooks/github", status_code=202)
    async def webhook(request: Request):
        received = time.time()
        raw = bytearray()
        async for part in request.stream():
            raw.extend(part)
            if len(raw) > 2_000_000:
                raise HTTPException(413, "Webhook too large")
        if not verified_webhook(
            bytes(raw),
            request.headers.get("x-hub-signature-256", ""),
            os.getenv("GITHUB_WEBHOOK_SECRET", ""),
        ):
            raise HTTPException(401, "Invalid webhook signature")
        event = request.headers.get("x-github-event")
        if event == "ping":
            return {"ok": True}
        if event != "push":
            raise HTTPException(400, "Only push events are supported")
        delivery = request.headers.get("x-github-delivery", "")
        if not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", delivery):
            raise HTTPException(400, "Delivery ID required")
        try:
            payload = json.loads(raw)
            repo = payload["repository"]["full_name"]
            spec = app.state.catalog.get(repo)
            if (
                not spec
                or payload.get("ref") != "refs/heads/" + spec["branch"]
                or spec.get("commit")
            ):
                raise HTTPException(403, "Repository/ref is not approved for updates")
            if payload.get("deleted"):
                return {"ignored": "branch deletion requires operator review"}
            commit = payload["after"]
            if not re.fullmatch("[a-f0-9]{40}", commit):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise HTTPException(400, "Invalid push payload") from None
        job = await run_in_threadpool(
            app.state.store.enqueue, delivery, repo, commit, received
        )
        return {"job_id": job["id"], "status": job["status"]}

    return app


app = create_app()
