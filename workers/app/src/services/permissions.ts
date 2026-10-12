import type { Actor, Env, Role } from "../env";
import { ApiError } from "../../../shared/errors";
export interface DocumentRow {
  id: string;
  title: string;
  owner_user_id: string;
  current_version_id: string | null;
  updated_at: string;
  access_revision: number;
  deleted_at: string | null;
}
const ranks: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
// Embed this predicate in writes as well as checking before work. Revoked access
// must not permit a publication that was queued before the revocation.
export const editorPredicate = `(d.owner_user_id=? OR EXISTS (SELECT 1 FROM document_grants g WHERE g.document_id=d.id AND g.role='editor' AND (g.principal_type='anyone' OR (g.principal_type='user' AND g.principal_id=?))))`;
export const viewerPredicate = `(d.owner_user_id=? OR EXISTS (SELECT 1 FROM document_grants g WHERE g.document_id=d.id AND (g.principal_type='anyone' OR (g.principal_type='user' AND g.principal_id=?))))`;
export async function requireDocument(
  env: Env,
  actor: Actor,
  docId: string,
  need: Role,
): Promise<{ document: DocumentRow; role: Role }> {
  const document = await env.DB.prepare(
    "SELECT * FROM documents WHERE id=? AND deleted_at IS NULL",
  )
    .bind(docId)
    .first<DocumentRow>();
  if (!document) throw new ApiError(404, "not_found", "Document not found");
  let role: Role | undefined =
    document.owner_user_id === actor.principal.id ? "owner" : undefined;
  if (!role) {
    const grants = await env.DB.prepare(
      "SELECT role FROM document_grants WHERE document_id=? AND (principal_type='anyone' OR (principal_type='user' AND principal_id=?))",
    )
      .bind(docId, actor.principal.id)
      .all<{ role: Exclude<Role, "owner"> }>();
    for (const grant of grants.results)
      if (!role || ranks[grant.role] > ranks[role]) role = grant.role;
  }
  if (!role || ranks[role] < ranks[need])
    throw new ApiError(403, "forbidden", `${need} role required`);
  return { document, role };
}
