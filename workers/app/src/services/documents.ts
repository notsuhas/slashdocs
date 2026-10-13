import type { Actor, Env } from "../env";
import type { Document } from "../../../shared/contracts";
import { newId } from "../../../shared/ids";
import { ApiError } from "../../../shared/errors";
import { discardSource, storeSource } from "./content";
import { sourceMetadataStatements } from "./source-metadata";
import { labelsEnabled, listDocumentLabels, requireLabels, validLabel } from "./labels";
import { parseDocumentSearch } from "./search-query";
import { documentSnippet, matchDocument, searchTerms } from "./search-text";
import { requireFolder } from "./folders";
import { requireResolvedGroupsForAggregate } from "./groups";
import {
  requireDocument,
  viewerPredicateFor,
  type DocumentRow,
  grantMatchesActorSQL,
} from "./permissions";
import { lookupPrincipal, principalFromIdentity } from "./principals";
interface DocumentWithOwner extends DocumentRow {
  owner_email: string | null;
  owner_name: string | null;
  owner_picture_url: string | null;
  owner_provider: string | null;
  search_text: string | null;
  labels_json: string;
  parent_title: string | null;
}
export async function documentDTO(env: Env, d: DocumentRow): Promise<Document> {
  const owner = await lookupPrincipal(env, d.owner_user_id);
  return {
    id: d.id,
    title: d.title,
    owner,
    current_version_id: d.current_version_id ?? undefined,
    parent_folder_id: d.parent_folder_id ?? undefined,
    updated_at: d.updated_at,
  };
}
export async function createDocument(
  env: Env,
  actor: Actor,
  title: string,
  bytes: Uint8Array,
  permission: string,
) {
  if (title === "") throw new ApiError(400, "bad_request", "invalid document upload");
  if (!["private", "viewer", "commenter", "editor"].includes(permission))
    throw new ApiError(
      400,
      "bad_request",
      "default_permission must be viewer, commenter, editor or private",
    );
  const id = newId("doc"),
    version = newId("ver"),
    key = `documents/${id}/${version}.html`,
    now = new Date().toISOString(),
    grant = newId("grt");
  const sha = await storeSource(env, key, bytes);
  const statements = [
    env.DB.prepare(
      "INSERT INTO documents (id,title,owner_user_id,current_version_id,updated_at) VALUES (?,?,?,?,?)",
    ).bind(id, title, actor.principal.id, version, now),
    env.DB.prepare(
      "INSERT INTO versions (id,document_id,number,object_key,sha256,byte_length,created_by_user_id,created_at) VALUES (?,?,1,?,?,?,?,?)",
    ).bind(version, id, key, sha, bytes.length, actor.principal.id, now),
    ...sourceMetadataStatements(env, version, bytes),
    env.DB.prepare("INSERT INTO document_revisions (document_id) VALUES (?)").bind(id),
    env.DB.prepare("DELETE FROM orphan_objects WHERE object_key=?").bind(key),
  ];
  if (permission !== "private")
    statements.push(
      env.DB.prepare(
        "INSERT INTO document_grants (id,document_id,principal_type,principal_id,role,granted_by_user_id) VALUES (?,?,'anyone','',?,?)",
      ).bind(grant, id, permission, actor.principal.id),
    );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    await discardSource(env, key);
    throw error;
  }
  return {
    id,
    current_version_id: version,
    ...(permission !== "private"
      ? {
          default_grant: {
            grant_id: grant,
            principal: { type: "anyone" },
            role: permission,
          },
        }
      : {}),
  };
}
const documentColumns = `d.*,u.provider AS owner_provider,u.email AS owner_email,u.name AS owner_name,u.picture_url AS owner_picture_url,v.search_text,pf.title AS parent_title,(SELECT json_group_array(label) FROM (SELECT label FROM document_labels WHERE document_id=d.id ORDER BY label)) AS labels_json`;
function listingDTO(d: DocumentWithOwner, includeLabels: boolean): Document {
  return {
    id: d.id,
    title: d.title,
    owner: principalFromIdentity({
      id: d.owner_user_id,
      provider: d.owner_provider ?? undefined,
      email: d.owner_email,
      name: d.owner_name,
      picture_url: d.owner_picture_url,
    }),
    current_version_id: d.current_version_id ?? undefined,
    parent_folder_id: d.parent_folder_id ?? undefined,
    updated_at: d.updated_at,
    ...(includeLabels ? { labels: parseLabels(d.labels_json) } : {}),
  };
}
function parseLabels(json: string): string[] {
  const value: unknown = JSON.parse(json);
  return Array.isArray(value) &&
    value.every((label): label is string => typeof label === "string")
    ? value
    : [];
}
export async function listDocuments(
  env: Env,
  actor: Actor,
  raw: string,
  zone = "UTC",
  deprecatedLabel = "",
) {
  await requireResolvedGroupsForAggregate(env, actor);
  const q = raw.trim(),
    search = parseDocumentSearch(q, actor.principal.id, new Date(), zone);
  const includeLabels = labelsEnabled(env),
    label = deprecatedLabel.trim().toLowerCase();
  if (label) {
    requireLabels(env);
    if (!validLabel(label)) throw new ApiError(400, "bad_request", "invalid label");
    search.labels.push(label);
  }
  const searching = !!q || !!search.labels.length;
  const principal = grantMatchesActorSQL(
    "caller.actor_id",
    searching && env.DEPLOYMENT === "org",
    env,
  );
  const directAccess = `EXISTS(SELECT 1 FROM document_grants g WHERE g.document_id=d.id AND (${principal}))`;
  const folderAccess = `EXISTS(SELECT 1 FROM folder_ancestors a JOIN folder_grants g ON g.folder_id=a.fid WHERE a.doc_id=d.id AND (${principal}))`;
  const workspace = `EXISTS(SELECT 1 FROM document_workspace_entries w WHERE w.document_id=d.id AND w.principal_type=? AND w.principal_id=caller.actor_id) AND EXISTS(SELECT 1 FROM document_grants g WHERE g.document_id=d.id AND g.principal_type='anyone')`;
  const conditions = [
    "d.deleted_at IS NULL",
    `(d.owner_user_id=caller.actor_id OR ${directAccess} OR (${searching ? folderAccess : workspace}))`,
  ];
  const params: (string | number)[] = [actor.principal.id];
  if (!searching) {
    conditions.push("d.parent_folder_id IS NULL");
    params.push(actor.principal.type);
  }
  if (search.owners.length) {
    conditions.push(
      `EXISTS(SELECT 1 FROM json_each(?) wanted WHERE wanted.value=lower(d.owner_user_id) OR wanted.value=lower(u.email) OR wanted.value=lower(substr(u.email,1,instr(u.email,'@')-1)) OR (u.provider='service_account' AND wanted.value=lower(u.name)))`,
    );
    params.push(JSON.stringify(search.owners));
  }
  if (search.folders.length) {
    conditions.push(
      `EXISTS(SELECT 1 FROM folder_ancestors a JOIN folders f ON f.id=a.fid JOIN json_each(?) wanted ON wanted.value=f.id OR wanted.value=f.title_key WHERE a.doc_id=d.id)`,
    );
    params.push(JSON.stringify(search.folders));
  }
  if (search.labels.length) {
    conditions.push(
      `NOT EXISTS(SELECT 1 FROM json_each(?) wanted WHERE NOT EXISTS(SELECT 1 FROM document_labels dl WHERE dl.document_id=d.id AND dl.label=wanted.value))`,
    );
    params.push(JSON.stringify(search.labels));
  }
  if (search.since) {
    conditions.push("julianday(d.updated_at)>=julianday(?)");
    params.push(search.since);
  }
  if (search.before) {
    conditions.push("julianday(d.updated_at)<julianday(?)");
    params.push(search.before);
  }
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE folder_ancestors(doc_id,fid,depth) AS (SELECT id,parent_folder_id,1 FROM documents WHERE parent_folder_id IS NOT NULL UNION ALL SELECT a.doc_id,f.parent_folder_id,a.depth+1 FROM folder_ancestors a JOIN folders f ON f.id=a.fid WHERE f.parent_folder_id IS NOT NULL AND a.depth<20) SELECT ${documentColumns} FROM documents d LEFT JOIN users u ON u.id=d.owner_user_id LEFT JOIN versions v ON v.id=d.current_version_id LEFT JOIN folders pf ON pf.id=d.parent_folder_id CROSS JOIN (SELECT ? AS actor_id) caller WHERE ${conditions.join(" AND ")} ORDER BY d.updated_at DESC,d.title ${searching ? "" : "LIMIT 25"}`,
  )
    .bind(...params)
    .all<DocumentWithOwner>();
  if (!searching) return results.map((d) => listingDTO(d, includeLabels));
  const terms = searchTerms(search.terms),
    excluded = searchTerms(search.excluded);
  const matches = results
    .flatMap((row) => {
      const match = matchDocument(
        row.title,
        row.search_text ?? "",
        terms,
        excluded,
        false,
      );
      return match ? [{ row, ...match }] : [];
    })
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        b.row.updated_at.localeCompare(a.row.updated_at) ||
        a.row.title.localeCompare(b.row.title),
    );
  return matches.slice(0, 25).map(({ row, indexedText }) => {
    const snippet = documentSnippet(row.search_text ?? "", terms, indexedText);
    return {
      ...listingDTO(row, includeLabels),
      ...(row.parent_folder_id && row.parent_title !== null
        ? { parent_folder: { id: row.parent_folder_id, title: row.parent_title } }
        : {}),
      ...(snippet ? { snippet } : {}),
    };
  });
}
export async function getDocument(env: Env, actor: Actor, id: string) {
  const { document } = await requireDocument(env, actor, id, "viewer");
  const dto = await documentDTO(env, document);
  if (document.owner_user_id !== actor.principal.id)
    await env.DB.prepare(
      `INSERT INTO document_workspace_entries(document_id,principal_type,principal_id) SELECT d.id,?,? FROM documents d WHERE d.id=? AND d.deleted_at IS NULL AND ${viewerPredicateFor(env)} ON CONFLICT DO NOTHING`,
    )
      .bind(
        actor.principal.type,
        actor.principal.id,
        id,
        actor.principal.id,
        actor.principal.id,
      )
      .run();
  if (labelsEnabled(env)) dto.labels = await listDocumentLabels(env, id);
  if (document.parent_folder_id) {
    try {
      const { folder } = await requireFolder(
        env,
        actor,
        document.parent_folder_id,
        "viewer",
      );
      dto.parent_folder = { id: folder.id, title: folder.title };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
  return dto;
}
