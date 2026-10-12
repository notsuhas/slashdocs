import { loadMigrationStatements } from "../scripts/read-migrations";
import { Miniflare } from "miniflare";
import type { Env } from "../app/src/env";
import { exportJWK, generateKeyPair } from "jose";
import { build } from "esbuild";
let realtimeBundle: Promise<string> | undefined;
export async function createTestEnv(overrides: Record<string, string> = {}) {
  realtimeBundle ||= build({
    stdin: {
      contents: `export { DocumentRealtime } from './workers/app/src/realtime/document-realtime.ts'; export default {fetch(){return new Response("test")}};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
  }).then((result) => result.outputFiles[0].text);
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const mf = new Miniflare({
    modules: true,
    script: await realtimeBundle,
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
    r2Buckets: ["DOCUMENTS"],
    durableObjects: {
      DOCUMENT_REALTIME: { className: "DocumentRealtime", useSQLite: true },
    },
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
  for (const statement of await loadMigrationStatements())
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
