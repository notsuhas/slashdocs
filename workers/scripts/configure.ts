import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadInstance } from "./instance";
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
  triggers: { crons: ["0 * * * *"] },
  routes: [{ pattern: new URL(instance.appOrigin).hostname, custom_domain: true }],
  assets: {
    directory: resolve(root, "workers/dist/app"),
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_worker_first: [
      "/v1/*",
      "/.well-known/*",
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
  vars: {
    APP_ORIGIN: instance.appOrigin,
    RENDER_ORIGIN: instance.renderOrigin,
    ALLOWED_EMAILS: instance.allowedEmails.join(","),
    ALLOWED_DOMAINS: instance.allowedDomains.join(","),
    RENDER_PUBLIC_KEY: instance.renderPublicKey,
    DEPLOYMENT: "org",
    MAX_HTML_BYTES: "1048576",
  },
};
const render = {
  ...shared,
  name: instance.renderWorkerName,
  main: resolve(root, "workers/render/src/index.ts"),
  routes: [{ pattern: new URL(instance.renderOrigin).hostname, custom_domain: true }],
  r2_buckets: [{ binding: "DOCUMENTS", bucket_name: instance.bucketName }],
  vars: { APP_ORIGIN: instance.appOrigin, RENDER_PUBLIC_KEY: instance.renderPublicKey },
};
await writeFile(
  resolve(directory, "wrangler.app.json"),
  JSON.stringify(app, null, 2) + "\n",
  { mode: 0o600 },
);
await writeFile(
  resolve(directory, "wrangler.render.json"),
  JSON.stringify(render, null, 2) + "\n",
  { mode: 0o600 },
);
const secrets = {
  SESSION_SECRET: instance.sessionSecret,
  RENDER_PRIVATE_KEY: instance.renderPrivateKey,
  ...(instance.googleClientId ? { GOOGLE_CLIENT_ID: instance.googleClientId } : {}),
  ...(instance.googleClientSecret
    ? { GOOGLE_CLIENT_SECRET: instance.googleClientSecret }
    : {}),
};
await writeFile(
  resolve(directory, "app-secrets.json"),
  JSON.stringify(secrets) + "\n",
  { mode: 0o600 },
);
console.info("Worker configuration and secret files generated outside the repository.");
