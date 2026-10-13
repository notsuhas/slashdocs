import { z } from "zod";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../../../shared/errors";
import { isAdmin } from "../services/admin";
export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("/v1/admin/*", async (c, next) => {
  if (!isAdmin(c.env, c.get("actor").principal))
    throw new ApiError(403, "forbidden", "Admin access required");
  await next();
});
adminRoutes.get("/v1/admin/stats", async (c) => {
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

const pageInput = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  q: z.string().max(200).default(""),
});
adminRoutes.get("/v1/admin/users", async (c) => {
  const { page, q } = pageInput.parse(c.req.query());
  const status = z
    .enum(["all", "logged_in", "active"])
    .default("all")
    .parse(c.req.query("status"));
  const now = Math.floor(Date.now() / 1000);
  const active = new Date(Date.now() - 86400000).toISOString();
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const days = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const result = await c.env.DB.prepare(
    `WITH selected AS (
 SELECT u.* FROM users u WHERE provider NOT IN ('service_account','placeholder')
 AND (?='' OR instr(lower(u.email),lower(?))>0 OR instr(lower(u.name),lower(?))>0)
 AND (?<>'logged_in' OR EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.expires_at>?))
 AND (?<>'active' OR EXISTS(SELECT 1 FROM admin_activity a WHERE a.principal_id=u.id AND a.is_user=1 AND a.day>=? AND a.last_seen>?))
 ORDER BY created_at DESC,id DESC LIMIT 26 OFFSET ?)
 SELECT u.id,u.email,u.name,u.picture_url,u.created_at,u.last_login_at,
 (SELECT max(last_seen) FROM admin_activity a WHERE a.principal_id=u.id AND a.is_user=1 AND a.day>=?) AS last_active_at,
 (SELECT count(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at>?) AS sessions,
 (SELECT count(DISTINCT v.document_id) FROM versions v JOIN documents d ON d.id=v.document_id WHERE v.created_by_user_id=u.id AND d.deleted_at IS NULL) AS documents_uploaded,
 (SELECT count(*) FROM versions v JOIN documents d ON d.id=v.document_id WHERE v.created_by_user_id=u.id AND d.deleted_at IS NULL) AS versions_uploaded,
 (SELECT count(*) FROM documents d WHERE d.owner_user_id=u.id AND d.deleted_at IS NULL) AS owned_documents,
 (SELECT coalesce(sum(requests),0) FROM admin_activity a WHERE a.principal_id=u.id AND a.is_user=1 AND a.day>=?) AS requests_30d
 FROM selected u ORDER BY u.created_at DESC,u.id DESC`,
  )
    .bind(
      q,
      q,
      q,
      status,
      now,
      status,
      active.slice(0, 10),
      active,
      (page - 1) * 25,
      cutoff,
      now,
      days,
    )
    .all();
  return c.json({
    items: result.results.slice(0, 25),
    has_more: result.results.length > 25,
  });
});
adminRoutes.get("/v1/admin/users/:id/documents", async (c) => {
  const { page, q } = pageInput.parse(c.req.query());
  const kind = z
    .enum(["uploaded", "owned"])
    .default("uploaded")
    .parse(c.req.query("kind"));
  const id = c.req.param("id");
  const user = await c.env.DB.prepare(
    "SELECT id FROM users WHERE id=? AND provider NOT IN ('service_account','placeholder')",
  )
    .bind(id)
    .first();
  if (!user) throw new ApiError(404, "not_found", "User not found");
  const result = await c.env.DB.prepare(
    `SELECT d.id,d.title,o.id AS owner_id,o.name AS owner_name,o.email AS owner_email,
 min(v.created_at) AS created_at,d.updated_at,
 min(CASE WHEN v.created_by_user_id=? THEN v.created_at END) AS first_upload_at,
 max(CASE WHEN v.created_by_user_id=? THEN v.created_at END) AS last_upload_at,
 sum(v.created_by_user_id=?) AS versions_uploaded,count(*) AS total_versions,
 coalesce(sum(CASE WHEN v.created_by_user_id=? THEN v.byte_length END),0) AS storage_bytes,0 AS unknown_size_versions
 FROM documents d JOIN users o ON o.id=d.owner_user_id JOIN versions v ON v.document_id=d.id
 WHERE d.deleted_at IS NULL AND (?<>'owned' OR d.owner_user_id=?)
 AND (?<>'uploaded' OR EXISTS(SELECT 1 FROM versions own WHERE own.document_id=d.id AND own.created_by_user_id=?))
 AND (?='' OR instr(lower(d.title),lower(?))>0 OR d.id=?)
 GROUP BY d.id,o.id ORDER BY d.updated_at DESC,d.id DESC LIMIT 26 OFFSET ?`,
  )
    .bind(id, id, id, id, kind, id, kind, id, q, q, q, (page - 1) * 25)
    .all();
  return c.json({
    items: result.results.slice(0, 25),
    has_more: result.results.length > 25,
  });
});
