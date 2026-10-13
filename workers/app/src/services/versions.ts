import type { Actor, Env } from "../env";
import type { Version } from "../../../shared/contracts";
import { lookupPrincipal, principalFromIdentity } from "./principals";
import { newId } from "../../../shared/ids";
import { ApiError } from "../../../shared/errors";
import { requireDocument, editorPredicateFor } from "./permissions";
import { storeSource, discardSource } from "./content";
import { sourceMetadataStatements } from "./source-metadata";
import { announceDocumentEvent } from "./state";
export interface VersionRow {
  id: string;
  document_id: string;
  number: number;
  base_version_id: string | null;
  object_key: string;
  sha256: string;
  byte_length: number;
  change_summary: string;
  created_by_user_id: string;
  created_at: string;
}
export interface VersionWithCreator extends VersionRow {
  creator_provider: string | null;
  creator_email: string | null;
  creator_name: string | null;
  creator_picture_url: string | null;
}
export function joinedVersionDTO(v: VersionWithCreator): Version {
  return {
    id: v.id,
    document_id: v.document_id,
    number: v.number,
    sha256: v.sha256,
    change_summary: v.change_summary,
    created_at: v.created_at,
    created_by: principalFromIdentity({
      id: v.created_by_user_id,
      provider: v.creator_provider ?? undefined,
      email: v.creator_email,
      name: v.creator_name,
      picture_url: v.creator_picture_url,
    }),
  };
}
export async function versionDTO(env: Env, v: VersionRow): Promise<Version> {
  const creator = await lookupPrincipal(env, v.created_by_user_id);
  return {
    id: v.id,
    document_id: v.document_id,
    number: v.number,
    sha256: v.sha256,
    change_summary: v.change_summary,
    created_at: v.created_at,
    created_by: creator,
  };
}
export async function getVersion(
  env: Env,
  actor: Actor,
  docId: string,
  versionId: string,
) {
  await requireDocument(env, actor, docId, "viewer");
  const version = await env.DB.prepare(
    "SELECT * FROM versions WHERE id=? AND document_id=?",
  )
    .bind(versionId, docId)
    .first<VersionRow>();
  if (!version) throw new ApiError(404, "not_found", "Version not found");
  return version;
}
export async function createVersion(
  env: Env,
  actor: Actor,
  docId: string,
  base: string,
  summary: string,
  bytes: Uint8Array,
) {
  if (!base) throw new ApiError(400, "bad_request", "base_version_id is required");
  const { document } = await requireDocument(env, actor, docId, "editor");
  const conflict = (current: string | null) =>
    new ApiError(409, "version_conflict", "base_version_id is stale", {
      current_version_id: current ?? "",
    });
  if (document.current_version_id !== base) throw conflict(document.current_version_id);
  const id = newId("ver"),
    key = `documents/${docId}/${id}.html`,
    now = new Date().toISOString(),
    sha = await storeSource(env, key, bytes);
  try {
    const result = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO versions (id,document_id,number,base_version_id,object_key,sha256,byte_length,change_summary,created_by_user_id,created_at) SELECT ?,d.id,(SELECT COALESCE(MAX(number),0)+1 FROM versions WHERE document_id=d.id),?,?,?,?,?,?,? FROM documents d WHERE d.id=? AND d.deleted_at IS NULL AND d.current_version_id=? AND ${editorPredicateFor(env)}`,
      ).bind(
        id,
        base,
        key,
        sha,
        bytes.length,
        summary,
        actor.principal.id,
        now,
        docId,
        base,
        actor.principal.id,
        actor.principal.id,
      ),
      env.DB.prepare(
        "UPDATE documents SET current_version_id=?,updated_at=? WHERE id=? AND current_version_id=? AND EXISTS (SELECT 1 FROM versions WHERE id=? AND document_id=?)",
      ).bind(id, now, docId, base, id, docId),
      env.DB.prepare(
        "DELETE FROM orphan_objects WHERE object_key=? AND EXISTS (SELECT 1 FROM versions WHERE id=?)",
      ).bind(key, id),
      ...sourceMetadataStatements(env, id, bytes),
    ]);
    if (!result[0].meta.changes) {
      await discardSource(env, key);
      const latest = await requireDocument(env, actor, docId, "editor");
      throw conflict(latest.document.current_version_id);
    }
    const row = await getVersion(env, actor, docId, id);
    await announceDocumentEvent(env, actor, docId, "document");
    return {
      id,
      number: row.number,
      sha256: sha,
      ...(summary ? { change_summary: summary } : {}),
    };
  } catch (error) {
    const committed = await env.DB.prepare("SELECT id FROM versions WHERE id=?")
      .bind(id)
      .first();
    if (!committed) await discardSource(env, key);
    throw error;
  }
}
