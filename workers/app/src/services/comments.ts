import type {
  Anchor,
  Comment,
  CommentReaction,
  Principal,
} from "../../../shared/contracts";
import type { Actor, Env, Role } from "../env";
import { ApiError, badRequest } from "../../../shared/errors";
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
  author_email: string;
  author_name: string;
  author_picture_url: string;
}
const SELECT =
  "SELECT c.*,u.email AS author_email,u.name AS author_name,u.picture_url AS author_picture_url FROM comments c JOIN users u ON u.id=c.author_user_id";
const WRITE_ACCESS = `EXISTS (SELECT 1 FROM documents d WHERE d.id=comments.document_id AND d.deleted_at IS NULL AND (d.owner_user_id=? OR EXISTS (SELECT 1 FROM document_grants g WHERE g.document_id=d.id AND g.role IN ('commenter','editor') AND (g.principal_type='anyone' OR (g.principal_type='user' AND g.principal_id=?)))))`;
const CREATE_ACCESS = `EXISTS (SELECT 1 FROM documents d WHERE d.id=? AND d.deleted_at IS NULL AND (d.owner_user_id=? OR EXISTS (SELECT 1 FROM document_grants g WHERE g.document_id=d.id AND g.role IN ('commenter','editor') AND (g.principal_type='anyone' OR (g.principal_type='user' AND g.principal_id=?)))))`;
const MODERATE_ACCESS = `(author_user_id=? OR EXISTS (SELECT 1 FROM documents d WHERE d.id=comments.document_id AND (d.owner_user_id=? OR EXISTS (SELECT 1 FROM document_grants g WHERE g.document_id=d.id AND g.role='editor' AND (g.principal_type='anyone' OR (g.principal_type='user' AND g.principal_id=?))))))`;

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
): Promise<CommentRow> {
  const row = await env.DB.prepare(
    `${SELECT} WHERE c.id=? AND c.document_id=? AND c.deleted_at IS NULL AND (c.parent_comment_id IS NULL OR EXISTS (SELECT 1 FROM comments root WHERE root.id=c.root_comment_id AND root.deleted_at IS NULL))`,
  )
    .bind(id, docId)
    .first<CommentRow>();
  if (!row) throw new ApiError(404, "not_found", "comment not found in document");
  return row;
}
export function requireMutation(
  row: CommentRow,
  actor: Actor,
  role: Role,
  deleting = false,
): void {
  if (
    row.author_user_id === actor.principal.id ||
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
): Promise<CommentRow> {
  validateBody(body);
  const version = await env.DB.prepare(
    "SELECT id FROM versions WHERE id=? AND document_id=?",
  )
    .bind(versionId, docId)
    .first();
  if (!version) throw new ApiError(404, "not_found", "version not found in document");
  const id = newId("cmt");
  const now = new Date().toISOString();
  const parentGuard = parent
    ? " AND EXISTS (SELECT 1 FROM comments p WHERE p.id=? AND p.document_id=? AND p.deleted_at IS NULL)"
    : "";
  const values: (string | null)[] = [
    id,
    docId,
    versionId,
    actor.principal.id,
    parent?.id ?? null,
    parent?.root_comment_id ?? parent?.id ?? id,
    body,
    anchor ? JSON.stringify(anchor) : null,
    now,
    now,
    docId,
    actor.principal.id,
    actor.principal.id,
  ];
  if (parent) values.push(parent.id, docId);
  await changed(
    await env.DB.prepare(
      `INSERT INTO comments(id,document_id,created_on_version_id,author_user_id,parent_comment_id,root_comment_id,body,anchor_json,status,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,'open',?,? WHERE ${CREATE_ACCESS}${parentGuard}`,
    )
      .bind(...values)
      .run(),
  );
  return requireComment(env, docId, id);
}
export async function updateComment(
  env: Env,
  actor: Actor,
  row: CommentRow,
  body: string | undefined,
  status: string | undefined,
): Promise<CommentRow> {
  const now = new Date().toISOString();
  await changed(
    await env.DB.prepare(
      `UPDATE comments SET body=COALESCE(?,body),status=COALESCE(?,status),resolved_at=CASE WHEN ? IS NULL THEN resolved_at WHEN ?='resolved' THEN ? ELSE NULL END,updated_at=? WHERE id=? AND document_id=? AND deleted_at IS NULL AND ${WRITE_ACCESS} AND ${MODERATE_ACCESS}`,
    )
      .bind(
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
      )
      .run(),
  );
  return requireComment(env, row.document_id, row.id);
}
export async function deleteComment(
  env: Env,
  actor: Actor,
  row: CommentRow,
): Promise<void> {
  // A root deletion removes the thread from lists. Replies retain their audit rows.
  await changed(
    await env.DB.prepare(
      `UPDATE comments SET deleted_at=?,updated_at=? WHERE id=? AND document_id=? AND author_user_id=? AND deleted_at IS NULL AND ${WRITE_ACCESS}`,
    )
      .bind(
        new Date().toISOString(),
        new Date().toISOString(),
        row.id,
        row.document_id,
        actor.principal.id,
        actor.principal.id,
        actor.principal.id,
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
      `DELETE FROM comment_reactions WHERE comment_id=? AND user_id=? AND emoji=? AND EXISTS (SELECT 1 FROM comments WHERE id=? AND document_id=? AND deleted_at IS NULL AND ${WRITE_ACCESS})`,
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
      `INSERT OR IGNORE INTO comment_reactions(comment_id,user_id,emoji) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM comments WHERE id=? AND document_id=? AND deleted_at IS NULL AND ${WRITE_ACCESS})`,
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
}
export async function commentJSON(
  env: Env,
  actor: Actor,
  row: CommentRow,
  placementVersionId = row.created_on_version_id,
  html = "",
): Promise<Comment> {
  const reactions = await env.DB.prepare(
    "SELECT r.emoji,u.id,u.email,u.name,u.picture_url FROM comment_reactions r JOIN users u ON u.id=r.user_id WHERE r.comment_id=? ORDER BY r.emoji,u.id",
  )
    .bind(row.id)
    .all<{
      emoji: string;
      id: string;
      email: string;
      name: string;
      picture_url: string;
    }>();
  const groups = new Map<string, CommentReaction>();
  for (const reaction of reactions.results) {
    let group = groups.get(reaction.emoji);
    if (!group) {
      group = { emoji: reaction.emoji, count: 0, reacted: false, reactors: [] };
      groups.set(reaction.emoji, group);
    }
    group.count++;
    if (reaction.id === actor.principal.id) group.reacted = true;
    group.reactors!.push({
      type: "user",
      id: reaction.id,
      email: reaction.email,
      name: reaction.name,
      picture_url: reaction.picture_url,
    } satisfies Principal);
  }
  const output: Comment = {
    id: row.id,
    body: row.body,
    status: row.status,
    author: {
      type: "user",
      id: row.author_user_id,
      email: row.author_email,
      name: row.author_name,
      picture_url: row.author_picture_url,
    },
    created_on_version_id: row.created_on_version_id,
    created_at: row.created_at,
    mentions: [],
    reactions: [...groups.values()],
  };
  if (row.resolved_at) output.resolved_at = row.resolved_at;
  if (row.parent_comment_id) {
    output.parent_comment_id = row.parent_comment_id;
    output.root_comment_id = row.root_comment_id ?? row.parent_comment_id;
  } else {
    const anchor: Anchor = JSON.parse(row.anchor_json ?? "{}");
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
  const rows = await env.DB.prepare(
    `${SELECT} WHERE c.document_id=? AND c.deleted_at IS NULL AND (?='' OR c.created_on_version_id=?) ORDER BY c.created_at,c.id`,
  )
    .bind(docId, filterVersionId, filterVersionId)
    .all<CommentRow>();
  let html = "";
  if (versionId) {
    const version = await env.DB.prepare(
      "SELECT object_key FROM versions WHERE id=? AND document_id=?",
    )
      .bind(versionId, docId)
      .first<{ object_key: string }>();
    if (!version) throw new ApiError(404, "not_found", "version not found in document");
    html = (await (await env.DOCUMENTS.get(version.object_key))?.text()) ?? "";
  }
  const outputs = await Promise.all(
    rows.results.map((row) =>
      commentJSON(env, actor, row, versionId || row.created_on_version_id, html),
    ),
  );
  const roots = new Map<string, Comment>();
  for (const output of outputs)
    if (
      !output.parent_comment_id &&
      (!status ||
        status === "all" ||
        output.status === status ||
        output.current_placement?.status === status)
    ) {
      output.replies = [];
      roots.set(output.id, output);
    }
  for (const output of outputs)
    if (output.parent_comment_id)
      roots
        .get(output.root_comment_id ?? output.parent_comment_id)
        ?.replies?.push(output);
  return [...roots.values()];
}
