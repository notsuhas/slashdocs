import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../../../shared/errors";
import { hashToken, nowSeconds, sessionToken } from "./tokens";
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
  await checkOrigin(c, async () => {
    const authorization = c.req.header("Authorization");
    if (authorization !== undefined) {
      const match = /^Bearer (slashdocs_cli_[A-Za-z0-9_-]+)$/.exec(authorization);
      if (!match) throw new ApiError(401, "unauthorized", "Invalid credential");
      const row = await c.env.DB.prepare(
        "SELECT u.id,u.email,u.name,u.picture_url,cc.id AS credential_id FROM cli_credentials cc JOIN users u ON u.id=cc.user_id WHERE cc.token_hash=? AND cc.revoked_at IS NULL",
      )
        .bind(await hashToken(match[1]))
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
    } else {
      const token = sessionToken(c);
      if (!token) throw new ApiError(401, "unauthorized", "Authentication required");
      const row = await c.env.DB.prepare(
        "SELECT u.id,u.email,u.name,u.picture_url FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
      )
        .bind(await hashToken(token), nowSeconds())
        .first<UserRow>();
      if (!row) throw new ApiError(401, "unauthorized", "Invalid session");
      c.set("actor", { principal: principal(row), credentialKind: "session" });
    }
    await next();
  });
};
