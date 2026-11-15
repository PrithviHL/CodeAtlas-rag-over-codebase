import { test } from "node:test";
import assert from "node:assert/strict";
import { googleAuth } from "../src/google_auth.ts";

test("Google gate, browser-bound callback, identity and logout", async () => {
  const before = {
    id: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.GOOGLE_CLIENT_SECRET,
  };
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  try {
    let verifications = 0;
    const app = googleAuth("atlas.test", async (_code, verifier, nonce) => {
      assert.ok(verifier.length > 32);
      assert.ok(nonce.length > 32);
      verifications++;
      return {
        sub: "user1",
        name: "Example User",
        email: "example@example.com",
      };
    });
    assert.match(
      await (await app.request("https://atlas.test/")).text(),
      /Continue with Google/,
    );
    for (const route of [
      "/api/repos",
      "/api/repos/123/messages",
      "/api/account",
    ])
      assert.equal(
        (await app.request(`https://atlas.test${route}`)).status,
        401,
      );
    assert.equal(
      (await app.request("https://atlas.test/api/repos", { method: "POST" }))
        .status,
      401,
    );
    const start = await app.request("https://atlas.test/auth/login");
    const destination = new URL(start.headers.get("location")!);
    assert.equal(destination.hostname, "accounts.google.com");
    assert.equal(
      destination.searchParams.get("redirect_uri"),
      "https://atlas.test/auth/google/callback",
    );
    assert.equal(destination.searchParams.get("code_challenge_method"), "S256");
    const flowCookie = start.headers.getSetCookie()[0].split(";")[0];
    const state = destination.searchParams.get("state");
    const callback = `https://atlas.test/auth/google/callback?code=mock&state=${state}`;
    assert.equal((await app.request(callback)).status, 400);
    assert.equal(verifications, 0);
    const complete = await app.request(callback, {
      headers: { Cookie: flowCookie },
    });
    assert.equal(complete.status, 302);
    assert.equal(verifications, 1);
    const authCookie = complete.headers
      .getSetCookie()
      .find((c) => c.startsWith("codeatlas_auth="))!;
    assert.match(authCookie, /HttpOnly/);
    assert.match(authCookie, /Secure/);
    const headers = { Cookie: authCookie.split(";")[0] };
    const account = await app.request("https://atlas.test/api/account", {
      headers,
    });
    assert.equal((await account.json()).email, "example@example.com");
    assert.equal(
      (await app.request(callback, { headers: { Cookie: flowCookie } })).status,
      400,
    );
    assert.equal(
      (
        await app.request("https://atlas.test/auth/logout", {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request("https://atlas.test/auth/logout", {
          method: "POST",
          headers: { ...headers, Origin: "https://atlas.test" },
        })
      ).status,
      303,
    );
    assert.equal(
      (await app.request("https://atlas.test/api/account", { headers })).status,
      401,
    );
  } finally {
    if (before.id === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = before.id;
    if (before.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = before.secret;
  }
});

test("missing credentials keep the planner closed", async () => {
  const app = googleAuth("atlas.test");
  assert.equal((await app.request("https://atlas.test/")).status, 503);
  assert.equal((await app.request("https://atlas.test/api/repos")).status, 401);
  assert.equal(
    (await app.request("https://atlas.test/auth/login")).status,
    503,
  );
});
