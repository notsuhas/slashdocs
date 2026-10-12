import type { Anchor, Comment, CommentReaction } from "../../../shared/contracts";
import type { Actor, Env, Role } from "../env";
import { ApiError, badRequest } from "../../../shared/errors";
import { commenterPredicateFor, editorPredicateFor } from "./permissions";
import { principalFromIdentity } from "./principals";
import {
  canonicalMentions,
  readMentions,
  documentMentionsStatement,
  groupMentions,
  type MentionRow,
  type StoredMention,
  mentionStatements,
  type MentionInput,
} from "./comment-mentions";
import {
  commentNotificationStatements,
  newMentionNotificationStatements,
  captureNotificationMutation,
  clearNotificationMutation,
  wakeNotificationDelivery,
} from "./notifications";
import { newId } from "../../../shared/ids";

export interface CommentRow {
  id: string;
  document_id: string;
  created_on_version_id: string;
  author_user_id: string;
  parent_comment_id: string | null;
  root_comment_id: string | null;
  body: string;
  anchor_json: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  deleted_at: string | null;
  author_provider: string;
  author_email: string;
  author_name: string;
  author_picture_url: string;
}
const SELECT =
  "SELECT c.*,u.provider AS author_provider,c.author_email,c.author_name,'' AS author_picture_url FROM comments c JOIN users u ON u.id=c.author_user_id";
const WRITE_ACCESS = (env: Env) =>
  `EXISTS (SELECT 1 FROM documents d WHERE d.id=comments.document_id AND d.deleted_at IS NULL AND ${commenterPredicateFor(env)})`;
const CREATE_ACCESS = (env: Env) =>
  `EXISTS (SELECT 1 FROM documents d WHERE d.id=? AND d.deleted_at IS NULL AND ${commenterPredicateFor(env)})`;
const MODERATE_ACCESS = (env: Env) =>
  `(author_user_id=? OR EXISTS (SELECT 1 FROM documents d WHERE d.id=comments.document_id AND d.deleted_at IS NULL AND ${editorPredicateFor(env)}))`;

export function validateBody(body: string): void {
  if (body.includes("\u2063"))
    badRequest(
      "legacy mention markers are not supported; reload the client and try again",
    );
  if (body.length === 0) badRequest("comment body cannot be empty");
}
export async function requireComment(
  env: Env,
  docId: string,
  id: string,
  mutation = false,
): Promise<CommentRow> {
  const row = await env.DB.prepare(
    `${SELECT} WHERE c.id=? AND (?=1 OR c.document_id=?) AND c.deleted_at IS NULL AND (c.parent_comment_id IS NULL OR EXISTS (SELECT 1 FROM comments root WHERE root.id=c.root_comment_id AND root.deleted_at IS NULL))`,
  )
    .bind(id, Number(mutation), docId)
    .first<CommentRow>();
  if (!row && mutation) throw new ApiError(403, "forbidden", "comment access required");
  if (!row || row.document_id !== docId)
    throw new ApiError(404, "not_found", "comment not found in document");
  return row;
}
export function requireMutation(
  row: CommentRow,
  actor: Actor,
  role: Role,
  deleting = false,
): void {
  if (
    (row.author_user_id === actor.principal.id &&
      (row.author_provider === "service_account" ? "service_account" : "user") ===
        actor.principal.type) ||
    (!deleting && (role === "editor" || role === "owner"))
  )
    return;
  throw new ApiError(
    403,
    "forbidden",
    deleting
      ? "only the comment author can delete this comment"
      : "comment access required",
  );
}
async function changed(result: D1Result): Promise<void> {
  if (!result.meta.changes)
    throw new ApiError(403, "forbidden", "comment access changed");
}

export async function createComment(
  env: Env,
  actor: Actor,
  docId: string,
  body: string,
  versionId: string,
  anchor?: Anchor,
  parent?: CommentRow,
  mentions: MentionInput[] = [],
): Promise<CommentRow> {
  validateBody(body);
  const version = await env.DB.prepare(
    "SELECT id FROM versions WHERE id=? AND document_id=?",
  )
    .bind(versionId, docId)
    .first();
  if (!version) throw new ApiError(404, "not_found", "version not found in document");
  const canonical = await canonicalMentions(env, body, mentions);
  const author = await env.DB.prepare("SELECT email,name FROM users WHERE id=?")
    .bind(actor.principal.id)
    .first<{ email: string; name: string }>();
  const id = newId("cmt");
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const parentGuard = parent
    ? " AND EXISTS (SELECT 1 FROM comments p WHERE p.id=? AND p.document_id=? AND p.deleted_at IS NULL)"
    : "";
  const values: (string | null)[] = [
    id,
    docId,
    versionId,
    actor.principal.id,
    author?.email ?? "",
    author?.name ?? "",
    parent?.id ?? null,
    parent?.root_comment_id ?? parent?.id ?? id,
    body,
    anchor
      ? JSON.stringify({
          quote: anchor.quote,
          prefix: anchor.prefix ?? "",
          suffix: anchor.suffix ?? "",
          dom_path: anchor.dom_path ?? "",
          start_offset: anchor.start_offset ?? 0,
          end_offset: anchor.end_offset ?? 0,
        })
      : null,
    now,
    now,
    docId,
    actor.principal.id,
    actor.principal.id,
  ];
  if (parent) values.push(parent.id, docId);
  const writes = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO comments(id,document_id,created_on_version_id,author_user_id,author_email,author_name,parent_comment_id,root_comment_id,body,anchor_json,status,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,'open',?,? WHERE ${CREATE_ACCESS(env)}${parentGuard}`,
    ).bind(...values),
    captureNotificationMutation(env, token),
    ...mentionStatements(env, id, canonical),
    ...commentNotificationStatements(env, id, Date.now(), token),
    ...clearNotificationMutation(env, token),
  ]);
  await changed(writes[0]);
  await wakeNotificationDelivery(env).catch(() => undefined);
  return requireComment(env, docId, id);
}
export async function updateComment(
  env: Env,
  actor: Actor,
  row: CommentRow,
  body: string | undefined,
  status: string | undefined,
  mentions?: MentionInput[],
): Promise<CommentRow> {
  const now = new Date()
    .toISOString()
    .replace(
      "Z",
      String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0") +
        "Z",
    );
  const previous = await readMentions(env, row.id);
  const replace = mentions !== undefined || (body !== undefined && body !== row.body);
  const next =
    mentions !== undefined
      ? await canonicalMentions(env, body ?? row.body, mentions, previous)
      : [];
  const token = crypto.randomUUID();
  const guard =
    "AND EXISTS(SELECT 1 FROM notification_mutation_guards WHERE token=? AND allowed>0)";
  const guardBindings = [token];
  const seen = new Set(
    previous.filter((m) => m.principal.type === "user").map((m) => m.principal.id),
  );
  const newRecipients = [
    ...new Set(
      next
        .filter((m) => m.principal.type === "user" && !seen.has(m.principal.id))
        .map((m) => m.principal.id),
    ),
  ];
  const writes = await env.DB.batch([
    env.DB.prepare(
      `UPDATE comments SET body=COALESCE(?,body),status=COALESCE(?,status),resolved_at=CASE WHEN ? IS NULL THEN resolved_at WHEN ?='resolved' THEN ? ELSE NULL END,updated_at=? WHERE id=? AND document_id=? AND deleted_at IS NULL AND ${WRITE_ACCESS(env)} AND ${MODERATE_ACCESS(env)} AND updated_at=?`,
    ).bind(
      body ?? null,
      status ?? null,
      status ?? null,
      status ?? null,
      now,
      now,
      row.id,
      row.document_id,
      actor.principal.id,
      actor.principal.id,
      actor.principal.id,
      actor.principal.id,
      actor.principal.id,
      row.updated_at,
    ),
    captureNotificationMutation(env, token),
    ...(replace
      ? [
          env.DB.prepare(
            `DELETE FROM comment_mentions WHERE comment_id=? AND EXISTS(SELECT 1 FROM comments WHERE id=? AND deleted_at IS NULL ${guard})`,
          ).bind(row.id, row.id, ...guardBindings),
          ...mentionStatements(env, row.id, next, guard, guardBindings),
        ]
      : []),
    ...newMentionNotificationStatements(env, row.id, newRecipients, Date.now(), token),
    ...clearNotificationMutation(env, token),
  ]);
  await changed(writes[0]);
  await wakeNotificationDelivery(env).catch(() => undefined);
  return requireComment(env, row.document_id, row.id);
}
export async function deleteComment(
  env: Env,
  actor: Actor,
  row: CommentRow,
): Promise<void> {
  const now = new Date().toISOString();
  await changed(
    await env.DB.prepare(
      `WITH RECURSIVE removed(id) AS (
    SELECT comments.id FROM comments WHERE id=? AND document_id=? AND author_user_id=? AND deleted_at IS NULL AND ${WRITE_ACCESS(env)}
    UNION ALL SELECT c.id FROM comments c JOIN removed p ON c.parent_comment_id=p.id
  ) UPDATE comments SET deleted_at=?,updated_at=? WHERE id IN (SELECT id FROM removed)`,
    )
      .bind(
        row.id,
        row.document_id,
        actor.principal.id,
        actor.principal.id,
        actor.principal.id,
        now,
        now,
      )
      .run(),
  );
}
export async function writeReaction(
  env: Env,
  actor: Actor,
  row: CommentRow,
  emoji: string,
  remove: boolean,
): Promise<void> {
  if (remove)
    await env.DB.prepare(
      `DELETE FROM comment_reactions WHERE comment_id=? AND user_id=? AND emoji=? AND EXISTS (SELECT 1 FROM comments WHERE id=? AND document_id=? AND deleted_at IS NULL AND ${WRITE_ACCESS(env)})`,
    )
      .bind(
        row.id,
        actor.principal.id,
        emoji,
        row.id,
        row.document_id,
        actor.principal.id,
        actor.principal.id,
      )
      .run();
  else
    await env.DB.prepare(
      `INSERT OR IGNORE INTO comment_reactions(comment_id,user_id,emoji,created_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM comments WHERE id=? AND document_id=? AND deleted_at IS NULL AND ${WRITE_ACCESS(env)})`,
    )
      .bind(
        row.id,
        actor.principal.id,
        emoji,
        new Date().toISOString(),
        row.id,
        row.document_id,
        actor.principal.id,
        actor.principal.id,
      )
      .run();
}
interface ReactionRow {
  provider: string;
  comment_id: string;
  emoji: string;
  id: string;
  email: string;
  name: string;
  picture_url: string;
}
export async function commentJSON(
  env: Env,
  actor: Actor,
  row: CommentRow,
  placementVersionId = row.created_on_version_id,
  html = "",
  hydratedReactions?: ReactionRow[],
  hydratedMentions?: StoredMention[],
): Promise<Comment> {
  const reactions =
    hydratedReactions ??
    (
      await env.DB.prepare(
        "SELECT r.comment_id,r.emoji,u.id,u.provider,u.email,u.name,'' AS picture_url FROM comment_reactions r JOIN users u ON u.id=r.user_id WHERE r.comment_id=? ORDER BY r.comment_id,r.created_at,r.emoji,CASE WHEN u.provider='service_account' THEN 'service_account' ELSE 'user' END,u.id",
      )
        .bind(row.id)
        .all<ReactionRow>()
    ).results;
  const groups = new Map<string, CommentReaction>();
  for (const reaction of reactions) {
    let group = groups.get(reaction.emoji);
    if (!group) {
      group = { emoji: reaction.emoji, count: 0, reacted: false, reactors: [] };
      groups.set(reaction.emoji, group);
    }
    group.count++;
    if (
      reaction.id === actor.principal.id &&
      (reaction.provider === "service_account" ? "service_account" : "user") ===
        actor.principal.type
    )
      group.reacted = true;
    group.reactors!.push(
      principalFromIdentity({
        provider: reaction.provider,
        id: reaction.id,
        email: reaction.email,
        name: reaction.name,
        picture_url: reaction.picture_url,
      }),
    );
  }
  const output: Comment = {
    id: row.id,
    body: row.body,
    status: row.status,
    author: principalFromIdentity({
      provider: row.author_provider,
      id: row.author_user_id,
      email: row.author_email,
      name: row.author_name,
      picture_url: row.author_picture_url,
    }),
    created_on_version_id: row.created_on_version_id,
    created_at: row.created_at,
    mentions: (hydratedMentions ?? (await readMentions(env, row.id))).map(
      ({ principal, offset, length }) => ({ principal, offset, length }),
    ),
    reactions: [...groups.values()],
  };
  if (row.resolved_at) output.resolved_at = row.resolved_at;
  if (row.parent_comment_id) {
    output.parent_comment_id = row.parent_comment_id;
  } else {
    const stored: Anchor = JSON.parse(row.anchor_json ?? "{}");
    const anchor = {
      quote: stored.quote,
      prefix: stored.prefix ?? "",
      suffix: stored.suffix ?? "",
      dom_path: stored.dom_path ?? "",
      start_offset: stored.start_offset ?? 0,
      end_offset: stored.end_offset ?? 0,
    };
    output.anchor = anchor;
    output.selected_text = anchor.quote;
    const attached =
      placementVersionId === row.created_on_version_id ||
      !html ||
      html.includes(anchor.quote);
    const placement = {
      version_id: placementVersionId,
      anchor,
      status: attached ? "attached" : "orphaned",
      confidence: attached ? 1 : 0,
      matched_text: attached ? anchor.quote : "",
    };
    output.current_placement = placement;
  }
  return output;
}
export async function listComments(
  env: Env,
  actor: Actor,
  docId: string,
  status: string,
  versionId: string,
  filterVersionId = "",
): Promise<Comment[]> {
  // D1 batch reads share one transaction, matching the Go repeatable-read list.
  const snapshot = await env.DB.batch<
    CommentRow | ReactionRow | MentionRow | { object_key: string }
  >([
    env.DB.prepare(
      `${SELECT} WHERE c.document_id=? AND c.deleted_at IS NULL AND (?='' OR c.created_on_version_id=?) AND (?='' OR c.status=?) ORDER BY c.created_at,c.id`,
    ).bind(docId, filterVersionId, filterVersionId, status, status),
    env.DB.prepare("SELECT object_key FROM versions WHERE id=? AND document_id=?").bind(
      versionId,
      docId,
    ),
    env.DB.prepare(
      "SELECT r.comment_id,r.emoji,u.id,u.provider,u.email,u.name,'' AS picture_url FROM comment_reactions r JOIN users u ON u.id=r.user_id JOIN comments c ON c.id=r.comment_id WHERE c.document_id=? AND c.deleted_at IS NULL ORDER BY r.comment_id,r.created_at,r.emoji,CASE WHEN u.provider='service_account' THEN 'service_account' ELSE 'user' END,u.id",
    ).bind(docId),
    documentMentionsStatement(env, docId),
  ]);
  const rows = snapshot[0].results.filter((row): row is CommentRow => "body" in row);
  const version = snapshot[1].results.find(
    (row): row is { object_key: string } => "object_key" in row,
  );
  const reactions = snapshot[2].results.filter(
    (row): row is ReactionRow => "emoji" in row,
  );
  const mentionsByComment = groupMentions(
    snapshot[3].results.filter((row): row is MentionRow => "offset" in row),
  );
  const html = version
    ? ((await (await env.DOCUMENTS.get(version.object_key))?.text()) ?? "")
    : "";
  const byComment = new Map<string, ReactionRow[]>();
  for (const reaction of reactions) {
    const group = byComment.get(reaction.comment_id) ?? [];
    group.push(reaction);
    byComment.set(reaction.comment_id, group);
  }
  const outputs = await Promise.all(
    rows.map((row) =>
      commentJSON(
        env,
        actor,
        row,
        versionId || row.created_on_version_id,
        html,
        byComment.get(row.id) ?? [],
        mentionsByComment.get(row.id) ?? [],
      ),
    ),
  );
  const roots = new Map<string, Comment>();
  for (const output of outputs)
    if (!output.parent_comment_id) {
      output.replies = [];
      roots.set(output.id, output);
    }
  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i];
    const row = rows[i];
    if (row.parent_comment_id)
      roots.get(row.root_comment_id ?? row.parent_comment_id)?.replies?.push(output);
  }
  return [...roots.values()];
}
