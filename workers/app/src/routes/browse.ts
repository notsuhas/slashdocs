import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import type { FeaturedSection, FolderEntry } from "../../../shared/contracts";
import { ApiError } from "../../../shared/errors";
import { groupMembershipUnavailable } from "../services/groups";
import {
  folderDTO,
  folderDocumentDTO,
  requireFolder,
  type FolderRow,
} from "../services/folders";
import {
  folderRoleRankSQL,
  requireDocument,
  viewerPredicateFor,
  type DocumentRow,
} from "../services/permissions";
export const browseRoutes = new Hono<AppEnv>();
browseRoutes.get("/v1/pins", async (c) => {
  const actor = c.get("actor");
  const { results } = await c.env.DB.prepare(
    `SELECT p.resource_type,p.resource_id FROM pins p JOIN documents d ON d.id=p.resource_id AND p.resource_type='document' WHERE p.user_id=? AND d.deleted_at IS NULL AND ${viewerPredicateFor(c.env)} UNION ALL SELECT p.resource_type,p.resource_id FROM pins p JOIN folders f ON f.id=p.resource_id AND p.resource_type='folder' CROSS JOIN (SELECT ? AS actor_id) caller WHERE p.user_id=caller.actor_id AND ${folderRoleRankSQL("f.id", "caller.actor_id", true, c.env)}>=1`,
  )
    .bind(
      actor.principal.id,
      actor.principal.id,
      actor.principal.id,
      actor.principal.id,
    )
    .all();
  return c.json({ items: results });
});
browseRoutes.put("/v1/pins/:resource_type/:resource_id", async (c) => {
  const type = z.enum(["document", "folder"]).parse(c.req.param("resource_type")),
    id = c.req.param("resource_id"),
    actor = c.get("actor");
  if (type === "document") {
    await requireDocument(c.env, actor, id, "viewer");
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO pins(user_id,resource_type,resource_id) SELECT ?,'document',d.id FROM documents d WHERE d.id=? AND d.deleted_at IS NULL AND ${viewerPredicateFor(c.env)}`,
    )
      .bind(actor.principal.id, id, actor.principal.id, actor.principal.id)
      .run();
  } else {
    await requireFolder(c.env, actor, id, "viewer");
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO pins(user_id,resource_type,resource_id) SELECT caller.actor_id,'folder',f.id FROM folders f CROSS JOIN (SELECT ? AS actor_id) caller WHERE f.id=? AND ${folderRoleRankSQL("f.id", "caller.actor_id", true, c.env)}>=1`,
    )
      .bind(actor.principal.id, id)
      .run();
  }
  return c.body(null, 204);
});
browseRoutes.delete("/v1/pins/:resource_type/:resource_id", async (c) => {
  const type = z.enum(["document", "folder"]).parse(c.req.param("resource_type"));
  await c.env.DB.prepare(
    "DELETE FROM pins WHERE user_id=? AND resource_type=? AND resource_id=?",
  )
    .bind(c.get("actor").principal.id, type, c.req.param("resource_id"))
    .run();
  return c.body(null, 204);
});
const featuredSchema = z.record(
  z.string().trim().min(1),
  z
    .object({
      description: z.string().optional(),
      permanent: z.boolean().default(false),
      items: z
        .array(z.string().regex(/^(doc|fld)_/))
        .min(1)
        .max(1000),
    })
    .strict(),
);
export function parseFeatured(raw: string | undefined) {
  if (!raw?.trim()) return [];
  const parsed = featuredSchema.safeParse(JSON.parse(raw));
  if (!parsed.success)
    throw new ApiError(500, "invalid_featured", "Featured configuration is invalid");
  const sections = Object.entries(parsed.data).map(([title, section]) => ({
    title,
    ...section,
  }));
  if (
    sections.length > 100 ||
    sections.reduce((sum, s) => sum + s.items.length, 0) > 1000
  )
    throw new ApiError(
      500,
      "invalid_featured",
      "Featured configuration exceeds its supported size",
    );
  return sections;
}
function configuredFeatured(env: Env) {
  // Root environment integration adds this optional binding; narrow locally to
  // support deployments that have not supplied any featured configuration.
  const raw =
    "FEATURED_SECTIONS" in env && typeof env.FEATURED_SECTIONS === "string"
      ? env.FEATURED_SECTIONS
      : undefined;
  return parseFeatured(raw);
}
browseRoutes.get("/v1/featured", async (c) => {
  if (await groupMembershipUnavailable(c.env, c.get("actor")))
    throw new ApiError(
      503,
      "group_membership_unavailable",
      "Google Group memberships are temporarily unavailable",
    );
  const sections = configuredFeatured(c.env),
    actor = c.get("actor");
  if (!sections.length) return c.json({ items: [] });
  const ids = [...new Set(sections.flatMap((s) => s.items))],
    documents = ids.filter((id) => id.startsWith("doc_")),
    folders = ids.filter((id) => id.startsWith("fld_"));
  // D1 accepts at most 100 bound parameters. Bulk chunks keep featured
  // resolution bounded by configuration size rather than one query per item.
  const chunks = (values: string[]) => {
    const result: string[][] = [];
    for (let offset = 0; offset < values.length; offset += 90)
      result.push(values.slice(offset, offset + 90));
    return result;
  };
  type FeaturedDocumentRow = DocumentRow & {
    owner_email: string | null;
    owner_name: string | null;
    owner_picture_url: string | null;
    owner_provider: string | null;
    parent_title: string | null;
  };
  const [hidden, documentBatches, folderBatches] = await Promise.all([
    c.env.DB.prepare(
      "SELECT resource_id FROM hidden_featured_items WHERE principal_type=? AND principal_id=?",
    )
      .bind(actor.principal.type, actor.principal.id)
      .all<{ resource_id: string }>(),
    Promise.all(
      chunks(documents).map((ids) =>
        c.env.DB.prepare(
          `SELECT d.*,u.email AS owner_email,u.name AS owner_name,u.picture_url AS owner_picture_url,u.provider AS owner_provider,p.title AS parent_title FROM documents d LEFT JOIN users u ON u.id=d.owner_user_id LEFT JOIN folders p ON p.id=d.parent_folder_id WHERE d.deleted_at IS NULL AND ${viewerPredicateFor(c.env)} AND d.id IN (${ids.map(() => "?").join(",")})`,
        )
          .bind(actor.principal.id, actor.principal.id, ...ids)
          .all<FeaturedDocumentRow>(),
      ),
    ),
    Promise.all(
      chunks(folders).map((ids) =>
        c.env.DB.prepare(
          `SELECT f.*,u.email AS owner_email,u.name AS owner_name,u.picture_url AS owner_picture_url FROM folders f LEFT JOIN users u ON u.id=f.owner_id CROSS JOIN (SELECT ? AS actor_id) caller WHERE f.id IN (${ids.map(() => "?").join(",")}) AND ${folderRoleRankSQL("f.id", "caller.actor_id", true, c.env)}>=1`,
        )
          .bind(actor.principal.id, ...ids)
          .all<FolderRow>(),
      ),
    ),
  ]);
  const entries = new Map<string, FolderEntry>();
  for (const d of documentBatches.flatMap((batch) => batch.results))
    entries.set(d.id, { type: "document", document: folderDocumentDTO(d) });
  for (const f of folderBatches.flatMap((batch) => batch.results))
    entries.set(f.id, { type: "folder", folder: folderDTO(f) });
  const hiddenIds = new Set(hidden.results.map((row) => row.resource_id)),
    items: FeaturedSection[] = [];
  for (const section of sections) {
    const resolved: FolderEntry[] = [];
    for (const id of section.items) {
      const entry = entries.get(id);
      if (entry && (section.permanent || !hiddenIds.has(id))) resolved.push(entry);
    }
    if (resolved.length)
      items.push({
        title: section.title,
        ...(section.description ? { description: section.description } : {}),
        permanent: section.permanent,
        items: resolved,
      });
  }
  return c.json({ items });
});
browseRoutes.delete("/v1/featured/:id", async (c) => {
  const id = c.req.param("id"),
    actor = c.get("actor");
  if (
    !configuredFeatured(c.env).some(
      (section) => !section.permanent && section.items.includes(id),
    )
  )
    throw new ApiError(404, "not_found", "Featured item not found");
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO hidden_featured_items(principal_type,principal_id,resource_id) VALUES (?,?,?)",
  )
    .bind(actor.principal.type, actor.principal.id, id)
    .run();
  return c.body(null, 204);
});
