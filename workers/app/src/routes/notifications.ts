import { Hono } from "hono";
import type { AppEnv } from "../env";
import { badRequest } from "../../../shared/errors";
import { requireDocument } from "../services/permissions";
import {
  notificationPreferences,
  setNotificationPreferences,
  requestDocumentAccess,
} from "../services/notifications";
export const notificationRoutes = new Hono<AppEnv>();
for (const path of ["/v1/me/notifications", "/v1/documents/:id/notifications"]) {
  notificationRoutes.get(path, async (c) => {
    const id = c.req.param("id") ?? "";
    if (id) await requireDocument(c.env, c.get("actor"), id, "viewer");
    return c.json(await notificationPreferences(c.env, c.get("actor").principal, id));
  });
  notificationRoutes.put(path, async (c) => {
    const id = c.req.param("id") ?? "";
    if (id) await requireDocument(c.env, c.get("actor"), id, "viewer");
    let data: unknown;
    try {
      const raw = await c.req.text();
      if (new TextEncoder().encode(raw).byteLength > 1024)
        return badRequest("enabled must be a boolean");
      data = JSON.parse(raw);
    } catch {
      return badRequest("enabled must be a boolean");
    }
    if (
      typeof data !== "object" ||
      data === null ||
      !("enabled" in data) ||
      typeof data.enabled !== "boolean"
    )
      return badRequest("enabled must be a boolean");
    return c.json(
      await setNotificationPreferences(
        c.env,
        c.get("actor").principal,
        id,
        data.enabled,
      ),
    );
  });
}
notificationRoutes.post("/v1/documents/:id/access-requests", async (c) => {
  await requestDocumentAccess(c.env, c.get("actor"), c.req.param("id"));
  return c.json({ status: "sent" }, 202);
});
