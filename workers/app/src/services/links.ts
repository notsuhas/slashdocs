import { z } from "zod";
import type { Actor, Env } from "../env";
import { ApiError, badRequest } from "../../../shared/errors";
import { requireDocument } from "./permissions";
import { requireComment } from "./comments";
import { extractHeadings } from "./source-metadata";
const headingSchema = z.array(
  z.object({ id: z.string(), text: z.string(), level: z.number().int() }),
);
function fragment(value: string) {
  return encodeURIComponent(value).replace(
    /%(?:21|24|26|27|28|29|2A|2B|2C|3B|3D|3A|40|2F|3F)/gi,
    (code) => decodeURIComponent(code),
  );
}
export function headingURL(env: Env, id: string, heading = "", version = "") {
  return (
    env.APP_ORIGIN.replace(/\/+$/, "") +
    "/app/d/" +
    encodeURIComponent(id) +
    (version ? "?" + new URLSearchParams({ version }) : "") +
    (heading ? "#" + fragment(heading) : "")
  );
}
async function requireVersion(env: Env, id: string, version: string) {
  const row = await env.DB.prepare(
    "SELECT object_key,headings_json FROM versions WHERE id=? AND document_id=?",
  )
    .bind(version, id)
    .first<{ object_key: string; headings_json: string | null }>();
  if (!row) throw new ApiError(404, "not_found", "not found");
  return row;
}
export async function documentHeadings(
  env: Env,
  actor: Actor,
  id: string,
  pinned = "",
) {
  const { document } = await requireDocument(env, actor, id, "viewer");
  const version = await requireVersion(
    env,
    id,
    pinned || document.current_version_id || "",
  );
  let headings;
  if (version.headings_json !== null)
    headings = headingSchema.parse(JSON.parse(version.headings_json));
  else {
    const source = await env.DOCUMENTS.get(version.object_key);
    if (!source) throw new ApiError(500, "internal", "internal server error");
    headings = extractHeadings(new Uint8Array(await source.arrayBuffer()));
  }
  return headings.map((heading) => ({
    ...heading,
    url: headingURL(env, id, heading.id, pinned),
  }));
}
export async function documentLink(
  env: Env,
  actor: Actor,
  id: string,
  comment = "",
  heading = "",
  version = "",
) {
  await requireDocument(env, actor, id, "viewer");
  if (
    new TextEncoder().encode(heading).length > 1024 ||
    (comment && (heading || version))
  )
    badRequest("choose a comment, or a heading and optional version");
  if (version) await requireVersion(env, id, version);
  if (comment) {
    await requireComment(env, id, comment);
    return { url: headingURL(env, id) + "?" + new URLSearchParams({ comment }) };
  }
  return { url: headingURL(env, id, heading, version) };
}
