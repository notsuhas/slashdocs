import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError, badRequest } from "../../../shared/errors";
import { requestMediaType } from "../services/media-type";
import { announceDocumentEvent } from "../services/state";
import { createDocument, getDocument } from "../services/documents";
import { documentListResponse } from "../services/search-runtime";
import { readUpload } from "../services/content";
import { requireDocument } from "../services/permissions";
import { documentHeadings, documentLink } from "../services/links";
export const documentRoutes = new Hono<AppEnv>();
documentRoutes.post("/v1/documents", async (c) => {
  const { form, bytes } = await readUpload(c.env, c.req.raw);
  const title = form.get("title"),
    permission =
      form.get("default_permission") ?? c.env.DEFAULT_DOC_PERMISSION ?? "private";
  if (typeof title !== "string" || typeof permission !== "string")
    throw new ApiError(400, "bad_request", "Invalid document upload");
  return c.json(
    await createDocument(c.env, c.get("actor"), title, bytes, permission),
    201,
  );
});
documentRoutes.get("/v1/documents", async (c) =>
  documentListResponse(
    c.env,
    c.get("actor"),
    c.req.query("q") ?? "",
    c.req.query("tz") ?? "UTC",
    c.req.query("label") ?? "",
  ),
);
documentRoutes.get("/v1/documents/:id", async (c) =>
  c.json(await getDocument(c.env, c.get("actor"), c.req.param("id"))),
);
documentRoutes.patch("/v1/documents/:id", async (c) => {
  const id = c.req.param("id"),
    actor = c.get("actor");
  await requireDocument(c.env, actor, id, "owner");
  if (requestMediaType(c.req) !== "application/json")
    throw new ApiError(
      415,
      "unsupported_media_type",
      "content-type must be application/json",
    );
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return badRequest("invalid body");
  }
  const parsed = z
    .object({ Title: z.string().optional(), title: z.string().optional() })
    .safeParse(raw);
  if (!parsed.success) return badRequest("invalid body");
  const title = parsed.data.title ?? parsed.data.Title ?? "";
  if (!title) return badRequest("nothing to update; provide a title");
  await c.env.DB.prepare(
    "UPDATE documents SET title=?,updated_at=? WHERE id=? AND owner_user_id=? AND deleted_at IS NULL",
  )
    .bind(title, new Date().toISOString(), id, actor.principal.id)
    .run();
  await announceDocumentEvent(c.env, actor, id, "document").catch(() => undefined);
  return c.json(await getDocument(c.env, actor, id));
});
documentRoutes.delete("/v1/documents/:id", async (c) => {
  const id = c.req.param("id"),
    actor = c.get("actor");
  await requireDocument(c.env, actor, id, "owner");
  await c.env.DB.prepare(
    "UPDATE documents SET deleted_at=?,access_revision=access_revision+1 WHERE id=? AND owner_user_id=? AND deleted_at IS NULL",
  )
    .bind(new Date().toISOString(), id, actor.principal.id)
    .run();
  return c.body(null, 204);
});

documentRoutes.get("/v1/documents/:id/headings", async (c) =>
  c.json({
    items: await documentHeadings(
      c.env,
      c.get("actor"),
      c.req.param("id"),
      c.req.query("version") ?? "",
    ),
  }),
);
documentRoutes.get("/v1/documents/:id/link", async (c) =>
  c.json(
    await documentLink(
      c.env,
      c.get("actor"),
      c.req.param("id"),
      c.req.query("comment") ?? "",
      c.req.query("heading") ?? "",
      c.req.query("version") ?? "",
    ),
  ),
);
