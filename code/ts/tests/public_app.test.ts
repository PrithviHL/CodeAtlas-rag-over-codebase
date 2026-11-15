import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { publicApp } from "../src/public_app.ts";

test("public demo needs no login and isolates browser repository history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-public-"));
  try {
    const app = publicApp(root, "atlas.onrender.com");
    assert.equal((await app.request("https://atlas.onrender.com/")).status, 200);
    const a = await app.request("https://atlas.onrender.com/api/repos");
    const cookie = a.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    const id = cookie.split(";")[0].split("=")[1];
    const repo = { id: "fixture", name: "owner/repo", url: "https://github.com/owner/repo", commit: "abc", chunks: [], files: 1, skipped: 0, createdAt: "now", messages: [{ question: "private-to-this-browser", answer: "test" }] };
    const dir = path.join(root, id);
    await fs.writeFile(path.join(dir, "fixture.json"), JSON.stringify(repo));
    // A second browser cannot see or delete the first browser's stored data.
    const other = publicApp(root, "atlas.onrender.com");
    const b = await other.request("https://atlas.onrender.com/api/repos");
    const otherCookie = b.headers.get("set-cookie")!.split(";")[0];
    assert.notEqual(otherCookie, cookie.split(";")[0]);
    assert.deepEqual(await b.json(), []);
    assert.equal((await other.request("https://atlas.onrender.com/api/repos/fixture/messages", { headers: { Cookie: otherCookie } })).status, 404);
    assert.equal((await app.request("https://evil.test/api/repos")).status, 403);
    assert.equal((await app.request("https://atlas.onrender.com/api/repos", { method: "POST", headers: { Cookie: cookie.split(";")[0], origin: "https://evil.test", "Content-Type": "application/json" }, body: "{}" })).status, 403);
    // The filesystem directory is random rather than derived from user input.
    assert.match(id, /^[a-f0-9]{64}$/);
    assert.ok((await fs.readFile(path.join(dir, "fixture.json"), "utf8")).includes("private-to-this-browser"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
