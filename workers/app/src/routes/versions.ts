import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../../../shared/errors";
import { signRenderCapability } from "../../../shared/render-capability";
import { readUpload } from "../services/content";
import { requireDocument } from "../services/permissions";
import {
  createVersion,
  getVersion,
  versionDTO,
  joinedVersionDTO,
  type VersionWithCreator,
} from "../services/versions";
export const versionRoutes = new Hono<AppEnv>();
versionRoutes.post("/v1/documents/:id/versions", async (c) => {
  await requireDocument(c.env, c.get("actor"), c.req.param("id"), "editor");
  const { form, bytes } = await readUpload(c.env, c.req.raw);
  const base = form.get("base_version_id"),
    summary = form.get("change_summary") ?? "";
  if (typeof base !== "string" || typeof summary !== "string")
    throw new ApiError(400, "bad_request", "base_version_id is required");
  return c.json(
    await createVersion(c.env, c.get("actor"), c.req.param("id"), base, summary, bytes),
    201,
  );
});
versionRoutes.get("/v1/documents/:id/versions", async (c) => {
  await requireDocument(c.env, c.get("actor"), c.req.param("id"), "viewer");
  const { results } = await c.env.DB.prepare(
    "SELECT v.*,u.email AS creator_email,u.name AS creator_name,u.picture_url AS creator_picture_url FROM versions v LEFT JOIN users u ON u.id=v.created_by_user_id WHERE v.document_id=? ORDER BY v.number DESC",
  )
    .bind(c.req.param("id"))
    .all<VersionWithCreator>();
  return c.json({ items: results.map(joinedVersionDTO) });
});
versionRoutes.get("/v1/documents/:id/versions/:version_id", async (c) =>
  c.json(
    await versionDTO(
      c.env,
      await getVersion(
        c.env,
        c.get("actor"),
        c.req.param("id"),
        c.req.param("version_id"),
      ),
    ),
  ),
);
versionRoutes.get("/v1/documents/:id/versions/:version_id/html", async (c) => {
  const v = await getVersion(
    c.env,
    c.get("actor"),
    c.req.param("id"),
    c.req.param("version_id"),
  );
  const object = await c.env.DOCUMENTS.get(v.object_key);
  if (!object) throw new ApiError(502, "blob_storage_failed", "Source is unavailable");
  return new Response(object.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Content-Disposition": `attachment; filename="slashdocs-${v.id}.html"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
});
for (const audience of ["render", "print"] as const)
  versionRoutes.post(
    `/v1/documents/:id/versions/:version_id/${audience}-token`,
    async (c) => {
      const docId = c.req.param("id"),
        v = await getVersion(c.env, c.get("actor"), docId, c.req.param("version_id"));
      const { document } = await requireDocument(
        c.env,
        c.get("actor"),
        docId,
        "viewer",
      );
      const token = await signRenderCapability(c.env.RENDER_PRIVATE_KEY, {
        aud: audience,
        document_id: docId,
        version_id: v.id,
        object_key: v.object_key,
        access_revision: document.access_revision,
        exp: Math.floor(Date.now() / 1000) + (audience === "print" ? 120 : 300),
      });
      const origin = new URL(c.env.RENDER_ORIGIN);
      if (origin.origin === new URL(c.env.APP_ORIGIN).origin)
        throw new ApiError(
          500,
          "configuration_error",
          "Render origin must be separate",
        );
      const url = new URL(
        `/${audience === "print" ? "print" : "v"}/${docId}/${v.id}`,
        origin,
      );
      url.searchParams.set("token", token);
      c.header("Cache-Control", "no-store");
      return c.json({ token, url: url.toString() });
    },
  );
