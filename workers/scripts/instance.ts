import { readFile, realpath, open, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { z } from "zod";
export const instanceSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  zoneId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  apiToken: z.string().min(1).optional(),
  apiTokenId: z.string().optional(),
  appOrigin: z.string().url(),
  renderOrigin: z.string().url(),
  allowedEmails: z.array(z.string().email()).default([]),
  allowedDomains: z.array(z.string().regex(/^[a-z0-9.-]+$/)).default([]),
  appWorkerName: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("slashdocs"),
  renderWorkerName: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("slashdocs-render"),
  databaseName: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("slashdocs-db"),
  bucketName: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("slashdocs-files"),
  databaseId: z.string().optional(),
  cleanupCron: z.boolean().default(false),
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  oidcIssuer: z.string().url().optional(),
  oidcInternalIssuer: z.string().url().optional(),
  oidcProviderName: z.string().optional(),
  oidcClientId: z.string().optional(),
  oidcClientSecret: z.string().optional(),
  githubClientId: z.string().optional(),
  githubClientSecret: z.string().optional(),
  googleGroupsEnabled: z.boolean().default(false),
  googleGroupsCustomerId: z.string().optional(),
  googleGroupsServiceAccount: z.string().optional(),
  slackBotToken: z.string().optional(),
  labelsEnabled: z.boolean().default(false),
  maxHTMLBytes: z
    .number()
    .int()
    .min(1)
    .max(50 * 1024 * 1024)
    .default(50 * 1024 * 1024),
  sessionSecret: z.string().optional(),
  renderPrivateKey: z.string().optional(),
  renderPublicKey: z.string().optional(),
});
export type Instance = z.infer<typeof instanceSchema>;
export function validateLoginConfiguration(
  instance: Pick<
    Instance,
    | "googleClientId"
    | "googleClientSecret"
    | "oidcIssuer"
    | "oidcInternalIssuer"
    | "oidcClientId"
    | "oidcClientSecret"
  >,
) {
  const generic = !!(
    instance.oidcIssuer ||
    instance.oidcInternalIssuer ||
    instance.oidcClientId ||
    instance.oidcClientSecret
  );
  const google = !!(instance.googleClientId || instance.googleClientSecret);
  if (
    (generic && google) ||
    (generic
      ? !instance.oidcIssuer || !instance.oidcClientId || !instance.oidcClientSecret
      : !instance.googleClientId || !instance.googleClientSecret)
  )
    throw new Error(
      "Configure one complete Google or generic OIDC provider in private instance configuration.",
    );
}
export async function loadInstance(
  file = process.env.SLASHDOCS_INSTANCE_CONFIG ??
    resolve(homedir(), ".config/slashdocs-cloudflare/instance.json"),
) {
  const path = await realpath(file);
  const repository = await realpath(process.cwd());
  const rel = relative(repository, path);
  if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    throw new Error("Real instance configuration must be outside the repository.");
  const instance = instanceSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const app = new URL(instance.appOrigin),
    render = new URL(instance.renderOrigin);
  if (
    app.protocol !== "https:" ||
    render.protocol !== "https:" ||
    app.hostname === render.hostname ||
    app.pathname !== "/" ||
    render.pathname !== "/" ||
    app.search ||
    render.search ||
    app.hash ||
    render.hash ||
    app.username ||
    render.username ||
    app.password ||
    render.password
  )
    throw new Error("Use two separate HTTPS hostnames without paths or credentials.");
  if (!instance.allowedEmails.length && !instance.allowedDomains.length)
    throw new Error("Configure an exact email or domain allowlist before deploying.");
  instance.appOrigin = app.origin;
  instance.renderOrigin = render.origin;
  return { instance, path, directory: dirname(path) };
}
export async function writePrivateFile(path: string, contents: string) {
  const file = await open(path, "w", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(contents);
  } finally {
    await file.close();
  }
}
export async function saveInstance(path: string, instance: Instance) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writePrivateFile(path, JSON.stringify(instance, null, 2) + "\n");
}
export async function cloudflare(
  instance: Instance,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  if (!instance.apiToken)
    throw new Error(
      "Provisioning requires a scoped API token in private instance configuration.",
    );
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${instance.apiToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = z
    .object({
      success: z.boolean(),
      result: z.unknown().optional(),
      errors: z
        .array(z.object({ code: z.number().optional(), message: z.string() }))
        .optional(),
    })
    .parse(await response.json());
  if (!response.ok || !parsed.success)
    throw new Error(
      `Cloudflare API ${method} ${path.split("?")[0]} failed (${response.status}); check the scoped token permissions and account resources.`,
    );
  return parsed.result;
}
