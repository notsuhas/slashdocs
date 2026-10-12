import { Hono } from "hono";
import type { AppEnv } from "../env";
export const configRoutes = new Hono<AppEnv>();
for (const path of [
  "/v1/config",
  "/.well-known/slashdocs.json",
  "/.well-known/aidocs.json",
]) {
  configRoutes.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
}
for (const path of ["/.well-known/slashdocs.json", "/.well-known/aidocs.json"]) {
  configRoutes.get(path, (c) =>
    c.json({ name: "slashdocs", api_version: "v1", auth: { modes: ["web", "cli"] } }),
  );
}
configRoutes.get("/v1/config", (c) => {
  const deployment = c.env.DEPLOYMENT === "public" ? "public" : "org";
  const orgName = c.env.ORG_NAME ?? "";
  return c.json({
    deployment,
    org_name: orgName,
    everyone_label:
      deployment === "org"
        ? orgName
          ? `Anyone in ${orgName}`
          : "Anyone in the org"
        : "Anyone with the link",
    provider_name: "Google",
    default_doc_permission: c.env.DEFAULT_DOC_PERMISSION ?? "private",
    google_groups_enabled: false,
    labels_enabled: false,
    capabilities: {
      mcp: false,
      structured_mentions: false,
      folders: false,
      groups: false,
      labels: false,
      notifications: false,
      presence: false,
      integrations: false,
      service_accounts: false,
      document_kv: false,
      search: "title",
      realtime: false,
      refresh: "polling",
    },
  });
});
