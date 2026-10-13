import type { Actor, Env } from "../env";
import type {
  DocumentKVEvent,
  DocumentKVPatch,
  DocumentKVPatchResult,
} from "../../../shared/contracts";
import { ApiError } from "../../../shared/errors";
import { requireDocument, editorPredicateFor, viewerPredicateFor } from "./permissions";

export function realtimeStub(env: Env, id: string) {
  if (!env.DOCUMENT_REALTIME)
    throw new ApiError(503, "unavailable", "Realtime binding is not configured");
  return env.DOCUMENT_REALTIME.get(env.DOCUMENT_REALTIME.idFromName(id));
}
export async function announceDocumentEvent(
  env: Env,
  actor: Actor,
  id: string,
  kind: "document" | "comments",
) {
  try {
    const response = await realtimeStub(env, id).fetch(
      "https://realtime.internal/announce",
      { method: "POST", body: JSON.stringify({ id, actor, kind }) },
    );
    if (!response.ok) throw new Error("Document announcement failed");
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "document_announcement_failed",
        document_id: id,
        error: error instanceof Error ? error.name : "Error",
      }),
    );
  }
}
export function normalizePatch(input: unknown): Required<DocumentKVPatch> {
  if (input === null) input = {};
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ApiError(400, "bad_request", "invalid KV patch");
  const patch = input as DocumentKVPatch;
  if (
    (patch.set != null &&
      (!patch.set || typeof patch.set !== "object" || Array.isArray(patch.set))) ||
    (patch.delete != null && !Array.isArray(patch.delete))
  )
    throw new ApiError(400, "bad_request", "invalid KV patch");
  const set: Record<string, unknown> = Object.create(null);
  const deleted = new Set<string>();
  const valid = (key: unknown): key is string =>
    typeof key === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(key);
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    if (!valid(key)) throw new ApiError(400, "bad_request", "invalid KV key");
    if (value === null) deleted.add(key);
    else {
      if (new TextEncoder().encode(JSON.stringify(value)).length > 65536)
        throw new ApiError(413, "payload_too_large", "KV value exceeds 64 KiB");
      set[key] = value;
    }
  }
  for (const key of patch.delete ?? []) {
    if (!valid(key)) throw new ApiError(400, "bad_request", "invalid KV key");
    delete set[key];
    deleted.add(key);
  }
  if (Object.keys(set).length + deleted.size > 256)
    throw new ApiError(413, "payload_too_large", "KV patch has too many keys");
  return { set, delete: [...deleted].sort() };
}
export async function snapshot(env: Env, actor: Actor, id: string) {
  await requireDocument(env, actor, id, "viewer");
  const [revision, rows] = await Promise.all([
    env.DB.prepare("SELECT revision FROM document_revisions WHERE document_id=?")
      .bind(id)
      .first<{ revision: number }>(),
    env.DB.prepare(
      "SELECT key,value_json FROM document_kv WHERE document_id=? ORDER BY key",
    )
      .bind(id)
      .all<{ key: string; value_json: string }>(),
  ]);
  return {
    revision: revision?.revision ?? 0,
    items: Object.fromEntries(
      rows.results.map((row) => [row.key, JSON.parse(row.value_json)]),
    ),
  };
}
export async function appendEvent(
  env: Env,
  actor: Actor,
  id: string,
  kind: NonNullable<DocumentKVEvent["kind"]>,
  data?: unknown,
): Promise<DocumentKVEvent> {
  const revision = await env.DB.prepare(
    "SELECT revision FROM document_revisions WHERE document_id=?",
  )
    .bind(id)
    .first<{ revision: number }>();
  const event: DocumentKVEvent = {
    document_id: id,
    revision: (revision?.revision ?? 0) + 1,
    kind,
    changes: [],
    updated_at: new Date().toISOString(),
    updated_by: actor.principal,
    ...(data === undefined ? {} : { data }),
  };
  const statements = [
    env.DB.prepare(
      "INSERT INTO document_revisions(document_id,revision) VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision",
    ).bind(id, event.revision),
    env.DB.prepare(
      "INSERT INTO document_events(document_id,revision,kind,event_json,updated_at) VALUES(?,?,?,?,?)",
    ).bind(id, event.revision, kind, JSON.stringify(event), event.updated_at),
  ];
  if (kind === "presence")
    statements.push(
      env.DB.prepare(
        "DELETE FROM document_events WHERE document_id=? AND kind='presence' AND updated_at<?",
      ).bind(id, new Date(Date.now() - 600000).toISOString()),
    );
  const isLeave =
    typeof data === "object" && data !== null && "left" in data && data.left === true;
  if (kind === "presence" && !isLeave) {
    statements.unshift(
      env.DB.prepare(
        `INSERT INTO state_write_guard(allowed) VALUES((SELECT 1 FROM documents d WHERE d.id=? AND d.deleted_at IS NULL AND ${viewerPredicateFor(env)}))`,
      ).bind(id, actor.principal.id, actor.principal.id),
      env.DB.prepare("DELETE FROM state_write_guard"),
    );
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (kind === "presence" && !isLeave)
      await requireDocument(env, actor, id, "viewer");
    throw error;
  }
  return event;
}
export async function patchState(
  env: Env,
  actor: Actor,
  id: string,
  input: unknown,
): Promise<{ result: DocumentKVPatchResult; event?: DocumentKVEvent }> {
  const patch = normalizePatch(input);
  await requireDocument(env, actor, id, "editor");
  const revision = await env.DB.prepare(
    "SELECT revision FROM document_revisions WHERE document_id=?",
  )
    .bind(id)
    .first<{ revision: number }>();
  const keys = Object.keys(patch.set).sort();
  if (!keys.length && !patch.delete.length)
    return {
      result: {
        revision: revision?.revision ?? 0,
        changes: [],
        updated_by: actor.principal,
      },
    };
  const rev = (revision?.revision ?? 0) + 1,
    at = new Date().toISOString();
  const changes = [
    ...keys.map((key) => ({
      key,
      value: patch.set[key],
      revision: rev,
      updated_at: at,
      updated_by: actor.principal,
      operation: "set",
    })),
    ...patch.delete.map((key) => ({
      key,
      deleted: true,
      revision: rev,
      updated_at: at,
      updated_by: actor.principal,
      operation: "delete",
    })),
  ];
  const event: DocumentKVEvent = {
    document_id: id,
    revision: rev,
    kind: "kv",
    changes,
    updated_at: at,
    updated_by: actor.principal,
  };
  // The authorization guard and all state/event writes commit in one D1 transaction.
  // A failed guard violates the guard table's NOT NULL constraint and rolls back.
  const statements = [
    env.DB.prepare(
      `INSERT INTO state_write_guard(allowed) VALUES((SELECT 1 FROM documents d WHERE d.id=? AND d.deleted_at IS NULL AND ${editorPredicateFor(env)}))`,
    ).bind(id, actor.principal.id, actor.principal.id),
    env.DB.prepare("DELETE FROM state_write_guard"),
  ];
  if (keys.length)
    statements.push(
      env.DB.prepare(
        "INSERT INTO document_kv(document_id,key,value_json,revision,updated_at) SELECT ?,json_extract(value,'$.key'),json_extract(value,'$.value_json'),?,? FROM json_each(?) WHERE true ON CONFLICT(document_id,key) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision,updated_at=excluded.updated_at",
      ).bind(
        id,
        rev,
        at,
        JSON.stringify(
          keys.map((key) => ({ key, value_json: JSON.stringify(patch.set[key]) })),
        ),
      ),
    );
  if (patch.delete.length)
    statements.push(
      env.DB.prepare(
        "DELETE FROM document_kv WHERE document_id=? AND key IN (SELECT value FROM json_each(?))",
      ).bind(id, JSON.stringify(patch.delete)),
    );
  statements.push(
    env.DB.prepare(
      "INSERT INTO document_revisions(document_id,revision) VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision",
    ).bind(id, rev),
    env.DB.prepare(
      "INSERT INTO document_events(document_id,revision,kind,event_json,updated_at) VALUES(?,?,'kv',?,?)",
    ).bind(id, rev, JSON.stringify(event), at),
  );
  try {
    await env.DB.batch(statements);
  } catch (error) {
    await requireDocument(env, actor, id, "editor");
    throw error;
  }
  return { result: { revision: rev, changes, updated_by: actor.principal }, event };
}
