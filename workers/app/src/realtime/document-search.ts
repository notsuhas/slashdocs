import { z } from "zod";
import type { Actor, Env } from "../env";
import { revalidateActor } from "../auth/middleware";
import { nowSeconds } from "../auth/tokens";
import { resource } from "../mcp/auth";
import { refreshActorGroups } from "../services/groups";
import { listDocuments } from "../services/documents";
import { indexCurrentVersionBatch } from "../services/source-metadata";
import { ApiError } from "../../../shared/errors";

const identity = {
  id: z.string().min(1),
  email: z.string().optional(),
  name: z.string().optional(),
  picture_url: z.string().optional(),
};
const actorSchema = z.union([
  z.strictObject({
    principal: z.strictObject({ type: z.literal("user"), ...identity }),
    credentialKind: z.enum(["session", "cli", "mcp"]),
    credentialId: z.string().min(1),
  }),
  z.strictObject({
    principal: z.strictObject({ type: z.literal("service_account"), ...identity }),
    credentialKind: z.literal("service_account"),
    credentialId: z.string().min(1),
  }),
]);
const listSchema = z.strictObject({
  actor: actorSchema,
  q: z.string(),
  tz: z.string(),
  label: z.string(),
});
const indexSchema = z.strictObject({ after: z.string().default("") });
const maxBodyBytes = 128 * 1024;

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "bad_request", "Invalid request payload");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBodyBytes) {
      await reader.cancel();
      throw new ApiError(413, "payload_too_large", "Search request exceeds 128 KiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "bad_request", "Invalid request payload");
  }
}

async function validCredential(env: Env, actor: Actor): Promise<boolean> {
  if (actor.credentialKind !== "mcp") return revalidateActor(env, actor);
  if (actor.principal.type !== "user" || !actor.credentialId) return false;
  return !!(await env.DB.prepare(
    "SELECT t.token_hash FROM mcp_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.user_id=? AND t.resource=? AND t.scope='mcp' AND t.expires_at>? AND u.provider!='service_account'",
  )
    .bind(actor.credentialId, actor.principal.id, resource(env), nowSeconds())
    .first());
}

// Only the private namespace binding can invoke this class. No app HTTP route
// forwards caller-supplied actors here. SQLite namespace storage is unused; D1
// and R2 remain canonical. Each request gets the default DO CPU budget.
export class DocumentSearch {
  constructor(
    _state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (
        url.hostname !== "search.internal" ||
        !["/list", "/index"].includes(url.pathname)
      )
        return new Response(null, { status: 404 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await readBody(request);
      if (url.pathname === "/index") {
        const parsed = indexSchema.safeParse(body);
        if (!parsed.success)
          throw new ApiError(400, "bad_request", "Invalid request payload");
        // Possession of the private namespace binding authorizes maintenance.
        return Response.json(
          await indexCurrentVersionBatch(this.env, parsed.data.after),
        );
      }
      const parsed = listSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiError(400, "bad_request", "Invalid request payload");
      const { actor, q, tz, label } = parsed.data;
      if (!(await validCredential(this.env, actor)))
        throw new ApiError(401, "unauthorized", "Invalid credential");
      const currentActor = await refreshActorGroups(this.env, actor);
      return Response.json({
        items: await listDocuments(this.env, currentActor, q, tz, label),
      });
    } catch (error) {
      const e =
        error instanceof ApiError
          ? error
          : new ApiError(500, "internal", "Request failed");
      return Response.json(
        {
          error: {
            code: e.code,
            message: e.message,
            ...(e.details === undefined ? {} : { details: e.details }),
          },
        },
        { status: e.status, headers: { "Cache-Control": "private, no-store" } },
      );
    }
  }
}
