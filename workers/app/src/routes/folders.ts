import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env, Role } from "../env";
import type { Principal } from "../../../shared/contracts";
import { ApiError } from "../../../shared/errors";
import { newId } from "../../../shared/ids";
import {
  createFolder,
  deleteFolder,
  effectiveAccess,
  getFolder,
  listFolderDocuments,
  listFolders,
  moveDocument,
  requireFolder,
  searchFolders,
  updateFolder,
  canonicalPrincipal,
} from "../services/folders";
import { grantInputSchema, resolveGrantPrincipal } from "../services/grant-principals";
import { folderRoleRankSQL } from "../services/permissions";
export const folderRoutes = new Hono<AppEnv>();
const titleSchema = z.string().min(1).max(2000);
folderRoutes.post("/v1/folders", async (c) => {
  const input = z
    .object({ title: titleSchema, parent_folder_id: z.string().optional() })
    .parse(await c.req.json());
  return c.json(
    await createFolder(c.env, c.get("actor"), input.title, input.parent_folder_id),
    201,
  );
});
folderRoutes.get("/v1/folders", async (c) => {
  const query = c.req.query("q");
  if (query) {
    const items = await searchFolders(c.env, c.get("actor"), query);
    return c.json({ folder: null, items, has_more: items.length >= 25 });
  }
  try {
    return c.json(
      await listFolders(
        c.env,
        c.get("actor"),
        c.req.query("folder_id") ?? "",
        c.req.query("path") ?? "",
      ),
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.code === "ambiguous_path" &&
      typeof error.details === "object" &&
      error.details !== null &&
      "candidates" in error.details
    )
      return c.json(
        {
          error: { code: error.code, message: error.message },
          candidates: error.details.candidates,
        },
        409,
      );
    throw error;
  }
});
folderRoutes.get("/v1/folders/:id", async (c) =>
  c.json(await getFolder(c.env, c.get("actor"), c.req.param("id"))),
);
folderRoutes.patch("/v1/folders/:id", async (c) => {
  const input = z
    .object({
      title: z.string().max(2000).optional(),
      parent_folder_id: z.string().nullable().optional(),
    })
    .parse(await c.req.json());
  return c.json(
    await updateFolder(
      c.env,
      c.get("actor"),
      c.req.param("id"),
      input.title,
      input.parent_folder_id,
    ),
  );
});
folderRoutes.delete("/v1/folders/:id", async (c) => {
  await deleteFolder(c.env, c.get("actor"), c.req.param("id"));
  return c.body(null, 204);
});
folderRoutes.get("/v1/folders/:id/access", async (c) => {
  const { role } = await requireFolder(
    c.env,
    c.get("actor"),
    c.req.param("id"),
    "viewer",
  );
  return c.json({
    items: await effectiveAccess(c.env, "folder", c.req.param("id")),
    current_role: role,
  });
});
folderRoutes.get("/v1/folders/:id/documents", async (c) =>
  c.json({
    items: await listFolderDocuments(c.env, c.get("actor"), c.req.param("id")),
  }),
);
folderRoutes.post("/v1/folders/:id/documents", async (c) => {
  const input = z.object({ document_id: z.string().min(1) }).parse(await c.req.json());
  return c.json(
    await moveDocument(c.env, c.get("actor"), input.document_id, c.req.param("id")),
  );
});
folderRoutes.delete("/v1/folders/:id/documents/:doc_id", async (c) => {
  await moveDocument(
    c.env,
    c.get("actor"),
    c.req.param("doc_id"),
    "",
    c.req.param("id"),
  );
  return c.body(null, 204);
});
const grantInput = grantInputSchema;
interface FolderGrantRow {
  id: string;
  folder_id: string;
  principal_type: Principal["type"];
  principal_id: string;
  role: Exclude<Role, "owner">;
  granted_by_type: "user" | "service_account";
  granted_by_id: string;
}
async function grantDTO(env: Env, grant: FolderGrantRow) {
  return {
    id: grant.id,
    resource_type: "folder",
    resource_id: grant.folder_id,
    resource: { type: "folder", id: grant.folder_id },
    principal: await canonicalPrincipal(env, grant.principal_type, grant.principal_id),
    role: grant.role,
    granted_by: await canonicalPrincipal(
      env,
      grant.granted_by_type,
      grant.granted_by_id,
    ),
  };
}
folderRoutes.post("/v1/folders/:id/grants", async (c) => {
  const id = c.req.param("id"),
    actor = c.get("actor");
  await requireFolder(c.env, actor, id, "commenter");
  const input = grantInput.parse(await c.req.json());
  const resolved = await resolveGrantPrincipal(c.env, input);
  const type = resolved.type,
    principalId = resolved.id;
  const grantId = newId("grt");
  const result = await c.env.DB.prepare(
    `INSERT INTO folder_grants(id,folder_id,principal_type,principal_id,role,granted_by_type,granted_by_id) SELECT COALESCE((SELECT grant_id FROM grant_identities WHERE resource_type='folder' AND resource_id=f.id AND principal_type=? AND principal_id=?),?),f.id,?,?,?,?,? FROM folders f CROSS JOIN (SELECT ? AS actor_id) caller WHERE f.id=? AND ${folderRoleRankSQL("f.id", "caller.actor_id", true, c.env)}>=2 ON CONFLICT(folder_id,principal_type,principal_id) DO UPDATE SET role=excluded.role,granted_by_type=excluded.granted_by_type,granted_by_id=excluded.granted_by_id`,
  )
    .bind(
      type,
      principalId,
      grantId,
      type,
      principalId,
      input.role,
      actor.principal.type,
      actor.principal.id,
      actor.principal.id,
      id,
    )
    .run();
  if (!result.meta.changes)
    throw new ApiError(403, "forbidden", "commenter role required");
  const grant = await c.env.DB.prepare(
    "SELECT * FROM folder_grants WHERE folder_id=? AND principal_type=? AND principal_id=?",
  )
    .bind(id, type, principalId)
    .first<FolderGrantRow>();
  if (!grant) throw new ApiError(403, "forbidden", "commenter role required");
  return c.json(await grantDTO(c.env, grant), 201);
});
folderRoutes.patch("/v1/folders/:id/grants/:grant_id", async (c) => {
  const id = c.req.param("id"),
    actor = c.get("actor");
  await requireFolder(c.env, actor, id, "commenter");
  const input = z
    .object({ role: z.enum(["viewer", "commenter", "editor"]) })
    .parse(await c.req.json());
  const result = await c.env.DB.prepare(
    `UPDATE folder_grants SET role=? WHERE id=? AND folder_id=? AND ${folderRoleRankSQL("folder_grants.folder_id", "?", true, c.env)}>=2`,
  )
    .bind(
      input.role,
      c.req.param("grant_id"),
      id,
      actor.principal.id,
      actor.principal.id,
    )
    .run();
  if (!result.meta.changes) throw new ApiError(404, "not_found", "Grant not found");
  const grant = await c.env.DB.prepare(
    "SELECT * FROM folder_grants WHERE id=? AND folder_id=?",
  )
    .bind(c.req.param("grant_id"), id)
    .first<FolderGrantRow>();
  if (!grant) throw new ApiError(404, "not_found", "Grant not found");
  return c.json(await grantDTO(c.env, grant));
});
folderRoutes.delete("/v1/folders/:id/grants/:grant_id", async (c) => {
  const id = c.req.param("id"),
    actor = c.get("actor");
  await requireFolder(c.env, actor, id, "commenter");
  const result = await c.env.DB.prepare(
    `DELETE FROM folder_grants WHERE id=? AND folder_id=? AND ${folderRoleRankSQL("folder_grants.folder_id", "?", true, c.env)}>=2`,
  )
    .bind(c.req.param("grant_id"), id, actor.principal.id, actor.principal.id)
    .run();
  if (!result.meta.changes) throw new ApiError(404, "not_found", "Grant not found");
  return c.body(null, 204);
});
