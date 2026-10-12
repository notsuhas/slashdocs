import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import type { Principal, EffectiveAccessItem } from "../../../shared/contracts";
import { newId } from "../../../shared/ids";
import { ApiError } from "../../../shared/errors";
import { requireDocument } from "../services/permissions";
const roleSchema = z.enum(["viewer", "commenter", "editor"]);
interface GrantRow {
  id: string;
  document_id: string;
  principal_type: "user" | "anyone";
  principal_id: string;
  role: "viewer" | "commenter" | "editor";
  granted_by_user_id: string;
}
async function principal(
  env: Env,
  type: "user" | "anyone",
  id: string,
): Promise<Principal> {
  if (type === "anyone") return { type: "anyone", id: "" };
  const user = await env.DB.prepare(
    "SELECT id,email,name,picture_url FROM users WHERE id=?",
  )
    .bind(id)
    .first<{ id: string; email: string; name: string; picture_url: string }>();
  if (!user) throw new ApiError(404, "not_found", "User not found");
  return { type: "user", ...user };
}
async function grantDTO(env: Env, g: GrantRow) {
  return {
    id: g.id,
    document_id: g.document_id,
    resource_type: "document",
    resource_id: g.document_id,
    principal: await principal(env, g.principal_type, g.principal_id),
    role: g.role,
    granted_by: await principal(env, "user", g.granted_by_user_id),
  };
}
export const grantRoutes = new Hono<AppEnv>();
grantRoutes.get("/v1/documents/:id/access", async (c) => {
  const docId = c.req.param("id"),
    { document, role } = await requireDocument(c.env, c.get("actor"), docId, "viewer");
  const source = (r: string, grant?: string) => ({
    resource_type: "document",
    resource_id: docId,
    resource_title: document.title,
    role: r,
    ...(grant ? { grant_id: grant } : {}),
  });
  const items: EffectiveAccessItem[] = [
    {
      principal: await principal(c.env, "user", document.owner_user_id),
      effective_role: "owner",
      sources: [source("owner")],
    },
  ];
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM document_grants WHERE document_id=? ORDER BY id",
  )
    .bind(docId)
    .all<GrantRow>();
  for (const g of results)
    items.push({
      principal: await principal(c.env, g.principal_type, g.principal_id),
      effective_role: g.role,
      sources: [source(g.role, g.id)],
    });
  return c.json({ items, current_role: role });
});
grantRoutes.post("/v1/documents/:id/grants", async (c) => {
  const docId = c.req.param("id"),
    actor = c.get("actor");
  await requireDocument(c.env, actor, docId, "owner");
  const input = z
    .object({
      role: roleSchema,
      address: z.string().optional(),
      principal: z
        .object({
          type: z.enum(["user", "anyone"]),
          id: z.string().optional(),
          email: z.string().optional(),
        })
        .optional(),
    })
    .parse(await c.req.json());
  const type = input.principal?.type ?? "user";
  let id = "";
  if (type === "user") {
    const email = input.address ?? input.principal?.email;
    const user = email
      ? await c.env.DB.prepare("SELECT id FROM users WHERE lower(email)=lower(?)")
          .bind(email)
          .first<{ id: string }>()
      : await c.env.DB.prepare("SELECT id FROM users WHERE id=?")
          .bind(input.principal?.id ?? "")
          .first<{ id: string }>();
    if (!user)
      throw new ApiError(
        400,
        "bad_request",
        "No SlashDocs user exists for that email or id. Ask them to sign in once.",
      );
    id = user.id;
  }
  if (id === actor.principal.id)
    throw new ApiError(400, "bad_request", "Owner already has access");
  const grantId = newId("grt");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO document_grants (id,document_id,principal_type,principal_id,role,granted_by_user_id) SELECT ?,id,?,?,?,? FROM documents WHERE id=? AND owner_user_id=? AND deleted_at IS NULL ON CONFLICT(document_id,principal_type,principal_id) DO UPDATE SET role=excluded.role,granted_by_user_id=excluded.granted_by_user_id",
    ).bind(
      grantId,
      type,
      id,
      input.role,
      actor.principal.id,
      docId,
      actor.principal.id,
    ),
    c.env.DB.prepare(
      "UPDATE documents SET access_revision=access_revision+1 WHERE id=? AND owner_user_id=? AND deleted_at IS NULL",
    ).bind(docId, actor.principal.id),
  ]);
  const g = await c.env.DB.prepare(
    "SELECT * FROM document_grants WHERE document_id=? AND principal_type=? AND principal_id=?",
  )
    .bind(docId, type, id)
    .first<GrantRow>();
  if (!g) throw new ApiError(404, "not_found", "Document not found");
  return c.json(
    {
      id: g.id,
      resource: { type: "document", id: docId },
      principal: await principal(c.env, type, id),
      role: g.role,
      granted_by: { id: actor.principal.id, email: actor.principal.email ?? "" },
    },
    201,
  );
});
grantRoutes.patch("/v1/documents/:id/grants/:grant_id", async (c) => {
  const docId = c.req.param("id"),
    actor = c.get("actor");
  await requireDocument(c.env, actor, docId, "owner");
  const input = z.object({ role: roleSchema }).parse(await c.req.json());
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE document_grants SET role=? WHERE id=? AND document_id=? AND EXISTS (SELECT 1 FROM documents WHERE id=? AND owner_user_id=? AND deleted_at IS NULL)",
    ).bind(input.role, c.req.param("grant_id"), docId, docId, actor.principal.id),
    c.env.DB.prepare(
      "UPDATE documents SET access_revision=access_revision+1 WHERE id=? AND owner_user_id=?",
    ).bind(docId, actor.principal.id),
  ]);
  if (!result[0].meta.changes) throw new ApiError(404, "not_found", "Grant not found");
  const g = await c.env.DB.prepare(
    "SELECT * FROM document_grants WHERE id=? AND document_id=?",
  )
    .bind(c.req.param("grant_id"), docId)
    .first<GrantRow>();
  if (!g) throw new ApiError(404, "not_found", "Grant not found");
  return c.json(await grantDTO(c.env, g));
});
grantRoutes.delete("/v1/documents/:id/grants/:grant_id", async (c) => {
  const docId = c.req.param("id"),
    actor = c.get("actor");
  await requireDocument(c.env, actor, docId, "owner");
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM document_grants WHERE id=? AND document_id=? AND EXISTS (SELECT 1 FROM documents WHERE id=? AND owner_user_id=? AND deleted_at IS NULL)",
    ).bind(c.req.param("grant_id"), docId, docId, actor.principal.id),
    c.env.DB.prepare(
      "UPDATE documents SET access_revision=access_revision+1 WHERE id=? AND owner_user_id=?",
    ).bind(docId, actor.principal.id),
  ]);
  if (!results[0].meta.changes) throw new ApiError(404, "not_found", "Grant not found");
  return c.body(null, 204);
});
