import type { Principal } from "../../../shared/contracts";
import { ApiError } from "../../../shared/errors";
import type { Actor, Env, Role } from "../env";
import {
  requireDocument,
  viewerPredicateFor,
  folderGrantRankSQL,
  grantRankSQL,
  grantMatchesActorSQL,
} from "./permissions";

export type NotificationEnv = Env & {
  SLASHDOCS_SLACK_BOT_TOKEN?: string;
  NOTIFICATION_DELIVERY?: DurableObjectNamespace;
};
export const notificationLifetime = 24 * 60 * 60 * 1000;
export function notificationsEnabled(env: NotificationEnv): boolean {
  return !!env.SLASHDOCS_SLACK_BOT_TOKEN?.trim();
}
export interface NotificationPreferences {
  enabled: boolean;
  effective_enabled: boolean;
}
export async function notificationPreferences(
  env: Env,
  principal: Principal,
  documentID = "",
): Promise<NotificationPreferences> {
  const row = await env.DB.prepare(
    `SELECT COALESCE((SELECT enabled FROM notification_preferences WHERE principal_type=? AND principal_id=?),1) AS global_enabled, EXISTS(SELECT 1 FROM document_notification_mutes WHERE principal_type=? AND principal_id=? AND document_id=?) AS muted`,
  )
    .bind(principal.type, principal.id, principal.type, principal.id, documentID)
    .first<{ global_enabled: number; muted: number }>();
  if (!row) throw new Error("Missing preference result");
  return {
    enabled: documentID ? !row.muted : !!row.global_enabled,
    effective_enabled: !!row.global_enabled && !row.muted,
  };
}
export async function setNotificationPreferences(
  env: Env,
  principal: Principal,
  documentID: string,
  enabled: boolean,
) {
  const statements: D1PreparedStatement[] = [];
  if (!documentID)
    statements.push(
      env.DB.prepare(
        "INSERT INTO notification_preferences(principal_type,principal_id,enabled) VALUES(?,?,?) ON CONFLICT(principal_type,principal_id) DO UPDATE SET enabled=excluded.enabled",
      ).bind(principal.type, principal.id, Number(enabled)),
    );
  else if (enabled)
    statements.push(
      env.DB.prepare(
        "DELETE FROM document_notification_mutes WHERE principal_type=? AND principal_id=? AND document_id=?",
      ).bind(principal.type, principal.id, documentID),
    );
  else
    statements.push(
      env.DB.prepare(
        "INSERT INTO document_notification_mutes(principal_type,principal_id,document_id) VALUES(?,?,?) ON CONFLICT DO NOTHING",
      ).bind(principal.type, principal.id, documentID),
    );
  if (!enabled && principal.type === "user") {
    statements.push(
      env.DB.prepare(
        `DELETE FROM comment_notification_outbox WHERE recipient_id=? AND (?='' OR comment_id IN (SELECT id FROM comments WHERE document_id=?))`,
      ).bind(principal.id, documentID, documentID),
    );
    for (const table of [
      "document_access_notification_outbox",
      "document_access_request_notification_outbox",
    ])
      statements.push(
        env.DB.prepare(
          `DELETE FROM ${table} WHERE recipient_id=? AND (?='' OR document_id=?)`,
        ).bind(principal.id, documentID, documentID),
      );
  }
  await env.DB.batch(statements);
  return notificationPreferences(env, principal, documentID);
}
// Trusted expressions supplied only by the builders below.
function eligible(recipient: string, document: string) {
  return `NOT EXISTS(SELECT 1 FROM notification_preferences p WHERE p.principal_type='user' AND p.principal_id=${recipient} AND p.enabled=0) AND NOT EXISTS(SELECT 1 FROM document_notification_mutes m WHERE m.principal_type='user' AND m.principal_id=${recipient} AND m.document_id=${document})`;
}
export async function documentRole(
  env: Env,
  actor: Actor,
  documentID: string,
): Promise<Role | ""> {
  try {
    return (await requireDocument(env, actor, documentID, "viewer")).role;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404))
      return "";
    throw error;
  }
}
export async function requestDocumentAccess(
  env: NotificationEnv,
  actor: Actor,
  documentID: string,
  now = Date.now(),
) {
  const p = actor.principal;
  // Go still resolves access before the disabled-feature check.
  if ((await documentRole(env, actor, documentID)) || !notificationsEnabled(env))
    return;
  let label = p.email ? (p.name ? `${p.name} (${p.email})` : p.email) : (p.name ?? "");
  if (p.type === "service_account") {
    const sa = await env.DB.prepare("SELECT name FROM service_accounts WHERE id=?")
      .bind(p.id)
      .first<{ name: string }>();
    if (!sa) return;
    label = sa.name;
  }
  const token = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO document_access_requests(document_id,requester_type,requester_id,requested_at,request_token) SELECT d.id,?,?,?,? FROM documents d WHERE d.id=? AND d.deleted_at IS NULL AND NOT ${viewerPredicateFor(env)} ON CONFLICT(document_id,requester_type,requester_id) DO UPDATE SET requested_at=excluded.requested_at,request_token=excluded.request_token WHERE document_access_requests.requested_at<=?`,
    ).bind(
      p.type,
      p.id,
      now,
      token,
      documentID,
      p.id,
      p.id,
      now - notificationLifetime,
    ),
    env.DB.prepare(
      `INSERT INTO document_access_request_notification_outbox(document_id,requester_type,requester_id,requester_label,recipient_id,available_at,created_at) SELECT r.document_id,r.requester_type,r.requester_id,?,COALESCE(sa.owner_user_id,d.owner_user_id),?,? FROM document_access_requests r JOIN documents d ON d.id=r.document_id LEFT JOIN service_accounts sa ON sa.id=d.owner_user_id WHERE r.document_id=? AND r.requester_type=? AND r.requester_id=? AND r.request_token=? AND NOT (r.requester_type='user' AND COALESCE(sa.owner_user_id,d.owner_user_id)=r.requester_id) AND ${eligible("COALESCE(sa.owner_user_id,d.owner_user_id)", "d.id")} ON CONFLICT(document_id,requester_type,requester_id) DO UPDATE SET requester_label=excluded.requester_label,recipient_id=excluded.recipient_id,attempts=0,available_at=excluded.available_at,created_at=excluded.created_at`,
    ).bind(label, now, now, documentID, p.type, p.id, token),
  ]);
  await wakeNotificationDelivery(env).catch(() => {
    // The outbox has committed. Scheduled recovery can retry the wake.
    console.warn("notification_wake_failed");
  });
}
// Append to the comment mutation's D1 batch, after comment/mention statements.
export function commentNotificationStatements(
  env: NotificationEnv,
  commentID: string,
  now = Date.now(),
  mutationToken?: string,
): D1PreparedStatement[] {
  if (!notificationsEnabled(env)) return [];
  return [
    env.DB.prepare(
      `WITH subscriptions AS (
 SELECT cm.principal_id recipient_id,'mention' reason,3 priority FROM comment_mentions cm WHERE cm.comment_id=? AND cm.principal_type='user'
 UNION ALL SELECT parent.author_user_id,'reply',2 FROM comments c JOIN comments parent ON parent.id=c.parent_comment_id JOIN users u ON u.id=parent.author_user_id AND u.provider<>'service_account' WHERE c.id=?
 UNION ALL SELECT d.owner_user_id,'owner',1 FROM comments c JOIN documents d ON d.id=c.document_id JOIN users u ON u.id=d.owner_user_id AND u.provider<>'service_account' WHERE c.id=?
 ), ranked AS (SELECT recipient_id,reason,ROW_NUMBER() OVER(PARTITION BY recipient_id ORDER BY priority DESC) position FROM subscriptions)
 INSERT INTO comment_notification_outbox(comment_id,recipient_id,reason,available_at,created_at) SELECT c.id,s.recipient_id,s.reason,?,? FROM comments c JOIN ranked s ON s.position=1 JOIN users recipient ON recipient.id=s.recipient_id JOIN users author ON author.id=c.author_user_id WHERE c.id=? ${mutationToken ? "AND EXISTS(SELECT 1 FROM notification_mutation_guards WHERE token=? AND allowed>0)" : ""} AND NOT(author.provider<>'service_account' AND c.author_user_id=s.recipient_id) AND ${eligible("s.recipient_id", "c.document_id")} ON CONFLICT DO NOTHING`,
    ).bind(
      commentID,
      commentID,
      commentID,
      now,
      now,
      commentID,
      ...(mutationToken ? [mutationToken] : []),
    ),
  ];
}
export function newMentionNotificationStatements(
  env: NotificationEnv,
  commentID: string,
  recipientIDs: string[],
  now = Date.now(),
  mutationToken?: string,
): D1PreparedStatement[] {
  if (!notificationsEnabled(env)) return [];
  return recipientIDs.map((id) =>
    env.DB.prepare(
      `INSERT INTO comment_notification_outbox(comment_id,recipient_id,reason,available_at,created_at) SELECT c.id,?,'mention',?,? FROM comments c JOIN users author ON author.id=c.author_user_id WHERE c.id=? ${mutationToken ? "AND EXISTS(SELECT 1 FROM notification_mutation_guards WHERE token=? AND allowed>0)" : ""} AND NOT(author.provider<>'service_account' AND c.author_user_id=?) AND ${eligible("?", "c.document_id")} ON CONFLICT(comment_id,recipient_id) DO UPDATE SET reason='mention',available_at=MIN(comment_notification_outbox.available_at,excluded.available_at)`,
    ).bind(
      id,
      now,
      now,
      commentID,
      ...(mutationToken ? [mutationToken] : []),
      id,
      id,
      id,
    ),
  );
}
export type AccessSnapshot = Map<string, Role | "">;
export async function documentGrantAccessSnapshot(
  env: Env,
  documentID: string,
  principal: Principal,
): Promise<AccessSnapshot> {
  if (principal.type === "user") {
    const grant = await env.DB.prepare(
      "SELECT role FROM document_grants WHERE document_id=? AND principal_type='user' AND principal_id=?",
    )
      .bind(documentID, principal.id)
      .first<{ role: Role }>();
    return new Map([[principal.id, grant?.role ?? ""]]);
  }
  if (principal.type !== "anyone") return new Map();
  const { results } = await env.DB.prepare(
    "SELECT w.principal_id FROM document_workspace_entries w JOIN users u ON u.id=w.principal_id WHERE w.document_id=? AND w.principal_type='user'",
  )
    .bind(documentID)
    .all<{ principal_id: string }>();
  const snapshot: AccessSnapshot = new Map();
  for (const row of results)
    snapshot.set(
      row.principal_id,
      await documentRole(
        env,
        {
          principal: { type: "user", id: row.principal_id },
          credentialKind: "session",
        },
        documentID,
      ),
    );
  return snapshot;
}
export function accessNotificationStatements(
  env: NotificationEnv,
  documentID: string,
  source: "direct" | "opened",
  actor: Principal,
  before: AccessSnapshot,
  after: AccessSnapshot,
  now = Date.now(),
): D1PreparedStatement[] {
  if (!notificationsEnabled(env)) return [];
  const statements: D1PreparedStatement[] = [];
  for (const [id, previous] of before) {
    const next = after.get(id) ?? "";
    if (previous === next || (actor.type === "user" && actor.id === id)) continue;
    const reason = !previous
      ? "access_shared"
      : !next
        ? "access_removed"
        : "access_updated";
    statements.push(
      env.DB.prepare(
        `INSERT INTO document_access_notification_outbox(document_id,recipient_id,source,reason,previous_role,role,available_at,created_at) SELECT ?,u.id,?,?,?,?,?,? FROM users u WHERE u.id=? AND ${eligible("u.id", "?")} ON CONFLICT(document_id,recipient_id,source) DO UPDATE SET reason=CASE WHEN document_access_notification_outbox.previous_role='' AND excluded.role<>'' THEN 'access_shared' WHEN document_access_notification_outbox.previous_role<>'' AND excluded.role='' THEN 'access_removed' ELSE 'access_updated' END,role=excluded.role,attempts=0,available_at=excluded.available_at,created_at=excluded.created_at`,
      ).bind(documentID, source, reason, previous, next, now, now, id, documentID),
    );
    statements.push(
      env.DB.prepare(
        "DELETE FROM document_access_notification_outbox WHERE document_id=? AND recipient_id=? AND source=? AND previous_role=role",
      ).bind(documentID, id, source),
    );
  }
  return statements;
}
export async function wakeNotificationDelivery(env: NotificationEnv) {
  if (!notificationsEnabled(env) || !env.NOTIFICATION_DELIVERY) return;
  const stub = env.NOTIFICATION_DELIVERY.get(
    env.NOTIFICATION_DELIVERY.idFromName("notifications"),
  );
  const response = await stub.fetch("https://notifications.internal/wake", {
    method: "POST",
  });
  if (!response.ok) throw new Error("Notification alarm could not be scheduled");
}

// Place immediately after the CAS mutation, before any other SQL statement.
// SQLite changes() observes the previous statement on the batch connection.
export function captureNotificationMutation(env: Env, token: string) {
  return env.DB.prepare(
    "INSERT INTO notification_mutation_guards(token,allowed) VALUES(?,changes())",
  ).bind(token);
}
export function clearNotificationMutation(env: Env, token: string) {
  return [
    env.DB.prepare("DELETE FROM notification_access_snapshots WHERE token=?").bind(
      token,
    ),
    env.DB.prepare("DELETE FROM notification_mutation_guards WHERE token=?").bind(
      token,
    ),
  ];
}
function effectiveRoleSQL(recipient: string, env: Env) {
  const rank = `MAX(CASE WHEN d.owner_user_id=${recipient} THEN 4 ELSE 0 END,COALESCE((SELECT MAX(${grantRankSQL}) FROM document_grants g WHERE g.document_id=d.id AND ${grantMatchesActorSQL(recipient, true, env)}),0),${folderGrantRankSQL("d.parent_folder_id", recipient, true, env)})`;
  return `CASE ${rank} WHEN 4 THEN 'owner' WHEN 3 THEN 'editor' WHEN 2 THEN 'commenter' WHEN 1 THEN 'viewer' ELSE '' END`;
}
function directRoleSQL(recipient: string) {
  return `COALESCE((SELECT role FROM document_grants WHERE document_id=d.id AND principal_type='user' AND principal_id=${recipient}), '')`;
}
// Run before the mutation in the same batch. No network reads occur between
// capturing prior access, applying the grant CAS, and computing the new access.
export function snapshotGrantNotificationStatements(
  env: NotificationEnv,
  documentID: string,
  principal: Principal,
  token: string,
) {
  if (!notificationsEnabled(env)) return [];
  if (principal.type === "user")
    return [
      env.DB.prepare(
        `INSERT INTO notification_access_snapshots(token,document_id,recipient_id,source,previous_role) SELECT ?,d.id,?,'direct',${directRoleSQL("?")} FROM documents d WHERE d.id=?`,
      ).bind(token, principal.id, principal.id, documentID),
    ];
  if (principal.type === "anyone")
    return [
      env.DB.prepare(
        `INSERT INTO notification_access_snapshots(token,document_id,recipient_id,source,previous_role) SELECT ?,d.id,w.principal_id,'opened',${effectiveRoleSQL("w.principal_id", env)} FROM documents d JOIN document_workspace_entries w ON w.document_id=d.id JOIN users u ON u.id=w.principal_id WHERE d.id=? AND w.principal_type='user'`,
      ).bind(token, documentID),
    ];
  return [];
}
// Append after captureNotificationMutation and after the grant write. The guard
// is required so a failed grant CAS never emits a notification.
export function queuedGrantNotificationStatements(
  env: NotificationEnv,
  actor: Principal,
  token: string,
  now = Date.now(),
) {
  if (!notificationsEnabled(env)) return [];
  const role = `CASE WHEN snapshot.source='direct' THEN ${directRoleSQL("snapshot.recipient_id")} ELSE ${effectiveRoleSQL("snapshot.recipient_id", env)} END`;
  return [
    env.DB.prepare(
      `WITH changed AS (SELECT snapshot.*,${role} role FROM notification_access_snapshots snapshot JOIN documents d ON d.id=snapshot.document_id WHERE snapshot.token=? AND EXISTS(SELECT 1 FROM notification_mutation_guards WHERE token=? AND allowed>0)) INSERT INTO document_access_notification_outbox(document_id,recipient_id,source,reason,previous_role,role,available_at,created_at) SELECT changed.document_id,changed.recipient_id,changed.source,CASE WHEN changed.previous_role='' THEN 'access_shared' WHEN changed.role='' THEN 'access_removed' ELSE 'access_updated' END,changed.previous_role,changed.role,?,? FROM changed JOIN users u ON u.id=changed.recipient_id WHERE changed.previous_role<>changed.role AND NOT(?='user' AND changed.recipient_id=?) AND ${eligible("changed.recipient_id", "changed.document_id")} ON CONFLICT(document_id,recipient_id,source) DO UPDATE SET reason=CASE WHEN document_access_notification_outbox.previous_role='' AND excluded.role<>'' THEN 'access_shared' WHEN document_access_notification_outbox.previous_role<>'' AND excluded.role='' THEN 'access_removed' ELSE 'access_updated' END,role=excluded.role,attempts=0,available_at=excluded.available_at,created_at=excluded.created_at`,
    ).bind(token, token, now, now, actor.type, actor.id),
    env.DB.prepare(
      `DELETE FROM document_access_notification_outbox WHERE previous_role=role AND EXISTS(SELECT 1 FROM notification_access_snapshots s WHERE s.token=? AND s.document_id=document_access_notification_outbox.document_id AND s.recipient_id=document_access_notification_outbox.recipient_id AND s.source=document_access_notification_outbox.source)`,
    ).bind(token),
  ];
}
