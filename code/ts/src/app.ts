import "./config.ts";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { Workspace } from "./workspace.ts";
import { webApp } from "./web.ts";
import { publicApp } from "./public_app.ts";
import path from "node:path";
const workspace = new Workspace(path.resolve(process.env.DATA_DIR || "data"));
await workspace.load();
const app = process.env.PUBLIC_DEMO === "true"
  ? publicApp(workspace.dir, process.env.RENDER_EXTERNAL_HOSTNAME || process.env.PUBLIC_HOST || "localhost")
  : webApp(workspace);
const port = Number(process.env.PORT || 3000);
const server = createServer((req, res) => {
  const parts: Buffer[] = []; let bytes = 0;
  req.on("data", (part: Buffer) => { bytes += part.length; if (bytes > 16384) { res.writeHead(413); res.end(); req.destroy(); } else parts.push(part); });
  req.on("error", () => res.destroy());
  req.on("end", () => { void (async () => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const response = await app.fetch(new Request(`http://${req.headers.host || `localhost:${port}`}${req.url}`, { method: req.method, headers, ...(!["GET", "HEAD"].includes(req.method || "GET") ? { body: Buffer.concat(parts) } : {}) }));
      const responseHeaders = Object.fromEntries(response.headers);
      delete responseHeaders["set-cookie"];
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("Set-Cookie", cookies);
      res.writeHead(response.status, responseHeaders);
      if (response.body) Readable.fromWeb(response.body as never).pipe(res); else res.end();
    } catch { res.writeHead(500); res.end(JSON.stringify({ error: "Internal server error" })); }
  })(); });
});
server.listen(port, process.env.HOST || "127.0.0.1", () => console.log(`CodeAtlas ready at http://localhost:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
