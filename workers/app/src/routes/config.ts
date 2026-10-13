import { Hono } from "hono";
import type { AppEnv } from "../env";
import { googleGroupsEnabled } from "../services/groups";
import { labelsEnabled } from "../services/labels";
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
    c.json({
      name: "slashdocs",
      api_version: "v1",
      auth: { modes: ["web", "cli", "mcp"] },
    }),
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
    provider_name:
      c.env.SLASHDOCS_OIDC_PROVIDER_NAME ||
      (c.env.SLASHDOCS_OIDC_ISSUER_URL ? "SSO" : "Google"),
    default_doc_permission: c.env.DEFAULT_DOC_PERMISSION ?? "private",
    google_groups_enabled: googleGroupsEnabled(c.env),
    labels_enabled: labelsEnabled(c.env),
    capabilities: {
      mcp: true,
      api_reference: true,
      owner_managed_sharing: false,
      structured_mentions: true,
      folders: true,
      groups: googleGroupsEnabled(c.env),
      labels: labelsEnabled(c.env),
      notifications: true,
      presence: !!c.env.DOCUMENT_REALTIME,
      integrations: true,
      service_accounts: true,
      document_kv: !!c.env.DOCUMENT_REALTIME,
      search: "full_text",
      realtime: !!c.env.DOCUMENT_REALTIME,
      refresh: c.env.DOCUMENT_REALTIME ? "sse" : "polling",
    },
  });
});
