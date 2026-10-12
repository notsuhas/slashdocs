import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { loadInstance, validateLoginConfiguration } from "./instance";
const { instance, directory, path } = await loadInstance(process.argv[2]);
validateLoginConfiguration(instance);
const env = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: instance.accountId,
  ...(instance.apiToken ? { CLOUDFLARE_API_TOKEN: instance.apiToken } : {}),
};
function run(args: string[]) {
  const result = spawnSync("bun", args, { env, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error("Deployment command failed; no subsequent step was run.");
}
const app = resolve(directory, "wrangler.app.json"),
  render = resolve(directory, "wrangler.render.json");
run(["workers/scripts/provision.ts", path]);
run(["workers/scripts/configure.ts", path]);
run(["run", "build:cloudflare"]);
run([
  "x",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  instance.databaseName,
  "--remote",
  "--config",
  app,
]);
run(["x", "wrangler", "deploy", "--config", render]);
// Upload code, complete configuration and every credential in one version.
// Empty optional secrets replace old values; omitted secrets would be preserved.
run([
  "x",
  "wrangler",
  "deploy",
  "--config",
  app,
  "--secrets-file",
  resolve(directory, "app-secrets.json"),
]);
const response = await fetch(`${instance.appOrigin}/readyz`);
if (
  !response.ok ||
  !z.object({ login_configured: z.boolean() }).parse(await response.json())
    .login_configured
)
  throw new Error("Deployment readiness check failed.");
run(["workers/scripts/backfill-source.ts", path]);
console.info(
  "Cloudflare deployment completed. Verify login and the publish/review workflow in the browser.",
);
