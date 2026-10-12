import { readFile, realpath, chmod } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { z } from "zod";
import { loadInstance, saveInstance } from "./instance";
const input = process.argv[2];
if (!input)
  throw new Error(
    "Pass the absolute path to downloaded Google OAuth client JSON outside the repository.",
  );
const file = await realpath(input),
  root = await realpath(process.cwd()),
  rel = relative(root, file);
if (!rel.startsWith("..") && !isAbsolute(rel))
  throw new Error("Google credentials must remain outside the repository.");
const client = z
  .object({
    web: z.object({
      client_id: z.string().min(1),
      client_secret: z.string().min(1),
      redirect_uris: z.array(z.string().url()),
    }),
  })
  .parse(JSON.parse(await readFile(file, "utf8"))).web;
const { instance, path } = await loadInstance(process.argv[3]);
const callback = `${new URL(instance.appOrigin).origin}/v1/auth/google/callback`;
if (!client.redirect_uris.includes(callback))
  throw new Error(
    "Google client does not contain this instance callback URI. Update the Google OAuth client, then download its JSON again.",
  );
instance.googleClientId = client.client_id;
instance.googleClientSecret = client.client_secret;
await chmod(file, 0o600);
await saveInstance(path, instance);
console.info(
  "Google OAuth credentials imported into private instance configuration. No credential values were printed or placed in Git.",
);
