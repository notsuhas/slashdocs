import { loadMigrationStatements } from "../scripts/read-migrations";
import { build } from "esbuild";
import { exportJWK, generateKeyPair } from "jose";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { hashToken } from "../app/src/auth/tokens";

describe("actual workerd app and render integration", () => {
  it("publishes authenticated multipart HTML and verifies isolated render capabilities across Workers", async () => {
    const scripts = await Promise.all(
      ["app", "render"].map(async (worker) => {
        const result = await build({
          entryPoints: [`workers/${worker}/src/index.ts`],
          bundle: true,
          format: "esm",
          platform: "neutral",
          mainFields: ["module", "main"],
          target: "es2022",
          write: false,
        });
        return result.outputFiles![0].text;
      }),
    );
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
      extractable: true,
    });
    const appOrigin = "https://app.example.com";
    const renderOrigin = "https://render.example.com";
    const credential = "slashdocs_cli_workerdfixturetoken";
    const mf = new Miniflare({
      workers: [
        {
          name: "app",
          modules: true,
          script: scripts[0],
          compatibilityDate: "2026-07-30",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { DB: "workerd-db" },
          r2Buckets: { DOCUMENTS: "workerd-documents" },
          durableObjects: {
            DOCUMENT_REALTIME: { className: "DocumentRealtime", useSQLite: true },
          },
          serviceBindings: { ASSETS: "assets" },
          bindings: {
            APP_ORIGIN: appOrigin,
            RENDER_ORIGIN: renderOrigin,
            ALLOWED_DOMAINS: "example.com",
            RENDER_PRIVATE_KEY: JSON.stringify(await exportJWK(privateKey)),
          },
        },
        {
          name: "render",
          modules: true,
          script: scripts[1],
          compatibilityDate: "2026-07-30",
          r2Buckets: { DOCUMENTS: "workerd-documents" },
          bindings: {
            APP_ORIGIN: appOrigin,
            RENDER_PUBLIC_KEY: JSON.stringify(await exportJWK(publicKey)),
          },
        },
        {
          name: "assets",
          modules: true,
          compatibilityDate: "2026-07-30",
          script: `export default {fetch() {return new Response("<!doctype html><p>Login fixture</p>", {headers: {"Content-Type": "text/html"}})}}`,
        },
      ],
    });
    try {
      const db = await mf.getD1Database("DB", "app");
      for (const statement of await loadMigrationStatements())
        await db.prepare(statement).run();
      await db
        .prepare(
          "INSERT INTO users(id,provider,provider_subject,email,name,picture_url,created_at) VALUES (?,?,?,?,?,?,?)",
        )
        .bind(
          "usr_workerd",
          "google",
          "workerd",
          "reader@example.com",
          "Reader",
          "",
          new Date().toISOString(),
        )
        .run();
      await db
        .prepare(
          "INSERT INTO cli_credentials (id,token_hash,user_id,name,created_at) VALUES (?,?,?,?,?)",
        )
        .bind(
          "cli_workerd",
          await hashToken(credential),
          "usr_workerd",
          "Workerd fixture",
          new Date().toISOString(),
        )
        .run();
      const app = await mf.getWorker("app");
      const render = await mf.getWorker("render");
      const auth = { Authorization: `Bearer ${credential}` };
      const config = await app.fetch(`${appOrigin}/v1/config`);
      expect(config.status).toBe(200);
      expect(await config.json()).toMatchObject({ capabilities: { folders: true } });
      const root = await app.fetch(appOrigin);
      expect(root.status).toBe(200);
      expect(root.headers.get("Content-Security-Policy")).toContain(
        "script-src 'self'",
      );
      expect(await root.text()).toContain("Login fixture");
      expect((await app.fetch(`${appOrigin}/v1/documents`)).status).toBe(401);
      expect((await app.fetch(`${appOrigin}/v1/me`, { headers: auth })).status).toBe(
        200,
      );

      const source =
        "<!doctype html><body><script>window.workerdUpload=true</script><h1>Workerd source</h1></body>";
      const form = new FormData();
      form.set("title", "Workerd document");
      form.set("default_permission", "private");
      form.set("file", new Blob([source], { type: "text/html" }), "fixture.html");
      // Serialize with the host Request implementation before crossing Miniflare's
      // Fetcher bridge, which uses a separate FormData implementation.
      const upload = new Request(`${appOrigin}/v1/documents`, {
        method: "POST",
        headers: auth,
        body: form,
      });
      const published = await app.fetch(`${appOrigin}/v1/documents`, {
        method: "POST",
        headers: Object.fromEntries(upload.headers),
        body: await upload.arrayBuffer(),
      });
      expect(published.status, await published.clone().text()).toBe(201);
      const document = (await published.json()) as {
        id: string;
        current_version_id: string;
      };
      const versionPath = `/v1/documents/${document.id}/versions/${document.current_version_id}`;
      expect((await app.fetch(`${appOrigin}${versionPath}/html`)).status).toBe(401);
      const downloaded = await app.fetch(`${appOrigin}${versionPath}/html`, {
        headers: auth,
      });
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("Content-Security-Policy")).toBe(
        "sandbox; default-src 'none'",
      );
      expect(downloaded.headers.get("Content-Disposition")).toContain("attachment;");
      expect(await downloaded.text()).toBe(source);

      const issued = await app.fetch(`${appOrigin}${versionPath}/render-token`, {
        method: "POST",
        headers: auth,
      });
      expect(issued.status).toBe(200);
      const capability = (await issued.json()) as { url: string };
      const rendered = await render.fetch(capability.url);
      expect(rendered.status).toBe(200);
      expect(rendered.headers.get("Content-Security-Policy")).toContain(
        `frame-ancestors ${appOrigin}`,
      );
      const wrapper = await rendered.text();
      expect(wrapper).toContain(
        "&lt;script&gt;window.workerdUpload=true&lt;/script&gt;",
      );
      expect(wrapper).not.toContain("<script>window.workerdUpload=true</script>");
      expect(wrapper).not.toContain(credential);
      const wrongScope = new URL(capability.url);
      wrongScope.pathname = `/v/doc_bbbbbbbb/${document.current_version_id}`;
      expect((await render.fetch(wrongScope)).status).toBe(403);
      const wrongAudience = new URL(capability.url);
      wrongAudience.pathname = wrongAudience.pathname.replace("/v/", "/print/");
      expect((await render.fetch(wrongAudience)).status).toBe(403);
      expect(
        (
          await render.fetch(
            `${renderOrigin}/v/${document.id}/${document.current_version_id}`,
          )
        ).status,
      ).toBe(403);
    } finally {
      await mf.dispose();
    }
  });
});
