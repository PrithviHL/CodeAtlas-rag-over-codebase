import { engineProxy } from "./engine_proxy.ts";
import { Hono } from "hono";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { Workspace } from "./workspace.ts";
export function webApp(workspace: Workspace, publicHost?: string): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (
      ![
        "localhost",
        "127.0.0.1",
        "[::1]",
        ...(publicHost ? [publicHost] : []),
      ].includes(host)
    )
      return c.json({ error: "Local access only" }, 403);
    if (!["GET", "HEAD"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (
        origin &&
        origin !== new URL(c.req.url).origin &&
        !(publicHost && origin === `https://${publicHost}`)
      )
        return c.json({ error: "Cross-origin request rejected" }, 403);
      if (!c.req.header("content-type")?.includes("application/json"))
        return c.json({ error: "JSON required" }, 415);
    }
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
  });
  app.onError((err, c) =>
    c.json({ error: err.message || "Request failed" }, 400),
  );
  app.all("/api/fleet/*", engineProxy);
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      mode: process.env.LLM_MODEL ? "model" : "evidence",
      model: process.env.LLM_MODEL || null,
      fleetEngine: Boolean(process.env.ENGINE_URL),
    }),
  );
  app.get("/api/repos", (c) => c.json(workspace.list()));
  app.post("/api/repos", async (c) => {
    const body = await c.req.json();
    if (typeof body.url !== "string" || body.url.length > 300)
      return c.json({ error: "Repository URL required" }, 400);
    const repo = await workspace.import(body.url);
    return c.json({ id: repo.id }, 201);
  });
  app.get("/api/repos/:id/messages", (c) => {
    const repo = workspace.repos.get(c.req.param("id"));
    return repo
      ? c.json(repo.messages)
      : c.json({ error: "Repository not found" }, 404);
  });
  app.delete("/api/repos/:id", async (c) => {
    if (!workspace.repos.has(c.req.param("id")))
      return c.json({ error: "Repository not found" }, 404);
    await workspace.remove(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/repos/:id/ask", async (c) => {
    if (!workspace.repos.has(c.req.param("id")))
      return c.json({ error: "Repository not found" }, 404);
    const body = await c.req.json();
    if (
      typeof body.question !== "string" ||
      !body.question.trim() ||
      body.question.length > 2000
    )
      return c.json(
        { error: "Enter a question between 1 and 2,000 characters" },
        400,
      );
    return c.json(await workspace.ask(c.req.param("id"), body.question.trim()));
  });
  for (const [route, file, type] of [
    ["/", "index.html", "text/html"],
    ["/app.js", "app.js", "text/javascript"],
    ["/style.css", "style.css", "text/css"],
    ["/fleet", "fleet.html", "text/html"],
    ["/fleet.js", "fleet.js", "text/javascript"],
  ]) {
    app.get(route, async (c) => {
      c.header("Content-Type", `${type}; charset=utf-8`);
      return c.body(
        await fs.readFile(
          fileURLToPath(new URL(`../public/${file}`, import.meta.url)),
          "utf8",
        ),
      );
    });
  }
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}
