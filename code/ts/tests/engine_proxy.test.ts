import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { engineProxy } from "../src/engine_proxy.ts";
import { googleAuth } from "../src/google_auth.ts";

test("fleet proxy preserves signed bytes and keeps its credential server-side", async () => {
  const before = { url: process.env.ENGINE_URL, key: process.env.ENGINE_API_KEY, fetch: globalThis.fetch };
  process.env.ENGINE_URL = "http://engine:8000"; process.env.ENGINE_API_KEY = "server-test-secret";
  try {
    const app = new Hono();app.all("/api/fleet/*", engineProxy);
    const raw = '{ "ref": "refs/heads/main" }\n';
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), "http://engine:8000/webhooks/github");
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("Authorization"), "Bearer server-test-secret");
      assert.equal(headers.get("x-hub-signature-256"), "sha256=test-signature");
      assert.equal(new TextDecoder().decode(options?.body as ArrayBuffer), raw);
      return Response.json({ status: "queued" }, { status: 202 });
    };
    const response = await app.request("http://localhost/api/fleet/webhooks/github", {method:"POST", headers:{"Content-Type":"application/json","x-hub-signature-256":"sha256=test-signature"}, body:raw});
    assert.equal(response.status,202);
    assert.ok(!(await response.text()).includes("server-test-secret"));
    assert.equal((await app.request("http://localhost/api/fleet/../../health")).status,404);
    const gate = googleAuth("atlas.test");
    assert.equal((await gate.request("https://atlas.test/api/fleet/repos")).status,401);
  } finally {
    globalThis.fetch=before.fetch;
    if(before.url===undefined)delete process.env.ENGINE_URL;else process.env.ENGINE_URL=before.url;
    if(before.key===undefined)delete process.env.ENGINE_API_KEY;else process.env.ENGINE_API_KEY=before.key;
  }
});
