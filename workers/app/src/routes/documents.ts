import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError } from "../../../shared/errors";
import { createDocument, getDocument, listDocuments } from "../services/documents";
import { readUpload } from "../services/content";
import { requireDocument } from "../services/permissions";
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
documentRoutes.get("/v1/documents", async (c) => {
  if (c.req.query("label"))
    throw new ApiError(400, "unsupported_search", "Labels are not supported");
  return c.json({
    items: await listDocuments(c.env, c.get("actor"), c.req.query("q") ?? ""),
  });
});
documentRoutes.get("/v1/documents/:id", async (c) =>
  c.json(await getDocument(c.env, c.get("actor"), c.req.param("id"))),
);
documentRoutes.patch("/v1/documents/:id", async (c) => {
  const id = c.req.param("id"),
    actor = c.get("actor");
  await requireDocument(c.env, actor, id, "owner");
  const input = z
    .object({ title: z.string().trim().min(1).max(2000) })
    .parse(await c.req.json());
  await c.env.DB.prepare(
    "UPDATE documents SET title=?,updated_at=? WHERE id=? AND owner_user_id=? AND deleted_at IS NULL",
  )
    .bind(input.title, new Date().toISOString(), id, actor.principal.id)
    .run();
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
