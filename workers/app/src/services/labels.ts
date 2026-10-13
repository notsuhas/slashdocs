import type { Actor, Env } from "../env";
import { ApiError, badRequest } from "../../../shared/errors";
import { editorPredicateFor } from "./permissions";
export function labelsEnabled(env: Env) {
  return /^(true|1)$/i.test(env.LABELS_ENABLED ?? "");
}
export function requireLabels(env: Env) {
  if (!labelsEnabled(env))
    throw new ApiError(
      404,
      "feature_disabled",
      "Document labels are temporarily disabled",
    );
}
export const validLabel = (label: string) => /^[a-z0-9][a-z0-9._-]{0,47}$/.test(label);
export async function listDocumentLabels(env: Env, id: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT label FROM document_labels WHERE document_id=? ORDER BY label",
  )
    .bind(id)
    .all<{ label: string }>();
  return results.map((row) => row.label);
}
export async function replaceDocumentLabels(
  env: Env,
  actor: Actor,
  id: string,
  raw: string[],
) {
  if (raw.length > 20) badRequest("at most 20 labels are allowed");
  const labels = [...new Set(raw.map((label) => label.trim().toLowerCase()))].sort();
  if (labels.some((label) => !validLabel(label)))
    badRequest(
      "labels must use lowercase letters, numbers, dots, underscores, or hyphens",
    );
  // One atomic batch avoids a revocation between DELETE and INSERT. A JSON table
  // supplies the replacement set, while an access guard aborts the whole write.
  const guard = env.DB.prepare(
    `INSERT INTO document_label_write_guards(document_id,allowed) SELECT ?,EXISTS(SELECT 1 FROM documents d WHERE d.id=? AND d.deleted_at IS NULL AND ${editorPredicateFor(env)})`,
  ).bind(id, id, actor.principal.id, actor.principal.id);
  const results = await env.DB.batch([
    guard,
    env.DB.prepare("DELETE FROM document_labels WHERE document_id=?").bind(id),
    env.DB.prepare(
      "INSERT INTO document_labels(document_id,label) SELECT ?,value FROM json_each(?)",
    ).bind(id, JSON.stringify(labels)),
    env.DB.prepare("DELETE FROM document_label_write_guards WHERE document_id=?").bind(
      id,
    ),
  ]).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes("CHECK constraint failed"))
      throw new ApiError(403, "forbidden", "editor role required");
    throw error;
  });
  if (!results[0].meta.changes)
    throw new ApiError(404, "not_found", "Document not found");
  return labels;
}
