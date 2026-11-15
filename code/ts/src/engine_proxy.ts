import type { Context } from "hono";
const routes = new Map([
  ["repos", "GET"],
  ["jobs", "GET"],
  ["search", "POST"],
  ["ask", "POST"],
  ["webhooks/github", "POST"],
]);
export async function engineProxy(c: Context): Promise<Response> {
  const path = c.req.path.slice("/api/fleet/".length);
  if (routes.get(path) !== c.req.method)
    return c.json({ error: "Unknown engine route" }, 404);
  if (!process.env.ENGINE_URL || !process.env.ENGINE_API_KEY)
    return c.json(
      { error: "Fleet engine is not configured on this deployment." },
      503,
    );
  const base = new URL(process.env.ENGINE_URL);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password
  )
    return c.json({ error: "Invalid engine configuration" }, 503);
  const headers = new Headers({
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.ENGINE_API_KEY}`,
  });
  for (const name of [
    "x-github-event",
    "x-github-delivery",
    "x-hub-signature-256",
  ]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  try {
    const response = await fetch(
      new URL(path, base.toString().replace(/\/?$/, "/")),
      {
        method: c.req.method,
        headers,
        ...(c.req.method === "POST" ? { body: await c.req.arrayBuffer() } : {}),
        signal: AbortSignal.timeout(120_000),
        redirect: "error",
      },
    );
    const body = await response.text();
    c.header("Content-Type", "application/json");
    c.header("Cache-Control", "no-store");
    return new Response(body, {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return c.json(
      { error: "Fleet engine unavailable. Please try again later." },
      503,
    );
  }
}
