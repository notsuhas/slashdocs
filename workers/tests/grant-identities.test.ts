import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app/src/env";
import { ApiError } from "../shared/errors";
import { splitSQLStatements } from "../shared/migrations";
import { grantRoutes } from "../app/src/routes/grants";
import { folderRoutes } from "../app/src/routes/folders";
import { createDocument } from "../app/src/services/documents";
import { createTestEnv, seedUser } from "./runtime";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});
async function fixture() {
  const runtime = await createTestEnv();
  disposers.push(runtime.dispose);
  const owner = await seedUser(runtime.env, "owner", "owner@example.com");
  await seedUser(runtime.env, "reader", "reader@example.com");
  await runtime.env.DB.batch([
    runtime.env.DB.prepare(
      "INSERT INTO documents(id,title,owner_user_id,updated_at) VALUES ('shared','Document','owner','2026-01-01')",
    ),
    runtime.env.DB.prepare(
      "INSERT INTO folders(id,title,title_key,owner_type,owner_id,created_at,updated_at) VALUES ('shared','Folder','folder','user','owner','2026-01-01','2026-01-01')",
    ),
  ]);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { principal: owner, credentialKind: "session" });
    await next();
  });
  app.route("/", grantRoutes);
  app.route("/", folderRoutes);
  app.onError((error) => {
    if (error instanceof ApiError)
      return Response.json({ error: error.message }, { status: error.status });
    throw error;
  });
  const request = (url: string, method: string, body?: unknown) =>
    app.request(
      url,
      {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      runtime.env,
    );
  const add = async (url: string, principal = { type: "user", id: "reader" }) => {
    const response = await request(url, "POST", { principal, role: "viewer" });
    expect(response.status).toBe(201);
    return z.object({ id: z.string() }).parse(await response.json()).id;
  };
  return { ...runtime, owner, request, add };
}

describe("persisted grant identities on actual D1", () => {
  it.each(["document", "folder"])(
    "restores the original %s ID, including concurrent re-adds and subsequent revocation",
    async (type) => {
      const f = await fixture();
      const url = `/v1/${type}s/shared/grants`;
      const original = await f.add(url);
      expect(await f.add(url)).toBe(original);
      expect((await f.request(`${url}/${original}`, "DELETE")).status).toBe(204);
      expect(
        await f.env.DB.prepare(`SELECT id FROM ${type}_grants WHERE id=?`)
          .bind(original)
          .first(),
      ).toBeNull();
      expect(
        (await f.request(`${url}/${original}`, "PATCH", { role: "editor" })).status,
      ).toBe(404);
      expect((await f.request(`${url}/${original}`, "DELETE")).status).toBe(404);
      expect(await Promise.all([f.add(url), f.add(url)])).toEqual([original, original]);
      expect(
        (await f.request(`${url}/${original}`, "PATCH", { role: "editor" })).status,
      ).toBe(200);
      expect((await f.request(`${url}/${original}`, "DELETE")).status).toBe(204);
      expect(await f.add(url)).toBe(original);
    },
  );

  it("backfills existing grants, captures direct seeds, and namespaces resource types", async () => {
    const f = await fixture();
    await f.env.DB.batch([
      f.env.DB.prepare("DROP TRIGGER document_grants_capture_identity"),
      f.env.DB.prepare("DROP TRIGGER folder_grants_capture_identity"),
      f.env.DB.prepare("DROP TABLE grant_identities"),
      f.env.DB.prepare(
        "INSERT INTO document_grants VALUES ('document-original','shared','user','reader','viewer','owner')",
      ),
      f.env.DB.prepare(
        "INSERT INTO folder_grants VALUES ('folder-original','shared','user','reader','viewer','user','owner')",
      ),
    ]);
    const migration = await readFile(
      new URL("../app/migrations/0010_grant_identities.sql", import.meta.url),
      "utf8",
    );
    for (const statement of splitSQLStatements(migration))
      await f.env.DB.prepare(statement).run();
    for (const type of ["document", "folder"]) {
      const url = `/v1/${type}s/shared/grants`;
      expect((await f.request(`${url}/${type}-original`, "DELETE")).status).toBe(204);
      expect(await f.add(url)).toBe(`${type}-original`);
      await f.env.DB.prepare(
        type === "document"
          ? "INSERT INTO document_grants VALUES ('direct-document','shared','anyone','','viewer','owner')"
          : "INSERT INTO folder_grants VALUES ('direct-folder','shared','anyone','','viewer','user','owner')",
      ).run();
      expect((await f.request(`${url}/direct-${type}`, "DELETE")).status).toBe(204);
      expect(await f.add(url, { type: "anyone", id: "" })).toBe(`direct-${type}`);
    }
  });

  it("captures the default document grant created by the service", async () => {
    const f = await fixture();
    const doc = await createDocument(
      f.env,
      { principal: f.owner, credentialKind: "session" },
      "Default grant",
      new TextEncoder().encode("source"),
      "viewer",
    );
    const stored = await f.env.DB.prepare(
      "SELECT id FROM document_grants WHERE document_id=? AND principal_type='anyone'",
    )
      .bind(doc.id)
      .first<{ id: string }>();
    expect(stored).not.toBeNull();
    const url = `/v1/documents/${doc.id}/grants`;
    expect((await f.request(`${url}/${stored?.id}`, "DELETE")).status).toBe(204);
    expect(await f.add(url, { type: "anyone", id: "" })).toBe(stored?.id);
  });
});
