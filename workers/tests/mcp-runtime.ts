import { build } from "esbuild";
import { exportJWK, generateKeyPair } from "jose";
import { Miniflare, type WorkerOptions } from "miniflare";
type ServiceFetchHandler = Extract<
  NonNullable<WorkerOptions["serviceBindings"]>[string],
  (...args: never[]) => unknown
>;
import type { Env } from "../app/src/env";
import { loadMigrationStatements } from "../scripts/read-migrations";
let bundle: Promise<string> | undefined;
export async function createMCPRuntime(
  overrides: Record<string, string> = {},
  options: { assets?: ServiceFetchHandler; render?: boolean } = {},
) {
  bundle ||= build({
    entryPoints: ["workers/app/src/index.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
    write: false,
  }).then((result) => result.outputFiles[0].text);
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const renderScript = options.render
    ? (
        await build({
          entryPoints: ["workers/render/src/index.ts"],
          bundle: true,
          format: "esm",
          platform: "neutral",
          mainFields: ["module", "main"],
          target: "es2022",
          write: false,
        })
      ).outputFiles[0].text
    : undefined;
  const mf = new Miniflare({
    workers: [
      {
        name: "app",
        routes: ["app.example.com/*", "evil.example/*"],
        modules: true,
        script: await bundle,
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { DB: "mcp-db" },
        r2Buckets: { DOCUMENTS: "mcp-documents" },
        durableObjects: {
          DOCUMENT_REALTIME: { className: "DocumentRealtime", useSQLite: true },
          DOCUMENT_SEARCH: { className: "DocumentSearch", useSQLite: true },
        },
        serviceBindings: { ASSETS: options.assets ?? "assets" },
        bindings: {
          APP_ORIGIN: "https://app.example.com",
          RENDER_ORIGIN: "https://render.example.com",
          SESSION_SECRET: "test-only-mcp-secret-with-at-least-32-chars",
          ALLOWED_DOMAINS: "example.com",
          GOOGLE_CLIENT_ID: "mcp-fixture-client",
          GOOGLE_CLIENT_SECRET: "mcp-fixture-secret",
          RENDER_PRIVATE_KEY: JSON.stringify(await exportJWK(privateKey)),
          RENDER_PUBLIC_KEY: JSON.stringify(await exportJWK(publicKey)),
          ...overrides,
        },
      },
      {
        name: "assets",
        modules: true,
        script: 'export default {fetch(){return new Response("fixture")}}',
        compatibilityDate: "2026-07-30",
      },
      ...(renderScript
        ? [
            {
              name: "render",
              modules: true,
              script: renderScript,
              compatibilityDate: "2026-07-30",
              r2Buckets: { DOCUMENTS: "mcp-documents" },
              bindings: {
                APP_ORIGIN: overrides.APP_ORIGIN ?? "https://app.example.com",
                RENDER_PUBLIC_KEY: JSON.stringify(await exportJWK(publicKey)),
              },
            },
          ]
        : []),
    ],
  });
  const env = await mf.getBindings<Env>("app");
  for (const statement of await loadMigrationStatements())
    await env.DB.prepare(statement).run();
  const worker = await mf.getWorker("app");
  return {
    env,
    mf,
    dispose: () => mf.dispose(),
    fetch: async (url: string, init: RequestInit = {}) => {
      const request = new Request(url, init);
      return worker.fetch(url, {
        method: request.method,
        redirect: "manual",
        headers: Object.fromEntries(request.headers),
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : await request.arrayBuffer(),
      });
    },
  };
}
