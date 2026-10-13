import { refreshActorGroups } from "../services/groups";
import type { Actor } from "../env";
import {
  notificationPreferences,
  documentRole,
  notificationsEnabled,
  notificationLifetime,
  type NotificationEnv,
} from "../services/notifications";
import {
  DeliveryError,
  documentURL,
  notificationRetry,
  SlackSender,
  type NotificationMessage,
} from "./slack";
export type NotificationKind = "comment" | "access" | "request";
const queues = {
  comment: {
    table: "comment_notification_outbox",
    keys: ["comment_id", "recipient_id"],
  },
  access: {
    table: "document_access_notification_outbox",
    keys: ["document_id", "recipient_id", "source"],
  },
  request: {
    table: "document_access_request_notification_outbox",
    keys: ["document_id", "requester_type", "requester_id"],
  },
};
interface ClaimedBase {
  rowid: number;
  attempts: number;
  recipient_id: string;
}
export type ClaimedNotification = ClaimedBase &
  (
    | { kind: "comment"; comment_id: string; reason: string }
    | {
        kind: "access";
        document_id: string;
        source: string;
        reason: string;
        previous_role: string;
        role: string;
      }
    | {
        kind: "request";
        document_id: string;
        requester_type: "user" | "service_account";
        requester_id: string;
        requester_label: string;
      }
  );

export async function claimNotification(
  env: NotificationEnv,
  kind: NotificationKind,
  now = Date.now(),
) {
  const table = queues[kind].table;
  await env.DB.prepare(`DELETE FROM ${table} WHERE created_at<?`)
    .bind(now - notificationLifetime)
    .run();
  return env.DB.prepare(
    `UPDATE ${table} SET available_at=?,attempts=attempts+1 WHERE rowid=(SELECT rowid FROM ${table} WHERE available_at<=? ORDER BY available_at LIMIT 1) RETURNING rowid,*,'${kind}' AS kind`,
  )
    .bind(now + 60000, now)
    .first<ClaimedNotification>();
}
export async function finishNotification(
  env: NotificationEnv,
  kind: NotificationKind,
  n: ClaimedNotification,
  retryAfter: number,
  now = Date.now(),
) {
  if (n.kind !== kind) throw new Error("Notification queue mismatch");
  const queue = queues[kind];
  const where = queue.keys.map((key) => `${key}=?`).join(" AND ");
  // Rows can be deleted and recreated while an HTTP request is in flight. Match
  // the logical key and attempt, as Go does, rather than relying on SQLite rowid.
  const keyValues = queue.keys.map(
    (key) => Object.entries(n).find(([field]) => field === key)?.[1],
  );
  if (keyValues.some((value) => typeof value !== "string"))
    throw new Error("Invalid claimed notification key");
  const values = keyValues.filter(
    (value): value is string => typeof value === "string",
  );
  if (retryAfter <= 0)
    await env.DB.prepare(`DELETE FROM ${queue.table} WHERE ${where} AND attempts=?`)
      .bind(...values, n.attempts)
      .run();
  else
    await env.DB.prepare(
      `UPDATE ${queue.table} SET available_at=? WHERE ${where} AND attempts=?`,
    )
      .bind(now + retryAfter, ...values, n.attempts)
      .run();
}
interface CommentDeliveryRow {
  id: string;
  document_id: string;
  author_user_id: string;
  author_provider: string;
  body: string;
  anchor_json: string | null;
  parent_comment_id: string | null;
  root_comment_id: string | null;
}
function highlight(anchor: string | null): string {
  if (!anchor) return "";
  try {
    const value: unknown = JSON.parse(anchor);
    return typeof value === "object" &&
      value !== null &&
      "quote" in value &&
      typeof value.quote === "string"
      ? value.quote
      : "";
  } catch {
    return "";
  }
}
export async function deliverNotification(
  env: NotificationEnv,
  kind: NotificationKind,
  n: ClaimedNotification,
  sender: Pick<SlackSender, "send">,
  now = Date.now(),
): Promise<number> {
  if (n.kind !== kind) throw new Error("Notification queue mismatch");
  const user = await env.DB.prepare(
    "SELECT id,email FROM users WHERE id=? AND provider<>'service_account'",
  )
    .bind(n.recipient_id)
    .first<{ id: string; email: string }>();
  if (!user?.email) return 0;
  const actor: Actor = {
    principal: { type: "user", id: user.id, email: user.email },
    credentialKind: "session",
  };
  let documentID = n.kind === "comment" ? "" : n.document_id;
  let comment: CommentDeliveryRow | null = null;
  if (n.kind === "comment") {
    comment = await env.DB.prepare(
      `SELECT c.*,u.provider author_provider FROM comments c JOIN users u ON u.id=c.author_user_id WHERE c.id=? AND c.deleted_at IS NULL AND (c.parent_comment_id IS NULL OR EXISTS(SELECT 1 FROM comments root WHERE root.id=c.root_comment_id AND root.deleted_at IS NULL))`,
    )
      .bind(n.comment_id)
      .first<CommentDeliveryRow>();
    if (
      !comment ||
      (comment.author_provider !== "service_account" &&
        comment.author_user_id === user.id)
    )
      return 0;
    documentID = comment.document_id;
  }
  if (
    !(await notificationPreferences(env, actor.principal, documentID)).effective_enabled
  )
    return 0;
  if (n.kind === "comment" || (n.kind === "access" && n.source !== "direct"))
    await refreshActorGroups(env, actor);
  if (kind === "comment" && !(await documentRole(env, actor, documentID))) return 0;
  if (n.kind === "access") {
    let role: string;
    if (n.source === "direct")
      role =
        (
          await env.DB.prepare(
            "SELECT role FROM document_grants WHERE document_id=? AND principal_type='user' AND principal_id=?",
          )
            .bind(documentID, user.id)
            .first<{ role: string }>()
        )?.role ?? "";
    else role = await documentRole(env, actor, documentID);
    if (role !== n.role) return 0;
  }
  const doc = await env.DB.prepare(
    "SELECT d.title,COALESCE(sa.owner_user_id,d.owner_user_id) notification_owner FROM documents d LEFT JOIN service_accounts sa ON sa.id=d.owner_user_id WHERE d.id=? AND d.deleted_at IS NULL",
  )
    .bind(documentID)
    .first<{ title: string; notification_owner: string }>();
  if (!doc) return 0;
  if (n.kind === "request") {
    if (doc.notification_owner !== user.id) return 0;
    const requester: Actor = {
      principal: { type: n.requester_type, id: n.requester_id },
      credentialKind: n.requester_type === "user" ? "session" : "service_account",
    };
    await refreshActorGroups(env, requester);
    if (await documentRole(env, requester, documentID)) return 0;
  }
  const reserved = await env.DB.prepare(
    "UPDATE users SET next_notification_at=? WHERE id=? AND next_notification_at<=?",
  )
    .bind(now + 6000, user.id, now)
    .run();
  if (!reserved.meta.changes) return 6000;
  const message: NotificationMessage = {
    reason: n.kind === "request" ? "access_requested" : n.reason,
    link: documentURL(env.APP_ORIGIN, documentID),
    documentTitle: doc.title,
  };
  if (kind === "comment" && comment) {
    let quote = highlight(comment.anchor_json);
    if (comment.parent_comment_id) {
      const root = await env.DB.prepare(
        "SELECT document_id,anchor_json FROM comments WHERE id=? AND deleted_at IS NULL",
      )
        .bind(comment.root_comment_id)
        .first<{ document_id: string; anchor_json: string | null }>();
      if (!root || root.document_id !== documentID) return 0;
      quote = highlight(root.anchor_json);
    }
    message.highlight = quote;
    message.body = comment.body;
    message.reply = !!comment.parent_comment_id;
    message.link += "?" + new URLSearchParams({ comment: comment.id }).toString();
  } else if (n.kind === "access") {
    message.previousRole = n.previous_role;
    message.role = n.role;
    message.directAccess = n.source === "direct";
  } else if (n.kind === "request") {
    message.link += "?share=1";
    message.requester = n.requester_label;
  }
  await sender.send(user.email, message);
  return 0;
}
export async function deliverNext(
  env: NotificationEnv,
  kind: NotificationKind,
  sender: Pick<SlackSender, "send">,
  now = Date.now(),
) {
  const n = await claimNotification(env, kind, now);
  if (!n) return false;
  let retry: number;
  try {
    retry = await deliverNotification(env, kind, n, sender, now);
  } catch (error) {
    retry = notificationRetry(n.attempts, error);
    console.warn("notification_delivery_failed", {
      kind,
      delivery_code: error instanceof DeliveryError ? error.code : "internal",
      will_retry: retry > 0,
    });
  }
  await finishNotification(env, kind, n, retry, now);
  return true;
}
export class NotificationDelivery {
  private processing = false;

  constructor(
    private state: DurableObjectState,
    private env: NotificationEnv,
  ) {}

  private async wake() {
    // Version and alarm updates share a storage transaction. Concurrent wakes
    // cannot overwrite an earlier alarm or race with finalization across awaits.
    await this.state.storage.transaction(async (storage) => {
      const generation = (await storage.get<number>("wakeGeneration")) ?? 0;
      await storage.put("wakeGeneration", generation + 1);
      const next = Date.now() + 1000;
      const existing = await storage.getAlarm();
      if (existing === null || existing > next) await storage.setAlarm(next);
    });
  }

  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/wake")
      return new Response(null, { status: 404 });
    await this.wake();
    return new Response(null, { status: 204 });
  }

  async alarm() {
    if (!notificationsEnabled(this.env)) return;
    // A recovery alarm may fire while D1 or Slack is still in flight. Leave
    // another wake instead of processing a second event from each queue.
    if (this.processing) {
      await this.wake();
      return;
    }
    this.processing = true;
    try {
      // Keep recovery armed if D1 or final scheduling fails. Only local storage
      // is serialized; D1 queries and external HTTP never hold this transaction.
      const generation = await this.state.storage.transaction(async (storage) => {
        const version = (await storage.get<number>("wakeGeneration")) ?? 0;
        const next = Date.now() + 1000;
        const existing = await storage.getAlarm();
        if (existing === null || existing > next) await storage.setAlarm(next);
        return version;
      });
      const sender = new SlackSender(this.env.SLASHDOCS_SLACK_BOT_TOKEN?.trim() ?? "");
      try {
        // Match Go's one event per queue per second. D1 leases also protect
        // against another instance processing the same row.
        for (const kind of [
          "comment",
          "access",
          "request",
        ] satisfies NotificationKind[])
          await deliverNext(this.env, kind, sender);
      } finally {
        const next = await this.env.DB.prepare(
          `SELECT MIN(available_at) available_at FROM (SELECT available_at FROM comment_notification_outbox UNION ALL SELECT available_at FROM document_access_notification_outbox UNION ALL SELECT available_at FROM document_access_request_notification_outbox)`,
        ).first<{ available_at: number | null }>();
        await this.state.storage.transaction(async (storage) => {
          // The D1 result may predate an enqueue and wake. In that case its
          // alarm is authoritative, including when MIN returned no rows.
          if (((await storage.get<number>("wakeGeneration")) ?? 0) !== generation)
            return;
          if (next?.available_at !== null && next?.available_at !== undefined)
            await storage.setAlarm(Math.max(Date.now() + 1000, next.available_at));
          else await storage.deleteAlarm();
        });
      }
    } finally {
      this.processing = false;
    }
  }
}
