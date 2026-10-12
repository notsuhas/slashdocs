import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppEnv } from "../env";
import { ApiError, badRequest } from "../../../shared/errors";
import { newId } from "../../../shared/ids";
import { emailAllowed, loopbackRedirectAllowed, safeRedirect } from "../auth/policy";
import {
  cookieName,
  hashToken,
  nowSeconds,
  randomToken,
  sessionToken,
  writeCookie,
} from "../auth/tokens";
import { checkOrigin, principal, requireAuth, type UserRow } from "../auth/middleware";
export { requireAuth } from "../auth/middleware";
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
type StateRow = {
  mode: string;
  redirect: string;
  cli_redirect: string;
  cli_state: string;
  code_challenge: string;
  binding_hash: string;
};
export const authRoutes = new Hono<AppEnv>();
for (const path of ["/v1/auth/*", "/v1/me", "/v1/users"]) {
  authRoutes.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
}
for (const provider of ["google", "oidc"]) {
  authRoutes.get(`/v1/auth/${provider}/start`, async (c) => {
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET)
      throw new ApiError(503, "unavailable", "Login is not configured");
    if (!(c.env.ALLOWED_EMAILS?.trim() || c.env.ALLOWED_DOMAINS?.trim()))
      throw new ApiError(503, "unavailable", "Login policy is not configured");
    const mode = c.req.query("mode") ?? "web";
    const redirect = c.req.query("redirect") ?? "/";
    const cliRedirect = c.req.query("cli_redirect") ?? "";
    const challenge = c.req.query("code_challenge") ?? "";
    const cliState = c.req.query("state") ?? "";
    if (mode !== "web" && mode !== "cli") badRequest("Invalid OAuth mode");
    if (mode === "web" && !safeRedirect(redirect)) badRequest("Invalid redirect");
    if (
      mode === "cli" &&
      (!loopbackRedirectAllowed(cliRedirect) ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        !/^[A-Za-z0-9_-]{16,256}$/.test(cliState))
    )
      badRequest("Invalid CLI OAuth parameters");
    const state = randomToken();
    const binding = randomToken();
    const stateHash = await hashToken(state);
    await c.env.DB.prepare(
      "INSERT INTO oauth_states (state_hash,mode,redirect,cli_redirect,cli_state,code_challenge,binding_hash,expires_at) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind(
        stateHash,
        mode,
        redirect,
        cliRedirect,
        cliState,
        challenge,
        await hashToken(binding),
        nowSeconds() + 600,
      )
      .run();
    writeCookie(c, cookieName(c, `oauth_state_${stateHash}`), binding, 600);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID,
      redirect_uri: `${c.env.APP_ORIGIN}/v1/auth/${provider}/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce: state,
    }).toString();
    return c.redirect(url.toString());
  });
  authRoutes.get(`/v1/auth/${provider}/callback`, async (c) => {
    const state = c.req.query("state") ?? "";
    const stateHash = await hashToken(state);
    const name = cookieName(c, `oauth_state_${stateHash}`);
    const binding = getCookie(c, name);
    writeCookie(c, name, "", 0);
    if (!binding || !state) badRequest("Invalid OAuth state");
    const row = await c.env.DB.prepare(
      "DELETE FROM oauth_states WHERE state_hash=? AND binding_hash=? AND expires_at>? RETURNING *",
    )
      .bind(stateHash, await hashToken(binding), nowSeconds())
      .first<StateRow>();
    if (!row) badRequest("Invalid OAuth state");
    const code = c.req.query("code");
    if (!code || c.req.query("error"))
      throw new ApiError(401, "unauthorized", "Google login failed");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: c.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: c.env.GOOGLE_CLIENT_SECRET ?? "",
        code,
        grant_type: "authorization_code",
        redirect_uri: `${c.env.APP_ORIGIN}/v1/auth/${provider}/callback`,
      }),
    });
    if (!response.ok) throw new ApiError(401, "unauthorized", "Google login failed");
    const body = (await response.json()) as { id_token?: unknown };
    if (typeof body.id_token !== "string")
      throw new ApiError(401, "unauthorized", "Google login failed");
    let identity;
    try {
      identity = (
        await jwtVerify(body.id_token, googleKeys, {
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: c.env.GOOGLE_CLIENT_ID,
          algorithms: ["RS256"],
        })
      ).payload;
    } catch {
      throw new ApiError(401, "unauthorized", "Google login failed");
    }
    if (
      identity.nonce !== state ||
      identity.email_verified !== true ||
      typeof identity.email !== "string" ||
      !identity.sub
    )
      throw new ApiError(401, "unauthorized", "Verified Google email required");
    if (!emailAllowed(identity.email, c.env))
      throw new ApiError(403, "forbidden", "Account is not allowed");
    const userId = `google_${identity.sub}`;
    await c.env.DB.prepare(
      "INSERT INTO users (id,provider,provider_subject,email,name,picture_url,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider,provider_subject) DO UPDATE SET email=excluded.email,name=excluded.name,picture_url=excluded.picture_url",
    )
      .bind(
        userId,
        "google",
        identity.sub,
        identity.email.toLowerCase(),
        typeof identity.name === "string" ? identity.name : identity.email,
        typeof identity.picture === "string" ? identity.picture : "",
        new Date().toISOString(),
      )
      .run();
    if (row.mode === "cli") {
      const cliCode = randomToken();
      await c.env.DB.prepare(
        "INSERT INTO cli_codes (code_hash,user_id,code_challenge,expires_at) VALUES (?,?,?,?)",
      )
        .bind(await hashToken(cliCode), userId, row.code_challenge, nowSeconds() + 120)
        .run();
      const url = new URL(row.cli_redirect);
      url.searchParams.set("code", cliCode);
      url.searchParams.set("state", row.cli_state);
      return c.redirect(url.toString());
    }
    const token = randomToken();
    await c.env.DB.prepare(
      "INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)",
    )
      .bind(await hashToken(token), userId, nowSeconds() + 86400 * 30)
      .run();
    writeCookie(c, cookieName(c), token, 86400 * 30);
    return c.redirect(row.redirect || "/");
  });
}
authRoutes.post("/v1/auth/cli/exchange", checkOrigin, async (c) => {
  if (!c.req.header("Content-Type")?.startsWith("application/json"))
    badRequest("JSON body required");
  const input = (await c.req.json().catch(() => null)) as {
    code?: unknown;
    code_verifier?: unknown;
    name?: unknown;
  } | null;
  if (
    !input ||
    typeof input.code !== "string" ||
    input.code.length > 256 ||
    typeof input.code_verifier !== "string" ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier) ||
    (input.name !== undefined &&
      (typeof input.name !== "string" || input.name.length > 200))
  )
    badRequest("Invalid CLI exchange");
  // Consume even on a wrong verifier, so each authorization code has one attempt.
  const row = await c.env.DB.prepare(
    "DELETE FROM cli_codes WHERE code_hash=? AND expires_at>? RETURNING user_id,code_challenge",
  )
    .bind(await hashToken(input.code), nowSeconds())
    .first<{ user_id: string; code_challenge: string }>();
  if (!row || (await hashToken(input.code_verifier)) !== row.code_challenge)
    throw new ApiError(401, "unauthorized", "Invalid CLI code");
  const token = `slashdocs_cli_${randomToken()}`;
  const id = newId("cli");
  await c.env.DB.prepare(
    "INSERT INTO cli_credentials (id,token_hash,user_id,name,created_at) VALUES (?,?,?,?,?)",
  )
    .bind(
      id,
      await hashToken(token),
      row.user_id,
      input.name || "cli",
      new Date().toISOString(),
    )
    .run();
  const user = await c.env.DB.prepare(
    "SELECT id,email,name,picture_url FROM users WHERE id=?",
  )
    .bind(row.user_id)
    .first<UserRow>();
  return c.json({ id, token, principal: principal(user!) });
});
authRoutes.post("/v1/auth/logout", checkOrigin, async (c) => {
  const token = sessionToken(c);
  if (token)
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(await hashToken(token))
      .run();
  writeCookie(c, cookieName(c), "", 0);
  return c.body(null, 204);
});
authRoutes.get("/v1/me", requireAuth, (c) => {
  const user = c.get("actor").principal;
  return c.json({
    principal: { type: "user", id: user.id },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture_url: user.picture_url,
    },
  });
});
authRoutes.get("/v1/users", requireAuth, async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ items: [] });
  const escaped = q.replace(/[\\%_]/g, "\\$&");
  const rows = await c.env.DB.prepare(
    "SELECT id,email,name,picture_url FROM users WHERE email LIKE ? ESCAPE '\\' COLLATE NOCASE ORDER BY email LIMIT 20",
  )
    .bind(`%${escaped}%`)
    .all<UserRow>();
  return c.json({ items: rows.results.map(principal) });
});
authRoutes.get("/v1/auth/cli/credentials", requireAuth, async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id,name,created_at,last_used_at,revoked_at FROM cli_credentials WHERE user_id=? ORDER BY created_at DESC",
  )
    .bind(c.get("actor").principal.id)
    .all();
  return c.json({ items: rows.results });
});
authRoutes.delete("/v1/auth/cli/credentials/:id", requireAuth, async (c) => {
  await c.env.DB.prepare(
    "UPDATE cli_credentials SET revoked_at=? WHERE id=? AND user_id=?",
  )
    .bind(new Date().toISOString(), c.req.param("id"), c.get("actor").principal.id)
    .run();
  return c.body(null, 204);
});
