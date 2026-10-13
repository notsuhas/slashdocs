import type { Actor, Env, Role } from "../env";
import {
  googleGroupsEnabled,
  groupMembershipUnavailable,
  membershipUnavailable,
} from "./groups";
import { ApiError } from "../../../shared/errors";
export interface DocumentRow {
  id: string;
  title: string;
  owner_user_id: string;
  current_version_id: string | null;
  parent_folder_id: string | null;
  updated_at: string;
  access_revision: number;
  deleted_at: string | null;
}
export const roleRanks: Record<Role, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  owner: 4,
};
export function rankRole(rank: number): Role | undefined {
  if (rank >= 4) return "owner";
  if (rank === 3) return "editor";
  if (rank === 2) return "commenter";
  if (rank === 1) return "viewer";
  return undefined;
}
export const grantRankSQL =
  "CASE g.role WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END";
// These are SQL fragments for trusted column expressions, never user input.
export function folderAncestorsSQL(folderExpression: string) {
  return `WITH RECURSIVE ancestors(id,parent_folder_id,depth) AS (
    SELECT id,parent_folder_id,1 FROM folders WHERE id=${folderExpression}
    UNION ALL SELECT f.id,f.parent_folder_id,a.depth+1 FROM folders f JOIN ancestors a ON f.id=a.parent_folder_id WHERE a.depth<15
  )`;
}
export function grantMatchesActorSQL(
  actorExpression: string,
  includeAnyone: boolean,
  env: Env,
) {
  // Only deployment configuration enters this literal, after strict validation.
  const customer = env.GOOGLE_GROUPS_CUSTOMER_ID ?? "";
  const currentGroupConfig =
    googleGroupsEnabled(env) && /^C[a-zA-Z0-9]+$/.test(customer)
      ? `gs.customer_id='${customer}'`
      : "0";
  return `EXISTS(SELECT 1 FROM (SELECT ${actorExpression} AS actor_id) grant_caller WHERE (${includeAnyone ? "g.principal_type='anyone' OR " : ""}(g.principal_type IN ('user','service_account') AND g.principal_id=grant_caller.actor_id) OR (g.principal_type='google_group' AND EXISTS(SELECT 1 FROM google_group_memberships gm JOIN google_group_membership_snapshots gs ON gs.user_id=gm.user_id JOIN google_groups verified ON verified.id=gm.group_id AND verified.customer_id=gs.customer_id JOIN users gu ON gu.id=gm.user_id WHERE gm.user_id=grant_caller.actor_id AND gu.provider!='service_account' AND gm.group_id=g.principal_id AND ${currentGroupConfig} AND gs.last_success_at>0 AND gs.last_success_at<=unixepoch('subsec')*1000 AND gs.last_success_at>unixepoch('subsec')*1000-60000))))`;
}
export function folderGrantRankSQL(
  folderExpression: string,
  actorExpression: string,
  includeAnyone: boolean,
  env: Env,
) {
  return `COALESCE((${folderAncestorsSQL(folderExpression)} SELECT MAX(${grantRankSQL}) FROM folder_grants g JOIN ancestors a ON a.id=g.folder_id WHERE ${grantMatchesActorSQL(actorExpression, includeAnyone, env)}),0)`;
}
export function folderRoleRankSQL(
  folderExpression: string,
  actorExpression: string,
  includeAnyone: boolean,
  env: Env,
) {
  return `MAX(CASE WHEN EXISTS(SELECT 1 FROM folders owned WHERE owned.id=${folderExpression} AND owned.owner_id=${actorExpression}) THEN 4 ELSE 0 END,${folderGrantRankSQL(folderExpression, actorExpression, includeAnyone, env)})`;
}
function documentGrantRowsSQL() {
  return `SELECT principal_type,principal_id,role FROM document_grants WHERE document_id=d.id
    UNION ALL SELECT fg.principal_type,fg.principal_id,fg.role FROM folder_grants fg
    WHERE fg.folder_id IN (${folderAncestorsSQL("d.parent_folder_id")} SELECT id FROM ancestors)`;
}
export function documentRoleRankSQL(actorExpression: string, env: Env) {
  return `MAX(CASE WHEN d.owner_user_id=${actorExpression} THEN 4 ELSE 0 END,COALESCE((SELECT MAX(${grantRankSQL}) FROM (${documentGrantRowsSQL()}) g WHERE ${grantMatchesActorSQL(actorExpression, true, env)}),0))`;
}
// Actors originate from requireAuth, never from client JSON. One bound JSON
// array avoids both per-subscriber queries and SQLite's bound-variable limit.
export async function realtimeAuthorization(env: Env, actors: Actor[], docId: string) {
  if (!actors.length) return [];
  const customer = env.GOOGLE_GROUPS_CUSTOMER_ID ?? "";
  const groups = googleGroupsEnabled(env) && /^C[a-zA-Z0-9]+$/.test(customer);
  const rows = await env.DB.prepare(
    `
    WITH callers AS (SELECT CAST(key AS INTEGER) AS slot,
      json_extract(value,'$.principal.id') AS actor_id,
      json_extract(value,'$.principal.type') AS actor_type,
      json_extract(value,'$.credentialKind') AS credential_kind,
      json_extract(value,'$.credentialId') AS credential_id FROM json_each(?))
    SELECT caller.slot,
      EXISTS(SELECT 1 FROM documents d WHERE d.id=? AND d.deleted_at IS NULL) AS document_exists,
      CASE WHEN caller.actor_type='user' THEN
        CASE caller.credential_kind
          WHEN 'cli' THEN EXISTS(SELECT 1 FROM cli_credentials cc JOIN users u ON u.id=cc.user_id WHERE cc.id=caller.credential_id AND cc.user_id=caller.actor_id AND cc.revoked_at IS NULL AND u.provider!='service_account')
          WHEN 'session' THEN EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=caller.credential_id AND s.user_id=caller.actor_id AND s.expires_at>unixepoch() AND u.provider!='service_account')
          ELSE 0 END
        WHEN caller.actor_type='service_account' AND caller.credential_kind='service_account' THEN
          EXISTS(SELECT 1 FROM service_account_keys k JOIN service_accounts sa ON sa.id=k.service_account_id WHERE k.id=caller.credential_id AND sa.id=caller.actor_id AND k.revoked_at IS NULL AND sa.disabled_at IS NULL)
        ELSE 0 END AS credential_valid,
      COALESCE((SELECT ${documentRoleRankSQL("caller.actor_id", env)} FROM documents d WHERE d.id=? AND d.deleted_at IS NULL),0) AS role_rank,
      ${groups ? `caller.actor_type='user' AND NOT EXISTS(SELECT 1 FROM google_group_membership_snapshots gs WHERE gs.user_id=caller.actor_id AND gs.customer_id='${customer}' AND gs.last_success_at>0 AND gs.last_success_at<=unixepoch('subsec')*1000 AND gs.last_success_at>unixepoch('subsec')*1000-60000)` : "0"} AS groups_stale
    FROM callers caller
  `,
  )
    .bind(JSON.stringify(actors), docId, docId)
    .all<{
      slot: number;
      document_exists: number;
      credential_valid: number;
      role_rank: number;
      groups_stale: number;
    }>();
  const bySlot = new Map(rows.results.map((row) => [row.slot, row]));
  return actors.map((_, slot): "authorized" | "denied" | "refresh" => {
    const row = bySlot.get(slot);
    if (!row?.credential_valid || !row.document_exists) return "denied";
    if (row.role_rank >= 1) return "authorized";
    return row.groups_stale ? "refresh" : "denied";
  });
}
function documentPredicate(need: number, env: Env) {
  // Exactly two actor-ID bindings remain compatible with all publication CAS
  // callers. Inherited grants are re-evaluated inside the write statement.
  return `(d.owner_user_id=? OR EXISTS(SELECT 1 FROM (${documentGrantRowsSQL()}) g CROSS JOIN (SELECT ? AS actor_id) caller WHERE (${grantRankSQL})>=${need} AND ${grantMatchesActorSQL("caller.actor_id", true, env)}))`;
}
export const editorPredicateFor = (env: Env) => documentPredicate(3, env);
export const commenterPredicateFor = (env: Env) => documentPredicate(2, env);
export const viewerPredicateFor = (env: Env) => documentPredicate(1, env);
export async function requireDocument(
  env: Env,
  actor: Actor,
  docId: string,
  need: Role,
): Promise<{ document: DocumentRow; role: Role }> {
  const document = await env.DB.prepare(
    `SELECT d.*,${documentRoleRankSQL("caller.actor_id", env)} AS role_rank FROM documents d CROSS JOIN (SELECT ? AS actor_id) caller WHERE d.id=? AND d.deleted_at IS NULL`,
  )
    .bind(actor.principal.id, docId)
    .first<DocumentRow & { role_rank: number }>();
  if (!document) throw new ApiError(404, "not_found", "Document not found");
  const role = rankRole(document.role_rank);
  if (!role || roleRanks[role] < roleRanks[need]) {
    if (await groupMembershipUnavailable(env, actor)) throw membershipUnavailable();
    throw new ApiError(403, "forbidden", `${need} role required`);
  }
  return { document, role };
}
