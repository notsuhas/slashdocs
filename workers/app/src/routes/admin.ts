import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../../../shared/errors";
import { isAdmin } from "../services/admin";
export const adminRoutes = new Hono<AppEnv>();
adminRoutes.get("/v1/admin/stats", async (c) => {
  if (!isAdmin(c.env, c.get("actor").principal))
    throw new ApiError(403, "forbidden", "Admin access required");
  const now = Date.now();
  const since = (days: number) => new Date(now - days * 86400000).toISOString();
  const stats = await c.env.DB.prepare(
    `SELECT
    (SELECT count(*) FROM users WHERE provider NOT IN ('service_account','placeholder')) AS users,
    (SELECT count(DISTINCT principal_id) FROM admin_activity WHERE is_user=1 AND day>=? AND last_seen>?) AS active_24h,
    (SELECT count(DISTINCT principal_id) FROM admin_activity WHERE is_user=1 AND day>=? AND last_seen>?) AS active_7d,
    (SELECT count(DISTINCT principal_id) FROM admin_activity WHERE is_user=1 AND day>=? AND last_seen>?) AS active_30d,
    (SELECT count(DISTINCT s.user_id) FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.expires_at>? AND u.provider NOT IN ('service_account','placeholder')) AS logged_in_users,
    (SELECT count(*) FROM sessions WHERE expires_at>?) AS sessions,
    (SELECT count(*) FROM documents WHERE deleted_at IS NULL) AS documents,
    v.versions, v.storage_bytes,
    0 AS unknown_size_versions,
    (SELECT count(*) FROM comments c JOIN documents d ON d.id=c.document_id WHERE c.deleted_at IS NULL AND d.deleted_at IS NULL) AS comments,
    (SELECT count(*) FROM service_accounts WHERE disabled_at IS NULL) AS service_accounts,
    (SELECT tracking_started_at FROM admin_metadata WHERE id=1) AS tracking_since
    FROM (SELECT count(*) AS versions,coalesce(sum(v.byte_length),0) AS storage_bytes FROM versions v JOIN documents d ON d.id=v.document_id WHERE d.deleted_at IS NULL) v`,
  )
    .bind(
      since(1).slice(0, 10),
      since(1),
      since(7).slice(0, 10),
      since(7),
      since(30).slice(0, 10),
      since(30),
      Math.floor(now / 1000),
      Math.floor(now / 1000),
    )
    .first();
  if (!stats) throw new ApiError(500, "internal", "Statistics unavailable");
  const daily = await c.env.DB.prepare(
    "SELECT day,sum(requests) AS requests,sum(is_user) AS active_users FROM admin_activity WHERE day>=? GROUP BY day ORDER BY day DESC",
  )
    .bind(since(29).slice(0, 10))
    .all();
  return c.json({ ...stats, daily: daily.results });
});
