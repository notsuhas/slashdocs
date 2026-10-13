import type { Actor, Env } from "../env";
import { hashToken, nowSeconds } from "../auth/tokens";
import { principal, type UserRow } from "../auth/middleware";
export const resource = (env: Env) => env.APP_ORIGIN.replace(/\/+$/, "") + "/mcp";
export async function authenticateMCP(
  env: Env,
  request: Request,
): Promise<Actor | null> {
  const authorization = request.headers.get("Authorization") || "";
  if (!/^Bearer /i.test(authorization)) return null;
  const token = authorization.slice(7).trim();
  if (!/^(?:slashdocs_mcp_|slashdocs_sa_|aidocs_sa_)[A-Za-z0-9_-]+$/.test(token))
    return null;
  if (token.startsWith("slashdocs_mcp_")) {
    const row = await env.DB.prepare(
      "SELECT u.id,u.email,u.name,u.picture_url FROM mcp_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.resource=? AND t.scope='mcp' AND t.expires_at>? AND u.provider!='service_account'",
    )
      .bind(await hashToken(token), resource(env), nowSeconds())
      .first<UserRow>();
    return row
      ? {
          principal: principal(row),
          credentialKind: "mcp",
          credentialId: await hashToken(token),
        }
      : null;
  }
  const row = await env.DB.prepare(
    "SELECT sa.id,sa.name,k.id AS credential_id FROM service_account_keys k JOIN service_accounts sa ON sa.id=k.service_account_id WHERE k.token_hash=? AND k.revoked_at IS NULL AND sa.disabled_at IS NULL",
  )
    .bind(await hashToken(token))
    .first<{ id: string; name: string; credential_id: string }>();
  if (!row) return null;
  await env.DB.prepare("UPDATE service_account_keys SET last_used_at=? WHERE id=?")
    .bind(new Date().toISOString(), row.credential_id)
    .run();
  return {
    principal: { type: "service_account", id: row.id, name: row.name },
    credentialKind: "service_account",
    credentialId: row.credential_id,
  };
}
