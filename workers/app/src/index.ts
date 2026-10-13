import { INSTALL_SCRIPT } from "../../shared/install.generated";
import { Hono } from "hono";
import { ZodError } from "zod";
import type { AppEnv } from "./env";
import { ApiError } from "../../shared/errors";
import { authRoutes, requireAuth } from "./routes/auth";
import { observeActivity, pruneAdminObservations } from "./services/admin";
import { adminRoutes } from "./routes/admin";
import { configRoutes } from "./routes/config";
import { documentRoutes } from "./routes/documents";
import { versionRoutes } from "./routes/versions";
import { grantRoutes } from "./routes/grants";
import { commentRoutes } from "./routes/comments";
import { folderRoutes } from "./routes/folders";
import { browseRoutes } from "./routes/browse";
import { stateRoutes } from "./routes/state";
import { serviceAccountRoutes } from "./routes/service-accounts";
export { DocumentSearch } from "./realtime/document-search";
export { DocumentRealtime } from "./realtime/document-realtime";
export { NotificationDelivery } from "./notifications/delivery";
import { createMCPRoutes } from "./mcp";
import { withInternalActor } from "./auth/internal-actor";
import { oidcSettings } from "./auth/oidc";
import { notificationRoutes } from "./routes/notifications";
import { githubRoutes } from "./routes/github";
import { googleGroupRoutes } from "./routes/google-groups";
import { labelRoutes } from "./routes/labels";
import { z } from "zod";
import { activityRateLimit } from "./auth/activity-limit";
export const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  if (!c.res.headers.has("Referrer-Policy")) c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  if (c.req.path.startsWith("/v1/") || c.req.path.startsWith("/.well-known/"))
    c.header("Cache-Control", "private, no-store");
  if (
    c.res.headers.get("Content-Type")?.includes("text/html") &&
    !c.req.path.endsWith("/html") &&
    !c.res.headers.has("Content-Security-Policy")
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
  let loginConfigured = false;
  try {
    const provider = oidcSettings(c.env);
    loginConfigured = !!(provider.clientId && provider.clientSecret);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 503) throw error;
  }
  return c.json({
    status: "ok",
    login_configured: loginConfigured,
  });
});
app.route("/", configRoutes);
app.route("/", authRoutes);
const secured = new Hono<AppEnv>();
secured.use("/v1/*", requireAuth);
secured.use("/v1/*", observeActivity);
const activityLimit = activityRateLimit();
for (const path of [
  "/v1/me/notifications",
  "/v1/documents/:id/notifications",
  "/v1/documents/:id/headings",
  "/v1/documents/:id/link",
])
  secured.on(["GET", "PUT"], path, activityLimit);
secured.post("/v1/documents/:id/access-requests", activityLimit);
secured.post("/v1/documents/:id/presence", activityRateLimit());
secured.route("/", adminRoutes);
secured.route("/", documentRoutes);
secured.route("/", versionRoutes);
secured.route("/", grantRoutes);
secured.route("/", commentRoutes);
secured.route("/", folderRoutes);
secured.route("/", browseRoutes);
secured.route("/", stateRoutes);
secured.route("/", serviceAccountRoutes);
secured.route("/", notificationRoutes);
secured.route("/", githubRoutes);
secured.route("/", googleGroupRoutes);
secured.route("/", labelRoutes);
app.route("/", secured);
const apiDocs = new Hono<AppEnv>();
for (const path of ["/api-docs", "/api-docs/*", "/openapi.json"])
  apiDocs.use(path, requireAuth);
apiDocs.get("/api-docs", (c) => c.redirect("/api-docs/index.html", 302));
apiDocs.get("/api-docs/*", (c) => c.env.ASSETS.fetch(c.req.raw));
apiDocs.get("/openapi.json", (c) => c.env.ASSETS.fetch(c.req.raw));
app.route("/", apiDocs);
app.all("/v1/*", () => {
  throw new ApiError(404, "not_found", "Unknown API route");
});
app.route(
  "/",
  createMCPRoutes((env, actor, request, execution) =>
    withInternalActor(request, actor, async () => app.fetch(request, env, execution)),
  ),
);
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
    await pruneAdminObservations(env);
    if (!env.DOCUMENT_SEARCH)
      throw new Error("Document search binding is not configured");
    const response = await env.DOCUMENT_SEARCH.get(
      env.DOCUMENT_SEARCH.idFromName("maintenance"),
    ).fetch("https://search.internal/index", {
      method: "POST",
      body: JSON.stringify({ after: "" }),
    });
    if (!response.ok) throw new Error("Source metadata backfill failed");
    const indexed = z
      .object({ indexed: z.number(), failed: z.array(z.string()) })
      .parse(await response.json());
    if (indexed.failed.length)
      console.warn(
        JSON.stringify({
          event: "source_index_backfill_failed",
          version_ids: indexed.failed,
        }),
      );
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM mcp_tokens WHERE expires_at<=?").bind(now),
      env.DB.prepare("DELETE FROM mcp_codes WHERE expires_at<=?").bind(now),
      env.DB.prepare("DELETE FROM mcp_consent WHERE expires_at<=?").bind(now),
      env.DB.prepare(
        "DELETE FROM mcp_clients WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM mcp_codes WHERE client_id=mcp_clients.id)",
      ).bind(now),
      env.DB.prepare("DELETE FROM github_oauth_states WHERE expires_at<=?").bind(now),
      env.DB.prepare(
        "DELETE FROM document_events WHERE kind='presence' AND updated_at<?",
      ).bind(new Date(Date.now() - 600000).toISOString()),
    ]);
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
