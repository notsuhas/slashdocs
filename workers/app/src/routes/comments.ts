import { Hono } from "hono";
import { z } from "zod";
import { REACTION_EMOJI } from "../../../shared/contracts";
import { ApiError, badRequest } from "../../../shared/errors";
import type { AppEnv } from "../env";
import { requestMediaType } from "../services/media-type";
import { announceDocumentEvent } from "../services/state";
import { requireDocument } from "../services/permissions";
import {
  commentJSON,
  createComment,
  deleteComment,
  listComments,
  requireComment,
  requireMutation,
  updateComment,
  validateBody,
  writeReaction,
} from "../services/comments";

const body = z
  .string()
  .transform((value) => new TextDecoder().decode(new TextEncoder().encode(value)));
const mentionPrincipal = z
  .object({
    type: z
      .string()
      .nullable()
      .optional()
      .transform((value) => value ?? ""),
    id: z
      .string()
      .nullable()
      .optional()
      .transform((value) => value ?? ""),
  })
  .nullable()
  .optional()
  .transform((value) => value ?? { type: "", id: "" });
const mentionSchema = z
  .object({
    principal: mentionPrincipal,
    offset: z
      .number()
      .int()
      .nullable()
      .optional()
      .transform((value) => value ?? 0),
    length: z
      .number()
      .int()
      .nullable()
      .optional()
      .transform((value) => value ?? 0),
  })
  .nullable()
  .transform(
    (value) => value ?? { principal: { type: "", id: "" }, offset: 0, length: 0 },
  );
const mentions = z.array(mentionSchema).nullable().optional();
const structuredTypes = [
  "application/vnd.slashdocs.comment-mentions+json",
  "application/vnd.aidocs.comment-mentions+json",
];
function isStructured(req: { header: (name: string) => string | undefined }): boolean {
  return structuredTypes.includes(requestMediaType(req));
}
function requireStructured(req: {
  header: (name: string) => string | undefined;
}): void {
  if (!isStructured(req))
    throw new ApiError(
      415,
      "unsupported_media_type",
      "structured comment mentions require content-type application/vnd.slashdocs.comment-mentions+json",
    );
}
const anchor = z.object({
  quote: z.string().min(1),
  prefix: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? ""),
  suffix: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? ""),
  dom_path: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? ""),
  start_offset: z
    .number()
    .int()
    .nullable()
    .optional()
    .transform((value) => value ?? 0),
  end_offset: z
    .number()
    .int()
    .nullable()
    .optional()
    .transform((value) => value ?? 0),
});
const createSchema = z.object({
  body,
  version_id: z.string().min(1),
  anchor,
  mentions,
});
const replySchema = z.object({ body, mentions });
const patchSchema = z.object({
  body: body
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
  status: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
  mentions,
});
const base = "/v1/documents/:id/comments";
export const commentRoutes = new Hono<AppEnv>();
async function input<T>(
  req: { header: (name: string) => string | undefined; json: () => Promise<unknown> },
  schema: z.ZodType<T>,
  invalidMessage: string,
): Promise<T> {
  const type = requestMediaType(req);
  if (type !== "application/json" && !structuredTypes.includes(type ?? ""))
    throw new ApiError(
      415,
      "unsupported_media_type",
      "content-type must be application/json or application/vnd.slashdocs.comment-mentions+json",
    );
  let parsed;
  try {
    parsed = schema.safeParse(await req.json());
  } catch {
    return badRequest(invalidMessage);
  }
  if (!parsed.success) return badRequest(invalidMessage);
  return parsed.data;
}
commentRoutes.get(base, async (c) => {
  const { document } = await requireDocument(
    c.env,
    c.get("actor"),
    c.req.param("id")!,
    "viewer",
  );
  const status = c.req.query("status") ?? "";
  return c.json({
    items: await listComments(
      c.env,
      c.get("actor"),
      document.id,
      status,
      c.req.query("version_id") || document.current_version_id || "",
      c.req.query("version_id") || "",
    ),
  });
});
commentRoutes.post(base, async (c) => {
  await requireDocument(c.env, c.get("actor"), c.req.param("id")!, "commenter");
  const data = await input(c.req, createSchema, "invalid comment");
  if (data.mentions?.length) requireStructured(c.req);
  if (data.body === "") badRequest("invalid comment");
  const row = await createComment(
    c.env,
    c.get("actor"),
    c.req.param("id")!,
    data.body,
    data.version_id,
    data.anchor,
    undefined,
    data.mentions ?? [],
  );
  await announceDocumentEvent(
    c.env,
    c.get("actor"),
    c.req.param("id")!,
    "comments",
  ).catch(() => undefined);
  return c.json(await commentJSON(c.env, c.get("actor"), row), 201);
});
commentRoutes.post(base + "/:comment_id/replies", async (c) => {
  await requireDocument(c.env, c.get("actor"), c.req.param("id")!, "commenter");
  const data = await input(c.req, replySchema, "invalid reply");
  if (data.mentions?.length) requireStructured(c.req);
  if (data.body === "") badRequest("invalid reply");
  const parent = await requireComment(
    c.env,
    c.req.param("id")!,
    c.req.param("comment_id")!,
  );
  const row = await createComment(
    c.env,
    c.get("actor"),
    c.req.param("id")!,
    data.body,
    parent.created_on_version_id,
    undefined,
    parent,
    data.mentions ?? [],
  );
  await announceDocumentEvent(
    c.env,
    c.get("actor"),
    c.req.param("id")!,
    "comments",
  ).catch(() => undefined);
  return c.json(await commentJSON(c.env, c.get("actor"), row), 201);
});
commentRoutes.patch(base + "/:comment_id", async (c) => {
  const row = await requireComment(
    c.env,
    c.req.param("id")!,
    c.req.param("comment_id")!,
    true,
  );
  const { role } = await requireDocument(
    c.env,
    c.get("actor"),
    c.req.param("id")!,
    "commenter",
  );
  requireMutation(row, c.get("actor"), role);
  const data = await input(c.req, patchSchema, "invalid body");
  if (data.mentions != null) requireStructured(c.req);
  if (data.status === "") data.status = undefined;
  if (data.body === "" && data.status && data.mentions == null) data.body = undefined;
  if (data.body !== undefined) validateBody(data.body);
  if (data.status !== undefined && data.status !== "open" && data.status !== "resolved")
    badRequest("invalid comment status");
  if (data.body === undefined && data.status === undefined && data.mentions == null)
    badRequest("nothing to update");
  const result = await updateComment(
    c.env,
    c.get("actor"),
    row,
    data.body,
    data.status,
    data.mentions ?? undefined,
  );
  await announceDocumentEvent(
    c.env,
    c.get("actor"),
    c.req.param("id")!,
    "comments",
  ).catch(() => undefined);
  return c.json(await commentJSON(c.env, c.get("actor"), result));
});
commentRoutes.delete(base + "/:comment_id", async (c) => {
  const row = await requireComment(
    c.env,
    c.req.param("id")!,
    c.req.param("comment_id")!,
    true,
  );
  const { role } = await requireDocument(
    c.env,
    c.get("actor"),
    c.req.param("id")!,
    "commenter",
  );
  requireMutation(row, c.get("actor"), role, true);
  await deleteComment(c.env, c.get("actor"), row);
  await announceDocumentEvent(
    c.env,
    c.get("actor"),
    c.req.param("id")!,
    "comments",
  ).catch(() => undefined);
  return c.body(null, 204);
});
for (const method of ["put", "delete"] as const)
  commentRoutes[method](base + "/:comment_id/reactions/:emoji", async (c) => {
    const emoji = c.req.param("emoji")!;
    if (!(REACTION_EMOJI as readonly string[]).includes(emoji))
      badRequest("unsupported reaction");
    await requireDocument(c.env, c.get("actor"), c.req.param("id")!, "commenter");
    const row = await requireComment(
      c.env,
      c.req.param("id")!,
      c.req.param("comment_id")!,
    );
    await writeReaction(c.env, c.get("actor"), row, emoji, method === "delete");
    await announceDocumentEvent(
      c.env,
      c.get("actor"),
      c.req.param("id")!,
      "comments",
    ).catch(() => undefined);
    return c.body(null, 204);
  });
