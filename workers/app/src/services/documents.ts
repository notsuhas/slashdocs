import type { Actor, Env } from "../env";
import type { Document } from "../../../shared/contracts";
import { newId } from "../../../shared/ids";
import { ApiError } from "../../../shared/errors";
import { discardSource, storeSource } from "./content";
import { requireDocument, viewerPredicate, type DocumentRow } from "./permissions";
interface DocumentWithOwner extends DocumentRow {
  owner_email: string | null;
  owner_name: string | null;
  owner_picture_url: string | null;
}
export async function documentDTO(env: Env, d: DocumentRow): Promise<Document> {
  const owner = await env.DB.prepare(
    "SELECT id,email,name,picture_url FROM users WHERE id=?",
  )
    .bind(d.owner_user_id)
    .first<{ id: string; email: string; name: string; picture_url: string }>();
  return {
    id: d.id,
    title: d.title,
    owner: owner ? { type: "user", ...owner } : { type: "user", id: d.owner_user_id },
    current_version_id: d.current_version_id ?? undefined,
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
  if (!title.trim()) throw new ApiError(400, "bad_request", "Title is required");
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
export async function listDocuments(env: Env, actor: Actor, q: string) {
  if (/(^|\s)(-\S|\w+:)|["\n]/.test(q))
    throw new ApiError(
      400,
      "unsupported_search",
      "Only title text search is supported",
    );
  const words = q.trim().split(/\s+/).filter(Boolean);
  const where = words.map(() => "instr(lower(d.title),lower(?))>0").join(" AND ");
  const { results } = await env.DB.prepare(
    `SELECT d.*,u.email AS owner_email,u.name AS owner_name,u.picture_url AS owner_picture_url FROM documents d LEFT JOIN users u ON u.id=d.owner_user_id WHERE d.deleted_at IS NULL AND ${viewerPredicate} ${where ? "AND " + where : ""} ORDER BY d.updated_at DESC LIMIT 100`,
  )
    .bind(actor.principal.id, actor.principal.id, ...words)
    .all<DocumentWithOwner>();
  return results.map((d): Document => ({
    id: d.id,
    title: d.title,
    owner: {
      type: "user",
      id: d.owner_user_id,
      ...(d.owner_email !== null
        ? {
            email: d.owner_email,
            name: d.owner_name ?? "",
            picture_url: d.owner_picture_url ?? "",
          }
        : {}),
    },
    current_version_id: d.current_version_id ?? undefined,
    updated_at: d.updated_at,
  }));
}
export async function getDocument(env: Env, actor: Actor, id: string) {
  const { document } = await requireDocument(env, actor, id, "viewer");
  return documentDTO(env, document);
}
