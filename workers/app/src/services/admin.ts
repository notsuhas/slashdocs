import type { Env } from "../env";
import type { Principal } from "../../../shared/contracts";
export function isAdmin(env: Env, user: Principal): boolean {
  return (
    user.type === "user" &&
    !!user.email &&
    (env.ADMIN_USERS ?? "")
      .split(",")
      .some((email) => email.trim().toLowerCase() === user.email?.toLowerCase())
  );
}

import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

export function countAdminOperation(path: string, status: number): boolean {
  return (
    status !== 429 &&
    !path.startsWith("/v1/admin/") &&
    !path.endsWith("/presence") &&
    !path.endsWith("/kv/events")
  );
}

export const observeActivity: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (!countAdminOperation(c.req.path, c.res.status)) return;
  const user = c.get("actor").principal;
  const now = new Date().toISOString();
  const operation = c.env.DB.prepare(
    "INSERT INTO admin_activity(day,principal_id,is_user,last_seen) VALUES(?,?,?,?) ON CONFLICT(day,principal_id) DO UPDATE SET requests=requests+1,last_seen=max(last_seen,excluded.last_seen)",
  )
    .bind(now.slice(0, 10), user.id, user.type === "user" ? 1 : 0, now)
    .run()
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "admin_observation_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  // Real Worker requests always provide an execution context. In-process Hono
  // callers (tests, MCP dispatch) await the same work when none is supplied.
  let execution: Context<AppEnv>["executionCtx"] | undefined;
  try {
    execution = c.executionCtx;
  } catch {
    /* In-process caller. */
  }
  if (execution) execution.waitUntil(operation);
  else await operation;
};

export async function pruneAdminObservations(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_activity WHERE day<?").bind(cutoff),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(
      Math.floor(Date.now() / 1000),
    ),
    env.DB.prepare("UPDATE admin_metadata SET last_cleanup_day=? WHERE id=1").bind(
      new Date().toISOString().slice(0, 10),
    ),
  ]);
}
