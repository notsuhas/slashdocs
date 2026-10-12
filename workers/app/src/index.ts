import { INSTALL_SCRIPT } from "../../shared/install.generated";
import { Hono } from "hono";
import { ZodError } from "zod";
import type { AppEnv } from "./env";
import { ApiError } from "../../shared/errors";
import { authRoutes, requireAuth } from "./routes/auth";
import { configRoutes } from "./routes/config";
import { documentRoutes } from "./routes/documents";
import { versionRoutes } from "./routes/versions";
import { grantRoutes } from "./routes/grants";
import { commentRoutes } from "./routes/comments";
import { requireDocument, viewerPredicate } from "./services/permissions";
export const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  if (c.req.path.startsWith("/v1/") || c.req.path.startsWith("/.well-known/"))
    c.header("Cache-Control", "private, no-store");
  if (
    c.res.headers.get("Content-Type")?.includes("text/html") &&
    !c.req.path.endsWith("/html")
  )
    c.header(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-src ${new URL(c.env.RENDER_ORIGIN).origin}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
    );
});
app.onError((error) => {
  const parsed =
    error instanceof ApiError
      ? error
      : error instanceof ZodError
        ? new ApiError(400, "bad_request", "Invalid request payload")
        : new ApiError(500, "internal", "Request failed");
  return new Response(
    JSON.stringify({
      error: {
        code: parsed.code,
        message: parsed.message,
        ...(parsed.details === undefined ? {} : { details: parsed.details }),
      },
    }),
    {
      status: parsed.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      },
    },
  );
});
app.get("/livez", (c) => c.json({ status: "ok" }));
app.get("/readyz", async (c) => {
  await c.env.DB.prepare("SELECT 1").first();
  return c.json({
    status: "ok",
    login_configured: !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
  });
});
app.route("/", configRoutes);
app.route("/", authRoutes);
const secured = new Hono<AppEnv>();
secured.use("/v1/*", requireAuth);
secured.route("/", documentRoutes);
secured.route("/", versionRoutes);
secured.route("/", grantRoutes);
secured.route("/", commentRoutes);
secured.get("/v1/folders", (c) => c.json({ items: [], has_more: false }));
secured.get("/v1/featured", (c) => c.json({ items: [] }));
secured.get("/v1/pins", async (c) => {
  const actor = c.get("actor");
  const { results } = await c.env.DB.prepare(
    `SELECT p.resource_type,p.resource_id FROM pins p JOIN documents d ON d.id=p.resource_id WHERE p.user_id=? AND d.deleted_at IS NULL AND ${viewerPredicate}`,
  )
    .bind(actor.principal.id, actor.principal.id, actor.principal.id)
    .all();
  return c.json({ items: results });
});
secured.put("/v1/pins/:resource_type/:resource_id", async (c) => {
  if (c.req.param("resource_type") !== "document")
    throw new ApiError(400, "bad_request", "Only document pins are supported");
  const actor = c.get("actor"),
    id = c.req.param("resource_id");
  await requireDocument(c.env, actor, id, "viewer");
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO pins(user_id,resource_type,resource_id) SELECT ?,'document',d.id FROM documents d WHERE d.id=? AND d.deleted_at IS NULL AND ${viewerPredicate}`,
  )
    .bind(actor.principal.id, id, actor.principal.id, actor.principal.id)
    .run();
  return c.body(null, 204);
});
secured.delete("/v1/pins/:resource_type/:resource_id", async (c) => {
  await c.env.DB.prepare(
    "DELETE FROM pins WHERE user_id=? AND resource_type=? AND resource_id=?",
  )
    .bind(
      c.get("actor").principal.id,
      c.req.param("resource_type"),
      c.req.param("resource_id"),
    )
    .run();
  return c.body(null, 204);
});
secured.get("/v1/documents/:id/kv", async (c) => {
  const id = c.req.param("id");
  await requireDocument(c.env, c.get("actor"), id, "viewer");
  const revision = await c.env.DB.prepare(
    "SELECT revision FROM document_revisions WHERE document_id=?",
  )
    .bind(id)
    .first<{ revision: number }>();
  const { results } = await c.env.DB.prepare(
    "SELECT key,value_json FROM document_kv WHERE document_id=? LIMIT 256",
  )
    .bind(id)
    .all<{ key: string; value_json: string }>();
  return c.json({
    revision: revision?.revision ?? 0,
    items: Object.fromEntries(
      results.map((row) => [row.key, JSON.parse(row.value_json)]),
    ),
  });
});
secured.get("/v1/integrations/github", (c) =>
  c.json({ connected: false, configured: false }),
);
secured.get("/v1/me/notifications", (c) =>
  c.json({ enabled: false, effective_enabled: false }),
);
secured.get("/v1/documents/:id/notifications", async (c) => {
  await requireDocument(c.env, c.get("actor"), c.req.param("id"), "viewer");
  return c.json({ enabled: false, effective_enabled: false });
});
app.route("/", secured);
app.all("/v1/*", () => {
  throw new ApiError(
    501,
    "feature_unavailable",
    "This feature is not available in the Cloudflare foundation release",
  );
});
app.all("/mcp", () => {
  throw new ApiError(
    501,
    "feature_unavailable",
    "Remote MCP is not available in the Cloudflare foundation release",
  );
});
app.get("/install.sh", (c) =>
  c.text(
    INSTALL_SCRIPT.replaceAll("__BASE_URL__", new URL(c.env.APP_ORIGIN).origin),
    200,
    { "Content-Type": "text/x-shellscript", "Cache-Control": "no-store" },
  ),
);
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: AppEnv["Bindings"]) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { results } = await env.DB.prepare(
      "SELECT object_key FROM orphan_objects o WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.object_key=o.object_key) LIMIT 10",
    )
      .bind(cutoff)
      .all<{ object_key: string }>();
    for (const { object_key } of results) {
      await env.DOCUMENTS.delete(object_key);
      await env.DB.prepare("DELETE FROM orphan_objects WHERE object_key=?")
        .bind(object_key)
        .run();
    }
  },
};
