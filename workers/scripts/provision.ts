import { exportJWK, generateKeyPair } from "jose";
import { z } from "zod";
import { cloudflare, loadInstance, saveInstance } from "./instance";
const { instance, path } = await loadInstance(process.argv[2]);
const databases = z
  .array(z.object({ uuid: z.string(), name: z.string() }))
  .parse(
    await cloudflare(
      instance,
      `/accounts/${instance.accountId}/d1/database?per_page=100`,
    ),
  );
let database = databases.find((d) => d.name === instance.databaseName);
if (!database)
  database = z
    .object({ uuid: z.string(), name: z.string() })
    .parse(
      await cloudflare(
        instance,
        `/accounts/${instance.accountId}/d1/database`,
        "POST",
        { name: instance.databaseName },
      ),
    );
if (instance.databaseId && instance.databaseId !== database.uuid)
  throw new Error(
    "Configured database ID does not match the named database; refusing to switch storage.",
  );
instance.databaseId = database.uuid;
const buckets = z
  .object({ buckets: z.array(z.object({ name: z.string() })) })
  .parse(await cloudflare(instance, `/accounts/${instance.accountId}/r2/buckets`));
if (!buckets.buckets.some((b) => b.name === instance.bucketName))
  await cloudflare(instance, `/accounts/${instance.accountId}/r2/buckets`, "POST", {
    name: instance.bucketName,
    storageClass: "Standard",
  });
if (!instance.sessionSecret)
  instance.sessionSecret = crypto.randomUUID() + crypto.randomUUID();
if (!instance.renderPrivateKey || !instance.renderPublicKey) {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  instance.renderPrivateKey = JSON.stringify(await exportJWK(privateKey));
  instance.renderPublicKey = JSON.stringify(await exportJWK(publicKey));
}
await saveInstance(path, instance);
console.info(
  "D1 and private R2 resources are ready. Instance IDs and generated secrets remain outside the repository.",
);
