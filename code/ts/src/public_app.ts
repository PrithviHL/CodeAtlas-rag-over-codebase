import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Workspace } from "./workspace.ts";
import { webApp } from "./web.ts";

// Anonymous, unguessable browser workspaces. No account or login required.
export function publicApp(root: string, host: string): Hono {
  const app = new Hono();
  const sessions = new Map<string, { app: Hono; used: number; active: number; dir: string }>();
  let importing = false;
  app.all("*", async c => {
    if (![host, "localhost", "127.0.0.1"].includes(new URL(c.req.url).hostname)) return c.json({ error: "Unknown host" }, 403);
    c.header("Cache-Control", "no-store");
    if (c.req.path === "/api/health") return c.json({ ok: true, mode: process.env.LLM_MODEL ? "model" : "evidence", model: process.env.LLM_MODEL || null, publicDemo: true });
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (!session.active && now - session.used > 3600_000) {
        sessions.delete(id);
        await fs.rm(session.dir, { recursive: true, force: true });
      }
    }
    let id = getCookie(c, "codeatlas_session");
    let fresh = false;
    if (!id || !sessions.has(id)) {
      if (sessions.size >= 8) return c.json({ error: "The demo is busy. Please try again later." }, 503);
      id = randomBytes(32).toString("hex");
      const dir = path.join(root, id);
      const workspace = new Workspace(dir);
      await workspace.load();
      sessions.set(id, { app: webApp(workspace, host), used: now, active: 0, dir });
      fresh = true;
    }
    const session = sessions.get(id)!;
    const isImport = c.req.method === "POST" && c.req.path === "/api/repos";
    if (isImport && importing) return c.json({ error: "An import is running. Try again shortly." }, 429);
    if (isImport) importing = true;
    session.active++;
    session.used = now;
    try {
      const response = await session.app.fetch(c.req.raw);
      c.res = new Response(response.body, { status: response.status, headers: response.headers });
      c.header("Cache-Control", "no-store");
      if (fresh) setCookie(c, "codeatlas_session", id, { httpOnly: true, secure: host !== "localhost", sameSite: "Lax", path: "/", maxAge: 3600 });
      return c.res;
    }
    finally { session.active--; session.used = Date.now(); if (isImport) importing = false; }
  });
  return app;
}
