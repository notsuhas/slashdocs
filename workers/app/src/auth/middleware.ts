import type { Context, MiddlewareHandler } from "hono";
import { internalActor } from "./internal-actor";
import type { AppEnv } from "../env";
import { ApiError } from "../../../shared/errors";
import { hashToken, nowSeconds, sessionToken } from "./tokens";
import { refreshActorGroups } from "../services/groups";
import { safeRedirect } from "./policy";
export type UserRow = { id: string; email: string; name: string; picture_url: string };
export const principal = (row: UserRow) => ({
  type: "user" as const,
  id: row.id,
  email: row.email,
  name: row.name,
  picture_url: row.picture_url,
});
export const checkOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    // Any browser-origin request must come from the app, including bearer requests.
    if (
      (origin && origin !== new URL(c.env.APP_ORIGIN).origin) ||
      (!origin && sessionToken(c))
    )
      throw new ApiError(403, "forbidden", "Invalid request origin");
  }
  await next();
};
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const trusted = internalActor(c.req.raw);
  if (trusted) {
    c.set("actor", await refreshActorGroups(c.env, trusted));
    await recordActivity(c);
    await next();
    return;
  }
  await checkOrigin(c, async () => {
    try {
      const authorization = c.req.header("Authorization");
      if (authorization !== undefined) {
        const match =
          /^Bearer ((?:slashdocs_cli_|slashdocs_sa_|aidocs_sa_)[A-Za-z0-9_-]+)$/i.exec(
            authorization.trimEnd().replace(/^(Bearer) +/i, "$1 "),
          );
        if (!match) throw new ApiError(401, "unauthorized", "Invalid credential");
        const token = match[1];
        if (token.startsWith("slashdocs_sa_") || token.startsWith("aidocs_sa_")) {
          const row = await c.env.DB.prepare(
            "SELECT sa.id,sa.name,k.id AS credential_id FROM service_account_keys k JOIN service_accounts sa ON sa.id=k.service_account_id WHERE k.token_hash=? AND k.revoked_at IS NULL AND sa.disabled_at IS NULL",
          )
            .bind(await hashToken(token))
            .first<{ id: string; name: string; credential_id: string }>();
          if (!row) throw new ApiError(401, "unauthorized", "Invalid credential");
          await c.env.DB.prepare(
            "UPDATE service_account_keys SET last_used_at=? WHERE id=?",
          )
            .bind(new Date().toISOString(), row.credential_id)
            .run();
          c.set("actor", {
            principal: { type: "service_account", id: row.id, name: row.name },
            credentialKind: "service_account",
            credentialId: row.credential_id,
          });
        } else {
          const row = await c.env.DB.prepare(
            "SELECT u.id,u.email,u.name,u.picture_url,cc.id AS credential_id FROM cli_credentials cc JOIN users u ON u.id=cc.user_id WHERE cc.token_hash=? AND cc.revoked_at IS NULL AND u.provider!='service_account'",
          )
            .bind(await hashToken(token))
            .first<UserRow & { credential_id: string }>();
          if (!row) throw new ApiError(401, "unauthorized", "Invalid credential");
          await c.env.DB.prepare("UPDATE cli_credentials SET last_used_at=? WHERE id=?")
            .bind(new Date().toISOString(), row.credential_id)
            .run();
          c.set("actor", {
            principal: principal(row),
            credentialKind: "cli",
            credentialId: row.credential_id,
          });
        }
      } else {
        const token = sessionToken(c);
        if (!token) throw new ApiError(401, "unauthorized", "Authentication required");
        const tokenHash = await hashToken(token);
        const row = await c.env.DB.prepare(
          "SELECT u.id,u.email,u.name,u.picture_url FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.provider!='service_account'",
        )
          .bind(tokenHash, nowSeconds())
          .first<UserRow>();
        if (!row) throw new ApiError(401, "unauthorized", "Invalid session");
        c.set("actor", {
          principal: principal(row),
          credentialKind: "session",
          credentialId: tokenHash,
        });
      }
    } catch (error) {
      // Go redirects unauthenticated HTML navigation through login, retaining
      // the OAuth consent request. API requests and unsafe methods keep 401.
      const accept = c.req.header("Accept") || "";
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        c.req.method === "GET" &&
        accept.includes("text/html") &&
        !accept.includes("application/json")
      ) {
        const url = new URL(c.req.url);
        const requested = url.pathname + url.search;
        const params = new URLSearchParams({
          mode: "web",
          redirect: safeRedirect(requested) ? requested : "/",
        });
        c.res = c.redirect("/v1/auth/google/start?" + params, 302);
        return;
      }
      throw error;
    }
    c.set("actor", await refreshActorGroups(c.env, c.get("actor")));
    await recordActivity(c);
    await next();
  });
};

// Revalidate the exact credential, including session expiry and logout. A user
// row alone cannot establish that the channel's credential is still valid.
export async function revalidateActor(
  env: AppEnv["Bindings"],
  actor: AppEnv["Variables"]["actor"],
): Promise<boolean> {
  if (!actor.credentialId) return false;
  if (actor.principal.type === "service_account") {
    if (actor.credentialKind !== "service_account") return false;
    return !!(await env.DB.prepare(
      "SELECT k.id FROM service_account_keys k JOIN service_accounts sa ON sa.id=k.service_account_id WHERE k.id=? AND sa.id=? AND k.revoked_at IS NULL AND sa.disabled_at IS NULL",
    )
      .bind(actor.credentialId, actor.principal.id)
      .first());
  }
  if (actor.credentialKind === "cli")
    return !!(await env.DB.prepare(
      "SELECT cc.id FROM cli_credentials cc JOIN users u ON u.id=cc.user_id WHERE cc.id=? AND cc.user_id=? AND cc.revoked_at IS NULL AND u.provider!='service_account'",
    )
      .bind(actor.credentialId, actor.principal.id)
      .first());
  if (actor.credentialKind === "session")
    return !!(await env.DB.prepare(
      "SELECT s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.provider!='service_account'",
    )
      .bind(actor.credentialId, actor.principal.id, nowSeconds())
      .first());
  return false;
}

async function recordActivity(c: Context<AppEnv>) {
  if (c.req.path.startsWith("/v1/admin/")) return;
  const user = c.get("actor").principal;
  const now = new Date().toISOString();
  try {
    await c.env.DB.prepare(
      "INSERT INTO admin_activity(day,principal_id,is_user,last_seen) VALUES(?,?,?,?) ON CONFLICT(day,principal_id) DO UPDATE SET requests=requests+1,last_seen=excluded.last_seen",
    )
      .bind(now.slice(0, 10), user.id, user.type === "user" ? 1 : 0, now)
      .run();
  } catch {
    console.error(JSON.stringify({ event: "admin_observation_failed" }));
  }
}
