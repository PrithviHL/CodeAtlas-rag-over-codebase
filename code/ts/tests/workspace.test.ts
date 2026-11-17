import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace, githubURL, readChunks, type Repository } from "../src/workspace.ts";
import { webApp } from "../src/web.ts";

test("GitHub input rejects credential-bearing and non-GitHub URLs", () => {
  assert.equal(githubURL("https://github.com/owner/repo.git"), "https://github.com/owner/repo");
  for (const url of ["http://github.com/a/b", "https://evil.test/a/b", "https://github.com/a/b/tree/main", "https://token@github.com/a/b", "https://github.com/a/b?x=1"]) assert.throws(() => githubURL(url));
});
test("index, query, persistence, deletion and HTTP boundary", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-test-"));
  try {
    const source = path.join(dir, "source"); await fs.mkdir(source);
    await fs.writeFile(path.join(source, "auth.ts"), "export function authorize(token: string) { return token === 'valid'; }\n");
    await fs.writeFile(path.join(source, "README.md"), "# Bus Tracker\nA bus location tracking application that predicts departure times.\n");
    await fs.writeFile(path.join(source, ".env"), "SECRET=do-not-index");
    await fs.writeFile(path.join(source, "binary.ts"), "abc\0def");
    await fs.symlink(path.join(source, "auth.ts"), path.join(source, "link.ts"));
    const chunks = await readChunks(source, "owner/repo");
    assert.equal(chunks.files, 2); assert.equal(chunks.chunks.length, 2);
    const workspace = new Workspace(path.join(dir, "data")); await workspace.load();
    const repo: Repository = { id: "fixture", name: "owner/repo", url: "https://github.com/owner/repo", commit: "abc123", ...chunks, createdAt: new Date().toISOString(), messages: [] };
    await workspace.save(repo);
    const loaded = new Workspace(workspace.dir); await loaded.load();
    const message = await loaded.ask(repo.id, "authorize token");
    assert.equal(message.citations[0].path, "auth.ts"); assert.match(message.citations[0].url, /blob\/abc123\/auth.ts#L1-L1/);
    const overview = await loaded.ask(repo.id, "what is this project about");
    assert.equal(overview.citations[0].path, "README.md");
    const originalFetch = globalThis.fetch, originalModel = process.env.LLM_MODEL;
    try {
      process.env.LLM_MODEL = "test-model";
      globalThis.fetch = async (_input, init) => {
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.model, "test-model");
        assert.match(payload.messages.at(-1).content, /auth.ts/);
        return new Response(JSON.stringify({ choices: [{ message: { content: "Authorization checks the token [1]." } }] }), { headers: { "Content-Type": "application/json" } });
      };
      assert.equal((await loaded.ask(repo.id, "authorize")).answer, "Authorization checks the token [1].");
      globalThis.fetch = async () => new Response("unavailable", { status: 503 });
      assert.match((await loaded.ask(repo.id, "authorize")).answer, /model is unavailable/);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalModel === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = originalModel;
    }
    const missing = await loaded.ask(repo.id, "zzzzunknownterm"); assert.equal(missing.citations.length, 0);
    const reloaded = new Workspace(workspace.dir); await reloaded.load(); assert.equal(reloaded.repos.get(repo.id)?.messages.length, 5);
    const app = webApp(reloaded);
    assert.equal((await app.request("http://localhost/")).status, 200);
    assert.equal((await app.request("http://evil.test/api/repos")).status, 403);
    assert.equal((await app.request("http://localhost/api/repos", { method: "POST", headers: { "Content-Type": "application/json", origin: "https://evil.test" }, body: "{}" })).status, 403);
    assert.equal((await app.request("http://localhost/api/repos/fixture/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "  " }) })).status, 400);
    assert.equal((await app.request("http://localhost/api/repos/fixture/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "authorize" }) })).status, 200);
    assert.equal((await app.request("http://localhost/api/repos/fixture", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 200);
    assert.equal((await app.request("http://localhost/api/repos/fixture/messages")).status, 404);
    const empty = new Workspace(workspace.dir); await empty.load(); assert.equal(empty.list().length, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("nearby AST declarations remain separate evidence with pinned exact lines", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-citations-"));
  try {
    const source = path.join(dir, "source"); await fs.mkdir(source);
    await fs.writeFile(path.join(source, "auth.ts"), "export function authorizeUser() { return true; }\nexport function authorizeAdmin() { return false; }\n");
    const corpus = await readChunks(source, "owner/repo");
    assert.deepEqual(corpus.chunks.map(c => c.symbol), ["authorizeUser", "authorizeAdmin"]);
    const workspace = new Workspace(path.join(dir, "data")); await workspace.load();
    await workspace.save({ id: "ast", name: "owner/repo", url: "https://github.com/owner/repo", commit: "pinned", ...corpus, createdAt: new Date().toISOString(), messages: [] });
    await workspace.load();
    const previous = process.env.LLM_MODEL;
    try {
      process.env.LLM_MODEL = "";
      const message = await workspace.ask("ast", "authorizeUser authorizeAdmin");
      assert.equal(message.citations.length, 2);
      assert.deepEqual(message.citations.map(c => c.startLine).sort(), [1, 2]);
      for (const c of message.citations) assert.equal(c.url, `https://github.com/owner/repo/blob/pinned/auth.ts#L${c.startLine}-L${c.endLine}`);
    } finally {
      if (previous === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = previous;
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("HTTP evidence retains full source after reload while model context stays bounded", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-full-source-"));
  const originalFetch = globalThis.fetch, originalModel = process.env.LLM_MODEL;
  try {
    const source = path.join(dir, "source"); await fs.mkdir(source);
    const body = `export class Worker {\n  run() {\n${Array.from({ length: 200 }, (_, i) => `    const item${i} = "${"x".repeat(30)}";`).join("\n")}\n    return true;\n  }\n}`;
    await fs.writeFile(path.join(source, "worker.ts"), body);
    const corpus = await readChunks(source, "owner/repo");
    const workspace = new Workspace(path.join(dir, "data")); await workspace.load();
    await workspace.save({ id: "full", name: "owner/repo", url: "https://github.com/owner/repo", commit: "pinned", ...corpus, createdAt: new Date().toISOString(), messages: [] });
    const loaded = new Workspace(workspace.dir); await loaded.load();
    assert.ok(!JSON.stringify(loaded.list()).includes("startIndex"));
    assert.ok(!JSON.stringify(loaded.list()).includes("item199"));
    process.env.LLM_MODEL = "test-model";
    globalThis.fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body));
      assert.ok(payload.messages.at(-1).content.length < 4000);
      assert.match(payload.messages.at(-1).content, /partial preview/);
      assert.ok(!payload.messages.at(-1).content.includes("item199"));
      return new Response(JSON.stringify({ choices: [{ message: { content: "The class contains run [1]." } }] }));
    };
    const app = webApp(loaded);
    const response = await app.request("http://localhost/api/repos/full/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "show Worker class" }) });
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.equal(message.citations.length, 1); assert.equal(message.citations[0].body, body);
    assert.equal(message.citations[0].complete, true);
    assert.equal(message.citations[0].url, "https://github.com/owner/repo/blob/pinned/worker.ts#L1-L205");
    const again = new Workspace(workspace.dir); await again.load();
    assert.equal(again.repos.get("full")?.messages[0].citations[0].body, body);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalModel === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = originalModel;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
