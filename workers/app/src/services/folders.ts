import type { Actor, Env, Role } from "../env";
import type {
  Document,
  Folder,
  FolderEntry,
  Principal,
} from "../../../shared/contracts";
import { ApiError } from "../../../shared/errors";
import { canonicalGrantPrincipal } from "./grant-principals";
import {
  groupMembershipUnavailable,
  membershipUnavailable,
  requireResolvedGroupsForAggregate,
} from "./groups";
import { newId } from "../../../shared/ids";
import {
  folderAncestorsSQL,
  grantMatchesActorSQL,
  folderRoleRankSQL,
  rankRole,
  roleRanks,
  requireDocument,
  editorPredicateFor,
  type DocumentRow,
} from "./permissions";
// Match Unicode title case handling outside SQLite's ASCII-only lower().
export const folderTitleKey = (title: string) => title.toLowerCase();
export interface FolderRow {
  id: string;
  title: string;
  owner_type: "user" | "service_account";
  owner_id: string;
  parent_folder_id: string | null;
  created_at: string;
  updated_at: string;
  owner_email: string | null;
  owner_name: string | null;
  owner_picture_url: string | null;
}
export type FolderAccess = FolderRow & { depth: number; role_rank: number };
const folderColumns =
  "f.*,u.email AS owner_email,u.name AS owner_name,u.picture_url AS owner_picture_url";
export function folderDTO(row: FolderRow): Folder {
  return {
    id: row.id,
    title: row.title,
    owner: {
      type: row.owner_type,
      id: row.owner_id,
      ...(row.owner_email !== null
        ? {
            email: row.owner_email,
            name: row.owner_name ?? "",
            picture_url: row.owner_picture_url ?? "",
          }
        : {}),
    },
    ...(row.parent_folder_id ? { parent_folder_id: row.parent_folder_id } : {}),
  };
}
export async function folderAccessChain(
  env: Env,
  actor: Actor,
  id: string,
): Promise<FolderAccess[]> {
  const { results } = await env.DB.prepare(
    `${folderAncestorsSQL("?")} SELECT ${folderColumns},a.depth,${folderRoleRankSQL("f.id", "caller.actor_id", true, env)} AS role_rank FROM ancestors a JOIN folders f ON f.id=a.id LEFT JOIN users u ON u.id=f.owner_id CROSS JOIN (SELECT ? AS actor_id) caller ORDER BY a.depth DESC`,
  )
    .bind(id, actor.principal.id)
    .all<FolderAccess>();
  return results;
}
export async function requireFolder(
  env: Env,
  actor: Actor,
  id: string,
  need: Role,
): Promise<{ folder: FolderRow; role: Role }> {
  const row = await env.DB.prepare(
    `SELECT ${folderColumns},${folderRoleRankSQL("f.id", "caller.actor_id", true, env)} AS role_rank FROM folders f LEFT JOIN users u ON u.id=f.owner_id CROSS JOIN (SELECT ? AS actor_id) caller WHERE f.id=?`,
  )
    .bind(actor.principal.id, id)
    .first<FolderRow & { role_rank: number }>();
  if (!row) throw new ApiError(404, "not_found", "Folder not found");
  const role = rankRole(row.role_rank);
  if (!role || roleRanks[role] < roleRanks[need]) {
    if (await groupMembershipUnavailable(env, actor)) throw membershipUnavailable();
    throw new ApiError(403, "forbidden", `${need} role required`);
  }
  return { folder: row, role };
}
export async function getFolder(
  env: Env,
  actor: Actor,
  id: string,
  recordOpened = true,
): Promise<Folder> {
  const chain = await folderAccessChain(env, actor, id),
    row = chain.at(-1);
  if (!row) throw new ApiError(403, "forbidden", "viewer role required");
  if (row.role_rank < 1) {
    if (await groupMembershipUnavailable(env, actor)) throw membershipUnavailable();
    throw new ApiError(403, "forbidden", "viewer role required");
  }
  const result = folderDTO(row),
    ancestors: Folder["ancestors"] = [];
  for (let i = chain.length - 2; i >= 0; i--) {
    const ancestor = chain[i];
    if (ancestor.role_rank < 1) break;
    ancestors.unshift({ id: ancestor.id, title: ancestor.title });
  }
  if (ancestors.length) result.ancestors = ancestors;
  if (recordOpened && row.owner_id !== actor.principal.id)
    await env.DB.prepare(
      `INSERT INTO folder_workspace_entries(folder_id,principal_type,principal_id,last_opened_at) SELECT f.id,?,?,? FROM folders f CROSS JOIN (SELECT ? AS actor_id) caller WHERE f.id=? AND ${folderRoleRankSQL("f.id", "caller.actor_id", true, env)}>=1 ON CONFLICT(folder_id,principal_type,principal_id) DO UPDATE SET last_opened_at=excluded.last_opened_at`,
    )
      .bind(
        actor.principal.type,
        actor.principal.id,
        new Date().toISOString(),
        actor.principal.id,
        id,
      )
      .run();
  return result;
}
export function folderWriteError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (
    /UNIQUE constraint failed|folder_(depth|cycle)_conflict|CHECK constraint failed/.test(
      message,
    )
  )
    throw new ApiError(
      409,
      "conflict",
      "A folder with that name already exists in the destination, or the move exceeds the folder tree limits.",
    );
  if (/FOREIGN KEY constraint failed/.test(message))
    throw new ApiError(404, "not_found", "Folder not found");
  throw error;
}
export async function createFolder(
  env: Env,
  actor: Actor,
  title: string,
  parent = "",
): Promise<Folder> {
  if (parent) await requireFolder(env, actor, parent, "editor");
  const id = newId("fld"),
    now = new Date().toISOString();
  try {
    const result = await env.DB.prepare(
      `INSERT INTO folders(id,title,title_key,owner_type,owner_id,parent_folder_id,created_at,updated_at) SELECT ?,?,?,?,?,NULLIF(?,''),?,? FROM (SELECT ? AS actor_id) caller WHERE ?='' OR ${folderRoleRankSQL("?", "caller.actor_id", true, env)}>=3`,
    )
      .bind(
        id,
        title,
        folderTitleKey(title),
        actor.principal.type,
        actor.principal.id,
        parent,
        now,
        now,
        actor.principal.id,
        parent,
        parent,
        parent,
      )
      .run();
    if (!result.meta.changes)
      throw new ApiError(403, "forbidden", "editor role required");
  } catch (error) {
    folderWriteError(error);
  }
  return {
    id,
    title,
    owner: actor.principal,
    ...(parent ? { parent_folder_id: parent } : {}),
  };
}
export async function folderHasGrants(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `${folderAncestorsSQL("?")} SELECT EXISTS(SELECT 1 FROM folder_grants g JOIN ancestors a ON a.id=g.folder_id) AS has_grants`,
  )
    .bind(id)
    .first<{ has_grants: number }>();
  return !!row?.has_grants;
}
export const broadenWarning = (message: string) => ({
  kind: "may_broaden_access",
  message,
});
export async function updateFolder(
  env: Env,
  actor: Actor,
  id: string,
  title: string | undefined,
  parent: string | null | undefined,
) {
  await requireFolder(env, actor, id, "owner");
  if (parent) await requireFolder(env, actor, parent, "editor");
  try {
    const result = await env.DB.prepare(
      `UPDATE folders AS f SET title=CASE WHEN ? IS NOT NULL AND ?<>'' THEN ? ELSE title END,title_key=CASE WHEN ? IS NOT NULL AND ?<>'' THEN ? ELSE title_key END,parent_folder_id=CASE WHEN ?=1 THEN NULLIF(?,'') ELSE parent_folder_id END,updated_at=? FROM (SELECT ? AS actor_id) caller WHERE f.id=? AND f.owner_id=? AND (?=0 OR ?='' OR ${folderRoleRankSQL("?", "caller.actor_id", true, env)}>=3)`,
    )
      .bind(
        title ?? null,
        title ?? null,
        title ?? null,
        title ?? null,
        title ?? null,
        title === undefined ? null : folderTitleKey(title),
        parent === undefined ? 0 : 1,
        parent ?? "",
        new Date().toISOString(),
        actor.principal.id,
        id,
        actor.principal.id,
        parent === undefined ? 0 : 1,
        parent ?? "",
        parent ?? "",
        parent ?? "",
      )
      .run();
    if (!result.meta.changes)
      throw new ApiError(403, "forbidden", "Required folder access was revoked");
  } catch (error) {
    folderWriteError(error);
  }
  const folder = await getFolder(env, actor, id, false);
  return {
    id: folder.id,
    title: folder.title,
    owner: folder.owner,
    parent_folder_id: folder.parent_folder_id ?? "",
    ...(parent && (await folderHasGrants(env, parent))
      ? {
          permission_warning: broadenWarning(
            "The destination folder has active grants — contents of the moved folder may become visible to others.",
          ),
        }
      : {}),
  };
}
function ownedSubtreeSQL() {
  return `WITH RECURSIVE subtree(id,depth) AS (SELECT id,1 FROM folders WHERE id=? AND owner_id=? UNION ALL SELECT f.id,s.depth+1 FROM folders f JOIN subtree s ON f.parent_folder_id=s.id WHERE f.owner_id=? AND s.depth<15)`;
}
export async function deleteFolder(env: Env, actor: Actor, id: string) {
  await requireFolder(env, actor, id, "owner");
  // Fifteen serialized leaf-first statements cover the maximum tree depth.
  // Their subtree is re-evaluated inside the batch; foreign boundaries stop it.
  const statements = [
    env.DB.prepare(
      `${ownedSubtreeSQL()} UPDATE documents SET access_revision=access_revision+1 WHERE parent_folder_id IN (SELECT id FROM subtree)`,
    ).bind(id, actor.principal.id, actor.principal.id),
  ];
  for (let depth = 0; depth < 15; depth++)
    statements.push(
      env.DB.prepare(
        `${ownedSubtreeSQL()} DELETE FROM folders WHERE id IN (SELECT s.id FROM subtree s WHERE NOT EXISTS(SELECT 1 FROM folders child WHERE child.parent_folder_id=s.id AND child.owner_id=?))`,
      ).bind(id, actor.principal.id, actor.principal.id, actor.principal.id),
    );
  await env.DB.batch(statements);
}
export async function resolveFolderPath(
  env: Env,
  actor: Actor,
  start: string,
  path: string,
): Promise<string> {
  let parent = start;
  if (start) await requireFolder(env, actor, start, "viewer");
  if (!path || path === "/") return parent;
  const segments = path.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length > 15)
    throw new ApiError(400, "bad_request", "Folder paths support at most 15 segments");
  for (const segment of segments) {
    const { results } = await env.DB.prepare(
      `SELECT ${folderColumns} FROM folders f LEFT JOIN users u ON u.id=f.owner_id CROSS JOIN (SELECT ? AS actor_id) caller WHERE ${parent ? "f.parent_folder_id=?" : "f.parent_folder_id IS NULL"} AND f.title_key=? ${parent ? "" : `AND ${folderRoleRankSQL("f.id", "caller.actor_id", true, env)}>=1`} ORDER BY CASE WHEN f.owner_id=caller.actor_id THEN 0 ELSE 1 END,f.id LIMIT 51`,
    )
      .bind(actor.principal.id, ...(parent ? [parent] : []), folderTitleKey(segment))
      .all<FolderRow>();
    if (!results.length) throw new ApiError(404, "not_found", "Folder not found");
    if (results.length > 1)
      throw new ApiError(
        409,
        "ambiguous_path",
        `Multiple folders named "${segment}" found. Use --folder-id to specify.`,
        { candidates: results.map(folderDTO) },
      );
    parent = results[0].id;
  }
  return parent;
}
export async function searchFolders(
  env: Env,
  actor: Actor,
  q: string,
): Promise<FolderEntry[]> {
  await requireResolvedGroupsForAggregate(env, actor);
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE accessible(id) AS (SELECT f.id FROM folders f CROSS JOIN (SELECT ? AS actor_id) caller WHERE f.owner_id=caller.actor_id OR EXISTS(SELECT 1 FROM folder_grants g WHERE g.folder_id=f.id AND ${grantMatchesActorSQL("caller.actor_id", env.DEPLOYMENT === "org", env)}) UNION SELECT child.id FROM folders child JOIN accessible a ON child.parent_folder_id=a.id) SELECT ${folderColumns} FROM folders f LEFT JOIN users u ON u.id=f.owner_id WHERE f.id IN (SELECT id FROM accessible) AND f.title_key LIKE ? ESCAPE '\\' ORDER BY f.title,f.id LIMIT 25`,
  )
    .bind(actor.principal.id, `%${folderTitleKey(q)}%`)
    .all<FolderRow>();
  return results.map((folder) => ({ type: "folder", folder: folderDTO(folder) }));
}
interface FolderDocumentRow extends DocumentRow {
  owner_email: string | null;
  owner_name: string | null;
  owner_picture_url: string | null;
  owner_provider: string | null;
  parent_title: string | null;
}
export function folderDocumentDTO(row: FolderDocumentRow): Document {
  return {
    id: row.id,
    title: row.title,
    owner: {
      type: row.owner_provider === "service_account" ? "service_account" : "user",
      id: row.owner_user_id,
      ...(row.owner_email !== null
        ? {
            email: row.owner_email,
            name: row.owner_name ?? "",
            picture_url: row.owner_picture_url ?? "",
          }
        : {}),
    },
    current_version_id: row.current_version_id ?? "",
    updated_at: row.updated_at,
    ...(row.parent_folder_id
      ? {
          parent_folder_id: row.parent_folder_id,
          ...(row.parent_title !== null
            ? { parent_folder: { id: row.parent_folder_id, title: row.parent_title } }
            : {}),
        }
      : {}),
  };
}
export async function listFolderDocuments(
  env: Env,
  actor: Actor,
  id: string,
): Promise<Document[]> {
  await requireResolvedGroupsForAggregate(env, actor);
  await requireFolder(env, actor, id, "viewer");
  const { results } = await env.DB.prepare(
    `SELECT d.*,u.email AS owner_email,u.name AS owner_name,u.picture_url AS owner_picture_url,u.provider AS owner_provider,p.title AS parent_title FROM documents d LEFT JOIN users u ON u.id=d.owner_user_id LEFT JOIN folders p ON p.id=d.parent_folder_id WHERE d.parent_folder_id=? AND d.deleted_at IS NULL ORDER BY d.updated_at DESC,d.id`,
  )
    .bind(id)
    .all<FolderDocumentRow>();
  return results.map(folderDocumentDTO);
}
export async function listFolders(env: Env, actor: Actor, start = "", path = "") {
  await requireResolvedGroupsForAggregate(env, actor);
  const parent = await resolveFolderPath(env, actor, start, path);
  if (parent) await requireFolder(env, actor, parent, "viewer");
  const rootCondition = `((f.parent_folder_id IS NULL AND (f.owner_id=caller.actor_id OR EXISTS(SELECT 1 FROM folder_grants g WHERE g.folder_id=f.id AND ${grantMatchesActorSQL("caller.actor_id", false, env)}) OR (we.folder_id IS NOT NULL AND EXISTS(SELECT 1 FROM folder_grants g WHERE g.folder_id=f.id AND g.principal_type='anyone')))) OR (f.parent_folder_id IS NOT NULL AND we.folder_id IS NOT NULL AND ${folderRoleRankSQL("f.id", "caller.actor_id", true, env)}>=1 AND NOT EXISTS(${folderAncestorsSQL("f.parent_folder_id")} SELECT 1 FROM ancestors a JOIN folder_workspace_entries w ON w.folder_id=a.id WHERE w.principal_id=caller.actor_id)))`;
  const { results } = await env.DB.prepare(
    `SELECT ${folderColumns},COALESCE(we.last_opened_at,f.created_at) AS last_active FROM folders f LEFT JOIN users u ON u.id=f.owner_id CROSS JOIN (SELECT ? AS actor_id) caller LEFT JOIN folder_workspace_entries we ON we.folder_id=f.id AND we.principal_id=caller.actor_id WHERE ${parent ? `f.parent_folder_id=?` : rootCondition} ORDER BY ${parent ? "f.title" : "last_active DESC"},f.id LIMIT 51`,
  )
    .bind(actor.principal.id, ...(parent ? [parent] : []))
    .all<FolderRow & { last_active: string }>();
  const items: FolderEntry[] = results.slice(0, 50).map((row) => ({
    type: "folder",
    folder: folderDTO(row),
    ...(!parent ? { last_active: row.last_active } : {}),
  }));
  if (parent)
    items.push(
      ...(await listFolderDocuments(env, actor, parent)).map(
        (document): FolderEntry => ({ type: "document", document }),
      ),
    );
  return {
    folder: parent ? await getFolder(env, actor, parent, false) : null,
    items,
    has_more: results.length >= 50,
  };
}
export async function requireDocumentMove(
  env: Env,
  actor: Actor,
  id: string,
  destination: string,
) {
  const access = await requireDocument(env, actor, id, "editor");
  const source = access.document.parent_folder_id;
  if (access.role !== "owner" && source && source !== destination)
    await requireFolder(env, actor, source, "editor");
  return access;
}
export async function moveDocument(
  env: Env,
  actor: Actor,
  id: string,
  destination: string,
  expectedSource?: string,
) {
  if (destination) await requireFolder(env, actor, destination, "editor");
  await requireDocumentMove(env, actor, id, destination);
  const result = await env.DB.prepare(
    `UPDATE documents AS d SET parent_folder_id=NULLIF(?,''),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),access_revision=access_revision+1 FROM (SELECT ? AS actor_id) caller WHERE d.id=? AND d.deleted_at IS NULL AND ${editorPredicateFor(env)} AND (d.owner_user_id=? OR d.parent_folder_id IS NULL OR d.parent_folder_id=NULLIF(?,'') OR ${folderRoleRankSQL("d.parent_folder_id", "caller.actor_id", true, env)}>=3) AND (?='' OR ${folderRoleRankSQL("?", "caller.actor_id", true, env)}>=3) AND (?=0 OR d.parent_folder_id=?)`,
  )
    .bind(
      destination,
      actor.principal.id,
      id,
      actor.principal.id,
      actor.principal.id,
      actor.principal.id,
      destination,
      destination,
      destination,
      destination,
      expectedSource === undefined ? 0 : 1,
      expectedSource ?? "",
    )
    .run();
  if (!result.meta.changes && expectedSource === undefined)
    throw new ApiError(
      403,
      "forbidden",
      "Required document or folder access was revoked",
    );
  return {
    document_id: id,
    folder_id: destination,
    moved: true,
    ...(destination && (await folderHasGrants(env, destination))
      ? {
          permission_warning: broadenWarning(
            "This folder has active grants — everyone with access may see this document.",
          ),
        }
      : {}),
  };
}
export const canonicalPrincipal = canonicalGrantPrincipal;
export async function effectiveAccess(
  env: Env,
  resourceType: "document" | "folder",
  id: string,
) {
  const resource =
    resourceType === "folder"
      ? await env.DB.prepare(
          "SELECT id,title,owner_type,owner_id,parent_folder_id FROM folders WHERE id=?",
        )
          .bind(id)
          .first<{
            id: string;
            title: string;
            owner_type: "user" | "service_account";
            owner_id: string;
            parent_folder_id: string | null;
          }>()
      : await env.DB.prepare(
          "SELECT d.id,d.title,CASE WHEN u.provider='service_account' THEN 'service_account' ELSE 'user' END AS owner_type,d.owner_user_id AS owner_id,d.parent_folder_id FROM documents d JOIN users u ON u.id=d.owner_user_id WHERE d.id=? AND d.deleted_at IS NULL",
        )
          .bind(id)
          .first<{
            id: string;
            title: string;
            owner_type: "user" | "service_account";
            owner_id: string;
            parent_folder_id: string | null;
          }>();
  if (!resource) throw new ApiError(404, "not_found", "Resource not found");
  type AccessItem = import("../../../shared/contracts").EffectiveAccessItem;
  const owner = await canonicalPrincipal(env, resource.owner_type, resource.owner_id);
  const byPrincipal = new Map<string, AccessItem>();
  const ownerItem: AccessItem = {
    principal: owner,
    effective_role: "owner",
    sources: [
      {
        resource_type: resourceType,
        resource_id: id,
        resource_title: resource.title,
        role: "owner",
      },
    ],
  };
  byPrincipal.set(`${owner.type}:${owner.id}`, ownerItem);
  const root = resourceType === "folder" ? id : resource.parent_folder_id;
  const grants = await env.DB.prepare(
    `${folderAncestorsSQL("?")} SELECT grants.*,CASE WHEN grants.principal_type='google_group' THEN gg.email ELSE u.email END AS email,CASE WHEN grants.principal_type='google_group' THEN gg.name ELSE u.name END AS name,u.picture_url FROM (SELECT g.id,g.folder_id AS resource_id,'folder' AS resource_type,f.title AS resource_title,g.principal_type,g.principal_id,g.role FROM folder_grants g JOIN ancestors a ON a.id=g.folder_id JOIN folders f ON f.id=g.folder_id ${resourceType === "document" ? "UNION ALL SELECT g.id,g.document_id,'document',d.title,g.principal_type,g.principal_id,g.role FROM document_grants g JOIN documents d ON d.id=g.document_id WHERE g.document_id=?" : ""}) grants LEFT JOIN users u ON u.id=grants.principal_id AND grants.principal_type IN ('user','service_account') AND (u.provider='service_account')=(grants.principal_type='service_account') LEFT JOIN google_groups gg ON gg.id=grants.principal_id AND grants.principal_type='google_group' ORDER BY grants.resource_id,grants.id`,
  )
    .bind(root, ...(resourceType === "document" ? [id] : []))
    .all<{
      id: string;
      resource_type: string;
      resource_id: string;
      resource_title: string;
      principal_type: Principal["type"];
      principal_id: string;
      role: Exclude<Role, "owner">;
      email: string | null;
      name: string | null;
      picture_url: string | null;
    }>();
  for (const grant of grants.results) {
    const key = `${grant.principal_type}:${grant.principal_id}`;
    let item = byPrincipal.get(key);
    if (!item) {
      if (
        (grant.principal_type === "user" ||
          grant.principal_type === "service_account") &&
        grant.email === null
      )
        throw new ApiError(404, "not_found", "Principal not found");
      item = {
        principal:
          grant.principal_type === "anyone"
            ? { type: "anyone", id: "" }
            : grant.principal_type === "service_account"
              ? {
                  type: "service_account",
                  id: grant.principal_id,
                  name: grant.name ?? "",
                }
              : {
                  type: grant.principal_type,
                  id: grant.principal_id,
                  ...(grant.email !== null
                    ? {
                        email: grant.email,
                        name: grant.name ?? "",
                        ...(grant.principal_type === "user" && grant.picture_url
                          ? { picture_url: grant.picture_url }
                          : {}),
                      }
                    : {}),
                },
        effective_role: grant.role,
        sources: [],
      };
      byPrincipal.set(key, item);
    }
    const current = rankRole(
      grant.role === "editor" ? 3 : grant.role === "commenter" ? 2 : 1,
    );
    if (
      current &&
      item.effective_role !== "owner" &&
      (item.effective_role === "viewer" || current === "editor")
    )
      item.effective_role = current;
    item.sources.push({
      resource_type: grant.resource_type,
      resource_id: grant.resource_id,
      resource_title: grant.resource_title,
      role: grant.role,
      grant_id: grant.id,
    });
  }
  return [...byPrincipal.values()];
}
