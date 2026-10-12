import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { badRequest } from "../../../shared/errors";
import { requireDocument } from "../services/permissions";
import {
  listDocumentLabels,
  replaceDocumentLabels,
  requireLabels,
} from "../services/labels";
export const labelRoutes = new Hono<AppEnv>();
labelRoutes.get("/v1/documents/:id/labels", async (c) => {
  requireLabels(c.env);
  await requireDocument(c.env, c.get("actor"), c.req.param("id"), "viewer");
  return c.json({ items: await listDocumentLabels(c.env, c.req.param("id")) });
});
labelRoutes.put("/v1/documents/:id/labels", async (c) => {
  requireLabels(c.env);
  await requireDocument(c.env, c.get("actor"), c.req.param("id"), "editor");
  const schema = z.object({ labels: z.array(z.string()).nullable().optional() });
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return badRequest("labels are required");
  }
  const input = schema.safeParse(raw);
  if (!input.success) return badRequest("labels are required");
  return c.json({
    items: await replaceDocumentLabels(
      c.env,
      c.get("actor"),
      c.req.param("id"),
      input.data.labels ?? [],
    ),
  });
});
