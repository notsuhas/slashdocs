import { isAdmin } from "../services/admin";
import { z } from "zod";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  oidcProvider,
  exchangeIdentity,
  identityKeys,
  GOOGLE_ISSUER,
} from "../auth/oidc";
import type { AppEnv } from "../env";
import { ApiError, badRequest } from "../../../shared/errors";
import { newId } from "../../../shared/ids";
import { emailAllowed, safeRedirect } from "../auth/policy";
import {
  cookieName,
  hashToken,
  nowSeconds,
  randomToken,
  sessionToken,
  writeCookie,
} from "../auth/tokens";
import {
  checkOrigin,
  principal,
  requireObservedAuth,
  type UserRow,
} from "../auth/middleware";
export { requireAuth } from "../auth/middleware";
type StateRow = {
  mode: string;
  redirect: string;
  cli_redirect: string;
  cli_state: string;
  code_challenge: string;
  binding_hash: string;
};
// Match Go's OAuth handler: CLI callbacks may use any HTTP path or port on
// localhost or 127.0.0.1. Browser redirects retain their separate validation.
function loopbackRedirectAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
export const authRoutes = new Hono<AppEnv>();
for (const path of ["/v1/auth/*", "/v1/me", "/v1/users"]) {
  authRoutes.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
}
for (const provider of ["google", "oidc"]) {
  authRoutes.get(`/v1/auth/${provider}/start`, async (c) => {
    const configured = await oidcProvider(c.env);
    if (!(c.env.ALLOWED_EMAILS?.trim() || c.env.ALLOWED_DOMAINS?.trim()))
      throw new ApiError(503, "unavailable", "Login policy is not configured");
    const mode = c.req.query("mode") ?? "web";
    const redirect = c.req.query("redirect") ?? "/";
    const cliRedirect = c.req.query("cli_redirect") ?? "";
    const challenge = c.req.query("code_challenge") ?? "";
    const cliState = c.req.query("state") || randomToken();
    if (mode !== "web" && mode !== "cli") badRequest("Invalid OAuth mode");
    if (mode === "web" && !safeRedirect(redirect)) badRequest("Invalid redirect");
    if (mode === "cli" && (!loopbackRedirectAllowed(cliRedirect) || !challenge))
      badRequest("Invalid CLI OAuth parameters");
    const state = mode === "cli" ? cliState : randomToken();
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
    if (mode === "web")
      writeCookie(c, cookieName(c, `oauth_state_${stateHash}`), binding, 600);
    const url = new URL(configured.authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: configured.clientId,
      redirect_uri: `${c.env.APP_ORIGIN}/v1/auth/${configured.issuer === GOOGLE_ISSUER ? "google" : "oidc"}/callback`,
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
    if (!state) badRequest("Invalid OAuth state");
    const row = await c.env.DB.prepare(
      "DELETE FROM oauth_states WHERE state_hash=? AND (mode='cli' OR (mode='web' AND binding_hash=?)) AND expires_at>? RETURNING *",
    )
      .bind(stateHash, await hashToken(binding || ""), nowSeconds())
      .first<StateRow>();
    if (!row) badRequest("Invalid OAuth state");
    const code = c.req.query("code");
    if (!code || c.req.query("error"))
      throw new ApiError(401, "unauthorized", "Google login failed");
    const configured = await oidcProvider(c.env);
    const identity = await exchangeIdentity(
      configured,
      code,
      `${c.env.APP_ORIGIN}/v1/auth/${configured.issuer === GOOGLE_ISSUER ? "google" : "oidc"}/callback`,
      state,
    );
    if (!emailAllowed(identity.email, c.env))
      throw new ApiError(403, "forbidden", "Account is not allowed");
    const keys = await identityKeys(configured.issuer, identity.sub);
    const email = identity.email.toLowerCase();
    const displayName = identity.name || identity.email;
    const picture = identity.picture || "";
    // Claim only the still-unclaimed row. The batch serializes this claim with
    // fallback creation, and a lost claim never changes the winning identity.
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE users SET provider=?,provider_subject=?,email=?,name=?,picture_url=? WHERE id=(SELECT id FROM users WHERE provider='placeholder' AND email=? COLLATE NOCASE LIMIT 1) AND provider='placeholder' AND email=? COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM users WHERE provider=? AND provider_subject=?)",
      ).bind(
        keys.provider,
        keys.subject,
        email,
        displayName,
        picture,
        email,
        email,
        keys.provider,
        keys.subject,
      ),
      c.env.DB.prepare(
        "INSERT INTO users (id,provider,provider_subject,email,name,picture_url,created_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM users WHERE provider=? AND provider_subject=?) ON CONFLICT(provider,provider_subject) DO UPDATE SET email=excluded.email,name=excluded.name,picture_url=excluded.picture_url",
      ).bind(
        keys.id,
        keys.provider,
        keys.subject,
        email,
        displayName,
        picture,
        new Date().toISOString(),
        keys.provider,
        keys.subject,
      ),
      c.env.DB.prepare(
        "UPDATE users SET email=?,name=?,picture_url=?,last_login_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE provider=? AND provider_subject=?",
      ).bind(email, displayName, picture, keys.provider, keys.subject),
    ]);
    const user = await c.env.DB.prepare(
      "SELECT id FROM users WHERE provider=? AND provider_subject=?",
    )
      .bind(keys.provider, keys.subject)
      .first<{ id: string }>();
    if (!user)
      throw new ApiError(401, "unauthorized", "Identity could not be persisted");
    const userId = user.id;
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
  const parsed = z
    .object({
      code: z.string().min(1),
      code_verifier: z.string().min(1),
      name: z.string().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) badRequest("Invalid CLI exchange");
  const input = parsed.data;
  // Consume even on a wrong verifier, so each authorization code has one attempt.
  const row = await c.env.DB.prepare(
    "DELETE FROM cli_codes WHERE code_hash=? AND expires_at>? RETURNING user_id,code_challenge",
  )
    .bind(await hashToken(input.code), nowSeconds())
    .first<{ user_id: string; code_challenge: string }>();
  if (!row || (await hashToken(input.code_verifier)) !== row.code_challenge)
    throw new ApiError(401, "unauthorized", "Invalid CLI code");
  const user = await c.env.DB.prepare(
    "SELECT id,email,name,picture_url FROM users WHERE id=? AND provider!='service_account'",
  )
    .bind(row.user_id)
    .first<UserRow>();
  if (!user) throw new ApiError(401, "unauthorized", "Invalid CLI code");
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
  return c.json({ id, token, principal: principal(user) });
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
authRoutes.get("/v1/me", requireObservedAuth, async (c) => {
  const user = c.get("actor").principal;
  if (user.type === "service_account") {
    const account = await c.env.DB.prepare(
      "SELECT sa.id,sa.name,sa.disabled_at,u.id AS owner_id,u.email AS owner_email,u.name AS owner_name FROM service_accounts sa JOIN users u ON u.id=sa.owner_user_id WHERE sa.id=?",
    )
      .bind(user.id)
      .first<{
        id: string;
        name: string;
        disabled_at: string | null;
        owner_id: string;
        owner_email: string;
        owner_name: string;
      }>();
    if (!account) throw new ApiError(401, "unauthorized", "Invalid service account");
    return c.json({
      principal: { type: user.type, id: user.id },
      service_account: {
        id: account.id,
        name: account.name,
        disabled: account.disabled_at !== null,
        owner: {
          id: account.owner_id,
          email: account.owner_email,
          name: account.owner_name,
        },
      },
    });
  }
  return c.json({
    ...(isAdmin(c.env, user) ? { is_admin: true } : {}),
    principal: { type: user.type, id: user.id },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture_url: user.picture_url,
    },
  });
});
authRoutes.get("/v1/users", requireObservedAuth, async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ items: [] });
  const escaped = q.replace(/[\\%_]/g, "\\$&");
  const rows = await c.env.DB.prepare(
    "SELECT id,email,name,picture_url FROM users WHERE provider!='service_account' AND email LIKE ? ESCAPE '\\' COLLATE NOCASE ORDER BY email LIMIT 20",
  )
    .bind(`%${escaped}%`)
    .all<UserRow>();
  return c.json({ items: rows.results.map(principal) });
});
authRoutes.get("/v1/auth/cli/credentials", requireObservedAuth, async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id,name,created_at,last_used_at,revoked_at FROM cli_credentials WHERE user_id=? ORDER BY created_at DESC",
  )
    .bind(c.get("actor").principal.id)
    .all();
  return c.json({ items: rows.results });
});
authRoutes.delete("/v1/auth/cli/credentials/:id", requireObservedAuth, async (c) => {
  await c.env.DB.prepare(
    "UPDATE cli_credentials SET revoked_at=? WHERE id=? AND user_id=?",
  )
    .bind(new Date().toISOString(), c.req.param("id"), c.get("actor").principal.id)
    .run();
  return c.body(null, 204);
});
