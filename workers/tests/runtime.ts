import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import type { Env } from "../app/src/env";
import { exportJWK, generateKeyPair } from "jose";
export async function createTestEnv(overrides: Record<string, string> = {}) {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("test")}}',
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
    r2Buckets: ["DOCUMENTS"],
    bindings: {
      APP_ORIGIN: "https://app.example.com",
      RENDER_ORIGIN: "https://render.example.com",
      SESSION_SECRET: "test-only-session-secret-with-at-least-32-chars",
      RENDER_PRIVATE_KEY: JSON.stringify(await exportJWK(privateKey)),
      RENDER_PUBLIC_KEY: JSON.stringify(await exportJWK(publicKey)),
      ALLOWED_DOMAINS: "example.com",
      ...overrides,
    },
  });
  const env = await mf.getBindings<Env>();
  const migration = await readFile(
    new URL("../app/migrations/0001_core.sql", import.meta.url),
    "utf8",
  );
  // The D1 exec API accepts one statement per line; execute the schema as explicit statements.
  for (const statement of migration
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await env.DB.prepare(statement).run();
  return { env, mf, dispose: () => mf.dispose() };
}
export async function seedUser(
  env: Env,
  id = "usr_test",
  email = "reader@example.com",
) {
  await env.DB.prepare(
    "INSERT INTO users (id,provider,provider_subject,email,name,picture_url,created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(id, "google", id, email, "Test Reader", "", new Date().toISOString())
    .run();
  return { type: "user" as const, id, email, name: "Test Reader", picture_url: "" };
}
