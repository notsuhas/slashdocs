import type { CommentMention } from "../../../shared/contracts";
import type { Env } from "../env";
import { badRequest } from "../../../shared/errors";
import { principalFromIdentity, type IdentityRow } from "./principals";

export interface MentionInput {
  principal: { type: string; id: string };
  offset: number;
  length: number;
}
export interface StoredMention extends CommentMention {
  label_text: string;
}
export interface MentionRow extends IdentityRow {
  comment_id: string;
  principal_type: "user" | "service_account";
  offset: number;
  length: number;
  label_text: string;
}
export async function readMentions(
  env: Env,
  commentId: string,
): Promise<StoredMention[]> {
  const rows = await env.DB.prepare(
    "SELECT m.*,m.principal_id AS id,u.provider,u.email,u.name,u.picture_url FROM comment_mentions m LEFT JOIN users u ON u.id=m.principal_id WHERE m.comment_id=? ORDER BY m.offset,m.principal_type,m.principal_id",
  )
    .bind(commentId)
    .all<MentionRow>();
  return rows.results.map(storedMention);
}
function storedMention(row: MentionRow): StoredMention {
  return {
    principal: { ...principalFromIdentity(row), type: row.principal_type },
    offset: row.offset,
    length: row.length,
    label_text: row.label_text,
  };
}
export function documentMentionsStatement(
  env: Env,
  docId: string,
): D1PreparedStatement {
  return env.DB.prepare(
    "SELECT m.*,m.principal_id AS id,u.provider,u.email,u.name,u.picture_url FROM comment_mentions m JOIN comments c ON c.id=m.comment_id LEFT JOIN users u ON u.id=m.principal_id WHERE c.document_id=? AND c.deleted_at IS NULL ORDER BY m.comment_id,m.offset,m.principal_type,m.principal_id",
  ).bind(docId);
}
export function groupMentions(rows: MentionRow[]): Map<string, StoredMention[]> {
  const grouped = new Map<string, StoredMention[]>();
  for (const row of rows) {
    const group = grouped.get(row.comment_id) ?? [];
    group.push(storedMention(row));
    grouped.set(row.comment_id, group);
  }
  return grouped;
}
const space = /^\p{White_Space}$/u;
const punctuation = /^\p{Punctuation}$/u;
const connector = /^\p{Connector_Punctuation}$/u;
function invalid(): never {
  return badRequest("invalid comment mention");
}
export async function canonicalMentions(
  env: Env,
  body: string,
  input: MentionInput[],
  historical: StoredMention[] = [],
): Promise<StoredMention[]> {
  if (
    input.length > 50 ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(body)
  )
    invalid();
  const ordered = [...input].sort(
    (a, b) =>
      a.offset - b.offset ||
      a.length - b.length ||
      (a.principal.type < b.principal.type
        ? -1
        : a.principal.type > b.principal.type
          ? 1
          : a.principal.id < b.principal.id
            ? -1
            : a.principal.id > b.principal.id
              ? 1
              : 0),
  );
  const boundaries = new Set([0]);
  let position = 0;
  for (const point of body) {
    position += point.length;
    boundaries.add(position);
  }
  const prior = new Map<string, number>();
  for (const mention of historical) {
    const key = JSON.stringify([
      mention.principal.type,
      mention.principal.id,
      mention.label_text,
    ]);
    prior.set(key, (prior.get(key) ?? 0) + 1);
  }
  const snapshots: (MentionInput & { label_text: string })[] = [];
  let previousEnd = 0;
  for (const mention of ordered) {
    const end = mention.offset + mention.length;
    if (
      !Number.isInteger(mention.offset) ||
      !Number.isInteger(mention.length) ||
      mention.offset < 0 ||
      mention.offset > 2147483647 ||
      mention.length <= 0 ||
      mention.length > 2147483647 ||
      mention.offset < previousEnd ||
      end > body.length ||
      !boundaries.has(mention.offset) ||
      !boundaries.has(end) ||
      !mention.principal.id ||
      !["user", "service_account"].includes(mention.principal.type)
    )
      invalid();
    previousEnd = end;
    const before = [...body.slice(0, mention.offset)].at(-1);
    if (before && !space.test(before) && !"([{ ".includes(before)) invalid();
    for (const point of body.slice(end)) {
      if (space.test(point)) break;
      if (!punctuation.test(point) || connector.test(point) || "_%+-@'".includes(point))
        invalid();
    }
    const label = body.slice(mention.offset, end);
    if (!label.startsWith("@") || label === "@") invalid();
    snapshots.push({ ...mention, label_text: label });
  }
  if (!snapshots.length) return [];
  const ids = [...new Set(snapshots.map((mention) => mention.principal.id))];
  const rows = await env.DB.prepare(
    `SELECT id,provider,email,name,picture_url FROM users WHERE id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .all<IdentityRow>();
  const identities = new Map(rows.results.map((identity) => [identity.id, identity]));
  const output: StoredMention[] = [];
  for (const mention of snapshots) {
    const label = mention.label_text;
    const identity = identities.get(mention.principal.id);
    if (
      !identity ||
      (identity.provider === "service_account" ? "service_account" : "user") !==
        mention.principal.type
    )
      invalid();
    const principal = principalFromIdentity(identity);
    if (principal.type !== "user" && principal.type !== "service_account") invalid();
    if (
      ![principal.id, principal.email, principal.name].some(
        (value) => value && label === "@" + value,
      )
    ) {
      const key = JSON.stringify([principal.type, principal.id, label]);
      const count = prior.get(key) ?? 0;
      if (!count) invalid();
      prior.set(key, count - 1);
    }
    output.push({
      principal: { ...principal, type: principal.type },
      offset: mention.offset,
      length: mention.length,
      label_text: label,
    });
  }
  return output;
}
export function mentionStatements(
  env: Env,
  commentId: string,
  mentions: StoredMention[],
  guard = "",
  bindings: string[] = [],
): D1PreparedStatement[] {
  if (!mentions.length) return [];
  return [
    env.DB.prepare(
      `INSERT INTO comment_mentions(comment_id,principal_type,principal_id,offset,length,label_text)
    SELECT ?,json_extract(m.value,'$.principal.type'),json_extract(m.value,'$.principal.id'),json_extract(m.value,'$.offset'),json_extract(m.value,'$.length'),json_extract(m.value,'$.label_text') FROM json_each(?) m
    WHERE EXISTS(SELECT 1 FROM comments WHERE id=? AND deleted_at IS NULL ${guard})`,
    ).bind(commentId, JSON.stringify(mentions), commentId, ...bindings),
  ];
}
