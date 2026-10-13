import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { loadInstance, writePrivateFile, cloudflare } from "./instance";
const { instance, directory } = await loadInstance(process.argv[2]);
if (!instance.databaseId)
  throw new Error("Provision the database before backfilling source metadata.");
const name = `${instance.appWorkerName}-source-backfill`;
const config = resolve(directory, "wrangler.source-backfill.json");
const secrets = resolve(directory, "source-backfill-secrets.json");
const token = crypto.randomUUID() + crypto.randomUUID();
const env = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: instance.accountId,
  ...(instance.apiToken ? { CLOUDFLARE_API_TOKEN: instance.apiToken } : {}),
};
function run(args: string[]) {
  const result = spawnSync("bun", args, { env, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Source metadata backfill setup failed.");
}
await writePrivateFile(
  config,
  JSON.stringify({
    name,
    account_id: instance.accountId,
    main: resolve("workers/scripts/source-backfill-worker.ts"),
    compatibility_date: "2026-07-30",
    workers_dev: true,
    preview_urls: false,
    durable_objects: {
      bindings: [
        {
          name: "DOCUMENT_SEARCH",
          class_name: "DocumentSearch",
          script_name: instance.appWorkerName,
        },
      ],
    },
  }),
);
await writePrivateFile(secrets, JSON.stringify({ SOURCE_BACKFILL_TOKEN: token }));
let deployed = false;
try {
  run(["x", "wrangler", "deploy", "--config", config]);
  deployed = true;
  run(["x", "wrangler", "secret", "bulk", secrets, "--config", config]);
  const subdomain = z
    .object({ subdomain: z.string() })
    .parse(
      await cloudflare(instance, `/accounts/${instance.accountId}/workers/subdomain`),
    );
  const base = `https://${name}.${subdomain.subdomain}.workers.dev`;
  const resultSchema = z.object({
    indexed: z.number().int(),
    failed: z.array(z.string()),
    nextCursor: z.string().optional(),
  });
  let after = "",
    indexed = 0;
  const failed: string[] = [];
  for (;;) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      response = await fetch(`${base}/?after=${encodeURIComponent(after)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (
        response.ok &&
        response.headers.get("Content-Type")?.includes("application/json")
      )
        break;
      if (attempt === 7) throw new Error("Source metadata backfill request failed.");
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!response) throw new Error("Source metadata backfill returned no response.");
    const result = resultSchema.parse(await response.json());
    indexed += result.indexed;
    failed.push(...result.failed);
    if (!result.nextCursor) break;
    if (result.nextCursor <= after)
      throw new Error("Source metadata backfill cursor did not advance.");
    after = result.nextCursor;
  }
  console.info(`Indexed ${indexed} current document versions.`);
  if (failed.length)
    throw new Error(
      `Source metadata backfill failed for ${failed.length} versions; retry the command.`,
    );
} finally {
  try {
    if (deployed)
      await cloudflare(
        instance,
        `/accounts/${instance.accountId}/workers/scripts/${name}?force=true`,
        "DELETE",
      );
  } finally {
    await Promise.all([rm(config, { force: true }), rm(secrets, { force: true })]);
  }
}
