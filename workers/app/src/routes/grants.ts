import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env, Role } from "../env";
import type { Principal } from "../../../shared/contracts";
import { newId } from "../../../shared/ids";
import { ApiError } from "../../../shared/errors";
import { requireDocument, commenterPredicateFor } from "../services/permissions";
import { effectiveAccess } from "../services/folders";
import {
  canonicalGrantPrincipal,
  grantInputSchema,
  resolveGrantPrincipal,
} from "../services/grant-principals";
import {
  snapshotGrantNotificationStatements,
  captureNotificationMutation,
  queuedGrantNotificationStatements,
  clearNotificationMutation,
  wakeNotificationDelivery,
} from "../services/notifications";

async function wakeGrantNotifications(env: Env) {
  await wakeNotificationDelivery(env).catch(() => {
    console.warn(
      JSON.stringify({ event: "notification_wake_failed", source: "document_grant" }),
    );
  });
}
interface GrantRow {
  id: string;
  document_id: string;
  principal_type: Principal["type"];
  principal_id: string;
  role: Exclude<Role, "owner">;
  granted_by_user_id: string;
}
async function grantDTO(env: Env, g: GrantRow) {
  const by = await env.DB.prepare("SELECT provider FROM users WHERE id=?")
    .bind(g.granted_by_user_id)
    .first<{ provider: string }>();
  return {
    id: g.id,
    document_id: g.document_id,
    resource_type: "document",
    resource_id: g.document_id,
    principal: await canonicalGrantPrincipal(env, g.principal_type, g.principal_id),
    role: g.role,
    granted_by: await canonicalGrantPrincipal(
      env,
      by?.provider === "service_account" ? "service_account" : "user",
      g.granted_by_user_id,
    ),
  };
}
export const grantRoutes = new Hono<AppEnv>();
grantRoutes.get("/v1/documents/:id/access", async (c) => {
  const id = c.req.param("id");
  const { role } = await requireDocument(c.env, c.get("actor"), id, "viewer");
  return c.json({
    items: await effectiveAccess(c.env, "document", id),
    current_role: role,
  });
});
grantRoutes.post("/v1/documents/:id/grants", async (c) => {
  const id = c.req.param("id"),
    actor = c.get("actor");
  await requireDocument(c.env, actor, id, "commenter");
  const input = grantInputSchema.parse(await c.req.json()),
    principal = await resolveGrantPrincipal(c.env, input);
  const token = newId("nmt");
  const snapshots = snapshotGrantNotificationStatements(c.env, id, principal, token);
  const casIndex = snapshots.length;
  const result = await c.env.DB.batch([
    ...snapshots,
    c.env.DB.prepare(
      `INSERT INTO document_grants(id,document_id,principal_type,principal_id,role,granted_by_user_id) SELECT COALESCE((SELECT grant_id FROM grant_identities WHERE resource_type='document' AND resource_id=d.id AND principal_type=? AND principal_id=?),?),d.id,?,?,?,? FROM documents d WHERE d.id=? AND d.deleted_at IS NULL AND ${commenterPredicateFor(c.env)} ON CONFLICT(document_id,principal_type,principal_id) DO UPDATE SET role=excluded.role,granted_by_user_id=excluded.granted_by_user_id`,
    ).bind(
      principal.type,
      principal.id,
      newId("grt"),
      principal.type,
      principal.id,
      input.role,
      actor.principal.id,
      id,
      actor.principal.id,
      actor.principal.id,
    ),
    captureNotificationMutation(c.env, token),
    c.env.DB.prepare(
      "UPDATE documents SET access_revision=access_revision+1 WHERE id=? AND EXISTS(SELECT 1 FROM notification_mutation_guards WHERE token=? AND allowed>0)",
    ).bind(id, token),
    ...queuedGrantNotificationStatements(c.env, actor.principal, token),
    ...clearNotificationMutation(c.env, token),
  ]);
  if (!result[casIndex].meta.changes)
    throw new ApiError(403, "forbidden", "commenter role required");
  await wakeGrantNotifications(c.env);
  const grant = await c.env.DB.prepare(
    "SELECT * FROM document_grants WHERE document_id=? AND principal_type=? AND principal_id=?",
  )
    .bind(id, principal.type, principal.id)
    .first<GrantRow>();
  if (!grant) throw new ApiError(404, "not_found", "Grant not found");
  return c.json(
    {
      id: grant.id,
      resource: { type: "document", id },
      principal,
      role: grant.role,
      granted_by: { id: actor.principal.id, email: actor.principal.email ?? "" },
    },
    201,
  );
});
grantRoutes.patch("/v1/documents/:id/grants/:grant_id", async (c) => {
  const id = c.req.param("id"),
    actor = c.get("actor");
  await requireDocument(c.env, actor, id, "commenter");
  const input = z
    .object({ role: z.enum(["viewer", "commenter", "editor"]) })
    .parse(await c.req.json());
  const storedGrant = await c.env.DB.prepare(
    "SELECT * FROM document_grants WHERE id=? AND document_id=?",
  )
    .bind(c.req.param("grant_id"), id)
    .first<GrantRow>();
  if (!storedGrant) throw new ApiError(404, "not_found", "Grant not found");
  const principal = await canonicalGrantPrincipal(
    c.env,
    storedGrant.principal_type,
    storedGrant.principal_id,
  );
  const token = newId("nmt");
  const snapshots = snapshotGrantNotificationStatements(c.env, id, principal, token);
  const casIndex = snapshots.length;
  const result = await c.env.DB.batch([
    ...snapshots,
    c.env.DB.prepare(
      `UPDATE document_grants SET role=? WHERE id=? AND document_id=? AND EXISTS(SELECT 1 FROM documents d WHERE d.id=document_grants.document_id AND d.deleted_at IS NULL AND ${commenterPredicateFor(c.env)})`,
    ).bind(
      input.role,
      c.req.param("grant_id"),
      id,
      actor.principal.id,
      actor.principal.id,
    ),
    captureNotificationMutation(c.env, token),
    c.env.DB.prepare(
      "UPDATE documents SET access_revision=access_revision+1 WHERE id=? AND EXISTS(SELECT 1 FROM notification_mutation_guards WHERE token=? AND allowed>0)",
    ).bind(id, token),
    ...queuedGrantNotificationStatements(c.env, actor.principal, token),
    ...clearNotificationMutation(c.env, token),
  ]);
  if (!result[casIndex].meta.changes)
    throw new ApiError(404, "not_found", "Grant not found");
  await wakeGrantNotifications(c.env);
  const grant = await c.env.DB.prepare(
    "SELECT * FROM document_grants WHERE id=? AND document_id=?",
  )
    .bind(c.req.param("grant_id"), id)
    .first<GrantRow>();
  if (!grant) throw new ApiError(404, "not_found", "Grant not found");
  return c.json(await grantDTO(c.env, grant));
});
grantRoutes.delete("/v1/documents/:id/grants/:grant_id", async (c) => {
  const id = c.req.param("id"),
    actor = c.get("actor");
  await requireDocument(c.env, actor, id, "commenter");
  const storedGrant = await c.env.DB.prepare(
    "SELECT * FROM document_grants WHERE id=? AND document_id=?",
  )
    .bind(c.req.param("grant_id"), id)
    .first<GrantRow>();
  if (!storedGrant) throw new ApiError(404, "not_found", "Grant not found");
  const principal = await canonicalGrantPrincipal(
    c.env,
    storedGrant.principal_type,
    storedGrant.principal_id,
  );
  const token = newId("nmt");
  const snapshots = snapshotGrantNotificationStatements(c.env, id, principal, token);
  const casIndex = snapshots.length;
  const result = await c.env.DB.batch([
    ...snapshots,
    c.env.DB.prepare(
      `DELETE FROM document_grants WHERE id=? AND document_id=? AND EXISTS(SELECT 1 FROM documents d WHERE d.id=document_grants.document_id AND d.deleted_at IS NULL AND ${commenterPredicateFor(c.env)})`,
    ).bind(c.req.param("grant_id"), id, actor.principal.id, actor.principal.id),
    captureNotificationMutation(c.env, token),
    c.env.DB.prepare(
      "UPDATE documents SET access_revision=access_revision+1 WHERE id=? AND EXISTS(SELECT 1 FROM notification_mutation_guards WHERE token=? AND allowed>0)",
    ).bind(id, token),
    ...queuedGrantNotificationStatements(c.env, actor.principal, token),
    ...clearNotificationMutation(c.env, token),
  ]);
  if (!result[casIndex].meta.changes)
    throw new ApiError(404, "not_found", "Grant not found");
  await wakeGrantNotifications(c.env);
  return c.body(null, 204);
});
