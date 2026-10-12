import { Hono } from "hono";
import { z } from "zod";
import { REACTION_EMOJI } from "../../../shared/contracts";
import { ApiError, badRequest } from "../../../shared/errors";
import type { AppEnv } from "../env";
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

const body = z.string().max(100000);
const mentions = z
  .array(z.unknown())
  .max(0, "structured mentions are not supported by this deployment")
  .optional();
const anchor = z.object({
  quote: z.string().min(1).max(100000),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  dom_path: z.string().optional(),
  start_offset: z.number().int().nonnegative().optional(),
  end_offset: z.number().int().nonnegative().optional(),
});
const createSchema = z.object({
  body,
  version_id: z.string().min(1),
  anchor,
  mentions,
});
const replySchema = z.object({ body, mentions });
const patchSchema = z.object({
  body: body.optional(),
  status: z.enum(["open", "resolved"]).optional(),
  mentions,
});
const base = "/v1/documents/:id/comments";
export const commentRoutes = new Hono<AppEnv>();
async function input<T>(
  req: { header: (name: string) => string | undefined; json: () => Promise<unknown> },
  schema: z.ZodType<T>,
): Promise<T> {
  const type = req.header("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (
    type !== "application/json" &&
    type !== "application/vnd.slashdocs.comment-mentions+json"
  )
    throw new ApiError(415, "unsupported_media_type", "comment JSON required");
  let parsed;
  try {
    parsed = schema.safeParse(await req.json());
  } catch {
    return badRequest("invalid comment JSON");
  }
  if (!parsed.success)
    return badRequest(parsed.error.issues.map((i) => i.message).join("; "));
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
  if (!["", "all", "open", "resolved", "stale", "orphaned"].includes(status))
    badRequest("invalid comment status");
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
  const data = await input(c.req, createSchema);
  const row = await createComment(
    c.env,
    c.get("actor"),
    c.req.param("id")!,
    data.body,
    data.version_id,
    data.anchor,
  );
  return c.json(await commentJSON(c.env, c.get("actor"), row), 201);
});
commentRoutes.post(base + "/:comment_id/replies", async (c) => {
  await requireDocument(c.env, c.get("actor"), c.req.param("id")!, "commenter");
  const parent = await requireComment(
    c.env,
    c.req.param("id")!,
    c.req.param("comment_id")!,
  );
  const data = await input(c.req, replySchema);
  const row = await createComment(
    c.env,
    c.get("actor"),
    c.req.param("id")!,
    data.body,
    parent.created_on_version_id,
    undefined,
    parent,
  );
  return c.json(await commentJSON(c.env, c.get("actor"), row), 201);
});
commentRoutes.patch(base + "/:comment_id", async (c) => {
  const { role } = await requireDocument(
    c.env,
    c.get("actor"),
    c.req.param("id")!,
    "commenter",
  );
  const row = await requireComment(
    c.env,
    c.req.param("id")!,
    c.req.param("comment_id")!,
  );
  requireMutation(row, c.get("actor"), role);
  const data = await input(c.req, patchSchema);
  if (
    data.mentions !== undefined &&
    c.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !==
      "application/vnd.slashdocs.comment-mentions+json"
  )
    throw new ApiError(
      415,
      "unsupported_media_type",
      "structured comment media type required",
    );
  if (data.body === "" && data.status && data.mentions === undefined)
    data.body = undefined;
  if (data.body !== undefined) validateBody(data.body);
  if (
    data.body === undefined &&
    data.status === undefined &&
    data.mentions === undefined
  )
    badRequest("nothing to update");
  const result = await updateComment(
    c.env,
    c.get("actor"),
    row,
    data.body,
    data.status,
  );
  return c.json(await commentJSON(c.env, c.get("actor"), result));
});
commentRoutes.delete(base + "/:comment_id", async (c) => {
  const { role } = await requireDocument(
    c.env,
    c.get("actor"),
    c.req.param("id")!,
    "commenter",
  );
  const row = await requireComment(
    c.env,
    c.req.param("id")!,
    c.req.param("comment_id")!,
  );
  requireMutation(row, c.get("actor"), role, true);
  await deleteComment(c.env, c.get("actor"), row);
  return c.body(null, 204);
});
for (const method of ["put", "delete"] as const)
  commentRoutes[method](base + "/:comment_id/reactions/:emoji", async (c) => {
    await requireDocument(c.env, c.get("actor"), c.req.param("id")!, "commenter");
    const emoji = c.req.param("emoji")!;
    if (!(REACTION_EMOJI as readonly string[]).includes(emoji))
      badRequest("unsupported reaction");
    const row = await requireComment(
      c.env,
      c.req.param("id")!,
      c.req.param("comment_id")!,
    );
    await writeReaction(c.env, c.get("actor"), row, emoji, method === "delete");
    return c.body(null, 204);
  });
