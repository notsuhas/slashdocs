import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadInstance } from "./instance";
const { instance, directory, path } = await loadInstance(process.argv[2]);
if (!instance.googleClientId || !instance.googleClientSecret)
  throw new Error(
    "Set Google OAuth client ID and secret in private instance configuration before deployment.",
  );
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
run(["x", "wrangler", "deploy", "--config", app]);
run([
  "x",
  "wrangler",
  "secret",
  "bulk",
  resolve(directory, "app-secrets.json"),
  "--config",
  app,
]);
const response = await fetch(`${instance.appOrigin}/readyz`);
if (!response.ok) throw new Error("Deployment readiness check failed.");
console.info(
  "Cloudflare deployment completed. Verify Google login and the publish/review workflow in the browser.",
);
