import { resolve } from "node:path";
import { loadInstance, writePrivateFile } from "./instance";
const { instance, directory } = await loadInstance(process.argv[2]);
if (
  !instance.databaseId ||
  !instance.renderPrivateKey ||
  !instance.renderPublicKey ||
  !instance.sessionSecret
)
  throw new Error("Run provisioning before configuration.");
const root = process.cwd();
const shared = {
  account_id: instance.accountId,
  compatibility_date: "2026-07-30",
  workers_dev: false,
  preview_urls: false,
};
const app = {
  ...shared,
  name: instance.appWorkerName,
  main: resolve(root, "workers/app/src/index.ts"),
  compatibility_flags: ["nodejs_compat"],
  triggers: { crons: instance.cleanupCron ? ["0 * * * *"] : [] },
  routes: [{ pattern: new URL(instance.appOrigin).hostname, custom_domain: true }],
  assets: {
    directory: resolve(root, "workers/dist/app"),
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_worker_first: [
      "/v1/*",
      "/.well-known/*",
      "/mcp",
      "/mcp/*",
      "/oauth/*",
      "/api-docs",
      "/api-docs/*",
      "/openapi.json",
      "/livez",
      "/readyz",
      "/install.sh",
      "/cli/*",
      "/skills/*",
      "/",
      "/login",
      "/app/*",
    ],
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: instance.databaseName,
      database_id: instance.databaseId,
      migrations_dir: resolve(root, "workers/app/migrations"),
    },
  ],
  r2_buckets: [{ binding: "DOCUMENTS", bucket_name: instance.bucketName }],
  durable_objects: {
    bindings: [
      { name: "DOCUMENT_REALTIME", class_name: "DocumentRealtime" },
      { name: "DOCUMENT_SEARCH", class_name: "DocumentSearch" },
      { name: "NOTIFICATION_DELIVERY", class_name: "NotificationDelivery" },
    ],
  },
  migrations: [
    {
      tag: "v1",
      new_sqlite_classes: [
        "DocumentRealtime",
        "NotificationDelivery",
        "DocumentSearch",
      ],
    },
  ],
  vars: {
    APP_ORIGIN: instance.appOrigin,
    RENDER_ORIGIN: instance.renderOrigin,
    ALLOWED_EMAILS: instance.allowedEmails.join(","),
    ALLOWED_DOMAINS: instance.allowedDomains.join(","),
    RENDER_PUBLIC_KEY: instance.renderPublicKey,
    DEPLOYMENT: "org",
    MAX_HTML_BYTES: String(instance.maxHTMLBytes),
    LABELS_ENABLED: String(instance.labelsEnabled),
    ...(instance.oidcIssuer ? { SLASHDOCS_OIDC_ISSUER_URL: instance.oidcIssuer } : {}),
    ...(instance.oidcInternalIssuer
      ? { SLASHDOCS_OIDC_INTERNAL_ISSUER_URL: instance.oidcInternalIssuer }
      : {}),
    ...(instance.oidcProviderName
      ? { SLASHDOCS_OIDC_PROVIDER_NAME: instance.oidcProviderName }
      : {}),
    GOOGLE_GROUPS_ENABLED: String(instance.googleGroupsEnabled),
    ...(instance.googleGroupsCustomerId
      ? { GOOGLE_GROUPS_CUSTOMER_ID: instance.googleGroupsCustomerId }
      : {}),
  },
};
const render = {
  ...shared,
  workers_dev: new URL(instance.renderOrigin).hostname.endsWith(".workers.dev"),
  name: instance.renderWorkerName,
  main: resolve(root, "workers/render/src/index.ts"),
  routes: new URL(instance.renderOrigin).hostname.endsWith(".workers.dev")
    ? []
    : [{ pattern: new URL(instance.renderOrigin).hostname, custom_domain: true }],
  r2_buckets: [{ binding: "DOCUMENTS", bucket_name: instance.bucketName }],
  vars: { APP_ORIGIN: instance.appOrigin, RENDER_PUBLIC_KEY: instance.renderPublicKey },
};
await writePrivateFile(
  resolve(directory, "wrangler.app.json"),
  JSON.stringify(app, null, 2) + "\n",
);
await writePrivateFile(
  resolve(directory, "wrangler.render.json"),
  JSON.stringify(render, null, 2) + "\n",
);
const secrets = {
  GOOGLE_CLIENT_ID: instance.googleClientId ?? "",
  GOOGLE_CLIENT_SECRET: instance.googleClientSecret ?? "",
  SLASHDOCS_OIDC_CLIENT_ID: instance.oidcClientId ?? "",
  SLASHDOCS_OIDC_CLIENT_SECRET: instance.oidcClientSecret ?? "",
  GITHUB_CLIENT_ID: instance.githubClientId ?? "",
  GITHUB_CLIENT_SECRET: instance.githubClientSecret ?? "",
  GOOGLE_GROUPS_SERVICE_ACCOUNT_JSON: instance.googleGroupsServiceAccount ?? "",
  SLASHDOCS_SLACK_BOT_TOKEN: instance.slackBotToken ?? "",
  SESSION_SECRET: instance.sessionSecret,
  RENDER_PRIVATE_KEY: instance.renderPrivateKey,
};
await writePrivateFile(
  resolve(directory, "app-secrets.json"),
  JSON.stringify(secrets) + "\n",
);
console.info("Worker configuration and secret files generated outside the repository.");
