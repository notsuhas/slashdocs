import { afterEach, describe, expect, it } from "vitest";
import { createTestEnv, seedUser } from "./runtime";
import { createDocument } from "../app/src/services/documents";
import { createVersion } from "../app/src/services/versions";
import { requireDocument } from "../app/src/services/permissions";
import type { Actor } from "../app/src/env";
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((fn) => fn()));
});
async function fixture() {
  const runtime = await createTestEnv();
  disposers.push(runtime.dispose);
  const actor: Actor = {
    principal: await seedUser(runtime.env),
    credentialKind: "session",
  };
  return { ...runtime, actor };
}
describe("document publication and permissions", () => {
  it("publishes one winner for simultaneous pushes against the same base", async () => {
    const { env, actor } = await fixture();
    const doc = await createDocument(
      env,
      actor,
      "Race",
      new TextEncoder().encode("<h1>First</h1>"),
      "private",
    );
    const results = await Promise.allSettled([
      createVersion(
        env,
        actor,
        doc.id,
        doc.current_version_id,
        "a",
        new TextEncoder().encode("a"),
      ),
      createVersion(
        env,
        actor,
        doc.id,
        doc.current_version_id,
        "b",
        new TextEncoder().encode("b"),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected");
    expect(loser?.status === "rejected" && loser.reason.code).toBe("version_conflict");
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM versions WHERE document_id=?")
          .bind(doc.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });
  it("keeps private documents private and combines direct and anyone roles", async () => {
    const { env, actor } = await fixture();
    const reader: Actor = {
      principal: await seedUser(env, "usr_reader", "second@example.com"),
      credentialKind: "session",
    };
    const doc = await createDocument(
      env,
      actor,
      "Private",
      new TextEncoder().encode("private"),
      "private",
    );
    await expect(requireDocument(env, reader, doc.id, "viewer")).rejects.toMatchObject({
      status: 403,
    });
    await env.DB.prepare(
      "INSERT INTO document_grants VALUES ('g',?,'anyone','','viewer',?)",
    )
      .bind(doc.id, actor.principal.id)
      .run();
    expect((await requireDocument(env, reader, doc.id, "viewer")).role).toBe("viewer");
    await expect(
      requireDocument(env, reader, doc.id, "commenter"),
    ).rejects.toMatchObject({ status: 403 });
    await env.DB.prepare(
      "INSERT INTO document_grants VALUES ('g2',?,'user',?,'editor',?)",
    )
      .bind(doc.id, reader.principal.id, actor.principal.id)
      .run();
    expect((await requireDocument(env, reader, doc.id, "editor")).role).toBe("editor");
    await expect(requireDocument(env, reader, doc.id, "owner")).rejects.toMatchObject({
      status: 403,
    });
  });
});

import { Hono } from "hono";
import type { AppEnv } from "../app/src/env";
import { ApiError } from "../shared/errors";
import { documentRoutes } from "../app/src/routes/documents";
import { versionRoutes } from "../app/src/routes/versions";
import { grantRoutes } from "../app/src/routes/grants";
import { verifyRenderCapability } from "../shared/render-capability";
function app(actor: Actor) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", documentRoutes);
  app.route("/", versionRoutes);
  app.route("/", grantRoutes);
  app.onError((error, c) =>
    error instanceof ApiError
      ? c.json(
          {
            error: { code: error.code, message: error.message, details: error.details },
          },
          error.status as 400,
        )
      : c.json({ error: { code: "internal_error" } }, 500),
  );
  return app;
}
function upload(title: string, content: string, permission = "private") {
  const form = new FormData();
  form.set("title", title);
  form.set("file", new Blob([content], { type: "text/html" }), "untrusted.html");
  form.set("default_permission", permission);
  return form;
}
it("serves source only as attachment and scopes signed render URLs to the version", async () => {
  const { env, actor } = await fixture();
  const doc = await createDocument(
    env,
    actor,
    "HTML",
    new TextEncoder().encode("<script>evil()</script>"),
    "private",
  );
  const base = `/v1/documents/${doc.id}/versions/${doc.current_version_id}`;
  const source = await app(actor).request(base + "/html", {}, env);
  expect(source.status).toBe(200);
  expect(source.headers.get("Content-Security-Policy")).toBe(
    "sandbox; default-src 'none'",
  );
  expect(source.headers.get("Content-Disposition")).toContain("attachment;");
  const rendered = await app(actor).request(
    base + "/render-token",
    { method: "POST" },
    env,
  );
  const body = (await rendered.json()) as { token: string; url: string };
  expect(new URL(body.url).origin).toBe(env.RENDER_ORIGIN);
  expect(
    (await verifyRenderCapability(env.RENDER_PUBLIC_KEY, body.token, "render"))
      .version_id,
  ).toBe(doc.current_version_id);
  const other = await createDocument(
    env,
    actor,
    "Other",
    new TextEncoder().encode("other"),
    "private",
  );
  expect(
    (
      await app(actor).request(
        `/v1/documents/${other.id}/versions/${doc.current_version_id}/html`,
        {},
        env,
      )
    ).status,
  ).toBe(404);
});
it("keeps listing and title search permission scoped and refuses unsupported syntax", async () => {
  const { env, actor } = await fixture();
  await createDocument(
    env,
    actor,
    "Secret Match",
    new TextEncoder().encode("secret"),
    "private",
  );
  const reader: Actor = {
    principal: await seedUser(env, "usr_other", "other@example.com"),
    credentialKind: "cli",
  };
  expect(
    await (await app(reader).request("/v1/documents?q=Match", {}, env)).json(),
  ).toEqual({ items: [] });
  expect(
    (await app(reader).request("/v1/documents?q=from:owner", {}, env)).status,
  ).toBe(400);
});
it("lets only owners manage direct grants and preserves access response", async () => {
  const { env, actor } = await fixture();
  const doc = await createDocument(
    env,
    actor,
    "Sharing",
    new TextEncoder().encode("doc"),
    "private",
  );
  const reader: Actor = {
    principal: await seedUser(env, "usr_shared", "shared@example.com"),
    credentialKind: "session",
  };
  const url = `/v1/documents/${doc.id}`;
  const created = await app(actor).request(
    url + "/grants",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principal: { type: "user", id: reader.principal.id },
        role: "commenter",
      }),
    },
    env,
  );
  expect(created.status).toBe(201);
  const access = (await (
    await app(reader).request(url + "/access", {}, env)
  ).json()) as { current_role: string; items: unknown[] };
  expect(access.current_role).toBe("commenter");
  expect(access.items).toHaveLength(2);
  expect(
    (
      await app(reader).request(
        url + "/grants",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ principal: { type: "anyone" }, role: "viewer" }),
        },
        env,
      )
    ).status,
  ).toBe(403);
  await expect(requireDocument(env, reader, doc.id, "editor")).rejects.toMatchObject({
    status: 403,
  });
});
it("enforces configurable source limit before publishing", async () => {
  const { env, actor } = await fixture();
  env.MAX_HTML_BYTES = "3";
  const response = await app(actor).request(
    "/v1/documents",
    { method: "POST", body: upload("Large", "1234") },
    env,
  );
  expect(response.status).toBe(413);
  expect(
    (await env.DB.prepare("SELECT count(*) AS n FROM documents").first<{ n: number }>())
      ?.n,
  ).toBe(0);
});
it("compensates an R2 upload failure without publishing a document", async () => {
  const { env, actor } = await fixture();
  const broken = {
    ...env,
    DOCUMENTS: new Proxy(env.DOCUMENTS, {
      get(target, key) {
        if (key === "put")
          return async () => {
            throw new Error("R2 unavailable");
          };
        const member = Reflect.get(target, key);
        return typeof member === "function" ? member.bind(target) : member;
      },
    }),
  };
  await expect(
    createDocument(
      broken,
      actor,
      "Failure",
      new TextEncoder().encode("file"),
      "private",
    ),
  ).rejects.toMatchObject({ status: 502, code: "blob_storage_failed" });
  expect(
    (await env.DB.prepare("SELECT count(*) AS n FROM documents").first<{ n: number }>())
      ?.n,
  ).toBe(0);
  expect(
    (
      await env.DB.prepare("SELECT count(*) AS n FROM orphan_objects").first<{
        n: number;
      }>()
    )?.n,
  ).toBe(0);
});
it("rechecks editor access inside the publication transaction after upload", async () => {
  const { env, actor } = await fixture();
  const doc = await createDocument(
    env,
    actor,
    "Revoke",
    new TextEncoder().encode("v1"),
    "private",
  );
  const editor: Actor = {
    principal: await seedUser(env, "usr_editor", "editor@example.com"),
    credentialKind: "cli",
  };
  await env.DB.prepare(
    "INSERT INTO document_grants VALUES ('editorgrant',?,'user',?,'editor',?)",
  )
    .bind(doc.id, editor.principal.id, actor.principal.id)
    .run();
  const paused = {
    ...env,
    DOCUMENTS: new Proxy(env.DOCUMENTS, {
      get(target, key) {
        if (key === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            await env.DB.prepare(
              "DELETE FROM document_grants WHERE id='editorgrant'",
            ).run();
            return target.put(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  await expect(
    createVersion(
      paused,
      editor,
      doc.id,
      doc.current_version_id,
      "revoked",
      new TextEncoder().encode("v2"),
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (
      await env.DB.prepare("SELECT count(*) AS n FROM versions WHERE document_id=?")
        .bind(doc.id)
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  expect(
    (
      await env.DB.prepare("SELECT count(*) AS n FROM orphan_objects").first<{
        n: number;
      }>()
    )?.n,
  ).toBe(0);
});
it("records failed R2 compensation durably when database publication fails", async () => {
  const { env, actor } = await fixture();
  const broken = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async () => {
            throw new Error("D1 unavailable");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    DOCUMENTS: new Proxy(env.DOCUMENTS, {
      get(target, key) {
        if (key === "delete")
          return async () => {
            throw new Error("R2 unavailable");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  await expect(
    createDocument(
      broken,
      actor,
      "Failure",
      new TextEncoder().encode("file"),
      "private",
    ),
  ).rejects.toThrow("D1 unavailable");
  expect(
    (await env.DB.prepare("SELECT count(*) AS n FROM documents").first<{ n: number }>())
      ?.n,
  ).toBe(0);
  const orphans = await env.DB.prepare("SELECT object_key FROM orphan_objects").all<{
    object_key: string;
  }>();
  expect(orphans.results).toHaveLength(1);
  expect(await env.DOCUMENTS.get(orphans.results[0].object_key)).not.toBeNull();
});
it("preserves create/push/conflict/grant REST payloads used by the CLI", async () => {
  const { env, actor } = await fixture();
  const client = app(actor);
  const initial = await client.request(
    "/v1/documents",
    { method: "POST", body: upload("CLI", "first", "viewer") },
    env,
  );
  expect(initial.status).toBe(201);
  const doc = (await initial.json()) as {
    id: string;
    current_version_id: string;
    default_grant: { grant_id: string; role: string; principal: { type: string } };
  };
  expect(doc.default_grant.role).toBe("viewer");
  expect(doc.default_grant.principal).toEqual({ type: "anyone" });
  const form = upload("", "second");
  form.set("base_version_id", doc.current_version_id);
  const pushed = await client.request(
    `/v1/documents/${doc.id}/versions`,
    { method: "POST", body: form },
    env,
  );
  expect(pushed.status).toBe(201);
  const version = (await pushed.json()) as {
    id: string;
    number: number;
    sha256: string;
  };
  expect(version.number).toBe(2);
  expect(version.sha256).toHaveLength(64);
  const stale = upload("", "third");
  stale.set("base_version_id", doc.current_version_id);
  const conflict = await client.request(
    `/v1/documents/${doc.id}/versions`,
    { method: "POST", body: stale },
    env,
  );
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({
    error: { code: "version_conflict", details: { current_version_id: version.id } },
  });
  const missingBase = await client.request(
    `/v1/documents/${doc.id}/versions`,
    { method: "POST", body: upload("", "third") },
    env,
  );
  expect(missingBase.status).toBe(400);
  const grants = `/v1/documents/${doc.id}/grants/${doc.default_grant.grant_id}`;
  const patched = await client.request(
    grants,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "commenter" }),
    },
    env,
  );
  expect(patched.status).toBe(200);
  expect(await patched.json()).toMatchObject({
    resource_type: "document",
    resource_id: doc.id,
    principal: { type: "anyone" },
    role: "commenter",
  });
  expect((await client.request(grants, { method: "DELETE" }, env)).status).toBe(204);
  expect(
    (
      await env.DB.prepare("SELECT access_revision FROM documents WHERE id=?")
        .bind(doc.id)
        .first<{ access_revision: number }>()
    )?.access_revision,
  ).toBe(2);
});
