import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";

const token = () => randomBytes(32).toString("hex");
const loginPage = (ready: boolean) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · CodeAtlas</title><link rel="stylesheet" href="/style.css"></head><body><main><div class="eyebrow">CODEATLAS / CODEBASE Q&amp;A</div><h1>Understand your code.<br>Start with Google.</h1><p>Sign in to connect a public GitHub repository and explore its source.</p>${ready ? '<a class="primary" href="/auth/login">Continue with Google →</a>' : "<p>Google sign-in is being configured. Please try again later.</p>"}<p class="footnote">Google shares your name and email with CodeAtlas. No separate password is stored.</p></main></body></html>`;

export type GoogleIdentity = { sub: string; name: string; email: string };
export type GoogleVerifier = (
  code: string,
  verifier: string,
  nonce: string,
) => Promise<GoogleIdentity>;
export function googleAuth(
  host: string,
  verifyOverride?: GoogleVerifier,
): Hono {
  const app = new Hono();
  const secure = host !== "localhost";
  const origin = `${secure ? "https" : "http"}://${host}`;
  const callback = `${origin}/auth/google/callback`;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const ready = Boolean(clientId && clientSecret);
  const client = new OAuth2Client(clientId, clientSecret, callback);
  const flows = new Map<
    string,
    { state: string; nonce: string; verifier: string; expires: number }
  >();
  const sessions = new Map<string, GoogleIdentity & { expires: number }>();
  const cookie = {
    httpOnly: true,
    secure,
    sameSite: "Lax" as const,
    path: "/",
  };
  const verify: GoogleVerifier =
    verifyOverride ||
    (async (code, verifier, nonce) => {
      const { tokens } = await client.getToken({
        code,
        codeVerifier: verifier,
        redirect_uri: callback,
      });
      if (!tokens.id_token) throw new Error("Missing identity");
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: clientId,
      });
      const payload = ticket.getPayload();
      const claims = payload as typeof payload & { nonce?: string };
      if (
        !claims ||
        claims.nonce !== nonce ||
        !claims.sub ||
        !claims.email_verified ||
        !claims.email
      )
        throw new Error("Invalid identity");
      return {
        sub: claims.sub,
        name: claims.name || "Traveler",
        email: claims.email,
      };
    });
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    const now = Date.now();
    for (const [id, flow] of flows) if (flow.expires < now) flows.delete(id);
    for (const [id, session] of sessions)
      if (session.expires < now) sessions.delete(id);
    if (![host, "localhost", "127.0.0.1"].includes(new URL(c.req.url).hostname))
      return c.json({ error: "Unknown host" }, 403);
    if (
      [
        "/api/health",
        "/style.css",
        "/auth/login",
        "/auth/google/callback",
      ].includes(c.req.path)
    )
      return next();
    const session = sessions.get(getCookie(c, "codeatlas_auth") || "");
    if (!session) {
      if (c.req.path.startsWith("/api/") || c.req.path === "/auth/logout")
        return c.json({ error: "Sign in with Google to continue." }, 401);
      return c.html(loginPage(ready), ready ? 200 : 503);
    }
    if (c.req.path === "/api/account")
      return c.json({ name: session.name, email: session.email });
    await next();
  });
  app.get("/auth/login", async (c) => {
    if (!ready) return c.html(loginPage(false), 503);
    if (flows.size >= 100 || sessions.size >= 100)
      return c.text("Sign-in is busy. Try again shortly.", 429);
    const { codeVerifier, codeChallenge } =
      await client.generateCodeVerifierAsync();
    const id = token(),
      state = token(),
      nonce = token();
    flows.set(id, {
      state,
      nonce,
      verifier: codeVerifier,
      expires: Date.now() + 600_000,
    });
    setCookie(c, "codeatlas_oauth", id, { ...cookie, maxAge: 600 });
    return c.redirect(
      client.generateAuthUrl({
        scope: ["openid", "email", "profile"],
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
        prompt: "select_account",
      }),
    );
  });
  app.get("/auth/google/callback", async (c) => {
    const id = getCookie(c, "codeatlas_oauth") || "";
    const flow = flows.get(id);
    flows.delete(id);
    deleteCookie(c, "codeatlas_oauth", cookie);
    if (
      !ready ||
      !flow ||
      flow.state !== c.req.query("state") ||
      flow.expires < Date.now() ||
      !c.req.query("code") ||
      c.req.query("error")
    )
      return c.text(
        "Sign-in could not be completed. Return to CodeAtlas and try again.",
        400,
      );
    try {
      const user = await verify(
        c.req.query("code")!,
        flow.verifier,
        flow.nonce,
      );
      const old = getCookie(c, "codeatlas_auth");
      if (old) sessions.delete(old);
      const session = token();
      sessions.set(session, { ...user, expires: Date.now() + 86400_000 });
      setCookie(c, "codeatlas_auth", session, { ...cookie, maxAge: 86400 });
      // Do not let another Google identity inherit this browser's old repository history.
      deleteCookie(c, "codeatlas_session", cookie);
      return c.redirect("/");
    } catch {
      return c.text(
        "Google sign-in failed. Please return to CodeAtlas and try again.",
        400,
      );
    }
  });
  app.post("/auth/logout", (c) => {
    if (c.req.header("origin") !== origin)
      return c.json({ error: "Cross-origin request rejected" }, 403);
    sessions.delete(getCookie(c, "codeatlas_auth") || "");
    deleteCookie(c, "codeatlas_auth", cookie);
    deleteCookie(c, "codeatlas_session", cookie);
    return c.redirect("/", 303);
  });
  return app;
}
