import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { z, ZodError } from "zod";
import { createTestEnv, seedUser } from "./runtime";
import type { Actor, AppEnv, Env } from "../app/src/env";
import { ApiError } from "../shared/errors";
import { folderRoutes } from "../app/src/routes/folders";
import { browseRoutes, parseFeatured } from "../app/src/routes/browse";
import {
  createFolder,
  getFolder,
  updateFolder,
  deleteFolder,
  moveDocument,
  listFolders,
  effectiveAccess,
  requireFolder,
  searchFolders,
  resolveFolderPath,
  listFolderDocuments,
  folderTitleKey,
} from "../app/src/services/folders";
import { createDocument } from "../app/src/services/documents";
import { createVersion } from "../app/src/services/versions";
import { requireDocument } from "../app/src/services/permissions";
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});
async function fixture() {
  const runtime = await createTestEnv();
  disposers.push(runtime.dispose);
  // createTestEnv uses the shared trigger-aware migration loader.
  const owner: Actor = {
    principal: await seedUser(runtime.env, "usr_folder_owner", "owner@example.com"),
    credentialKind: "session",
  };
  const other: Actor = {
    principal: await seedUser(runtime.env, "usr_folder_other", "other@example.com"),
    credentialKind: "session",
  };
  const stranger: Actor = {
    principal: await seedUser(
      runtime.env,
      "usr_folder_stranger",
      "stranger@example.com",
    ),
    credentialKind: "session",
  };
  return { ...runtime, owner, other, stranger };
}
async function grant(
  env: Env,
  owner: Actor,
  folder: string,
  actor: Actor | "anyone",
  role = "viewer",
  id = "grant",
) {
  await env.DB.prepare(
    "INSERT INTO folder_grants(id,folder_id,principal_type,principal_id,role,granted_by_type,granted_by_id) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      folder,
      actor === "anyone" ? "anyone" : actor.principal.type,
      actor === "anyone" ? "" : actor.principal.id,
      role,
      owner.principal.type,
      owner.principal.id,
    )
    .run();
}
function app(actor: Actor) {
  const client = new Hono<AppEnv>();
  client.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  client.route("/", folderRoutes);
  client.route("/", browseRoutes);
  client.onError(
    (error) =>
      new Response(
        JSON.stringify({
          error: {
            code:
              error instanceof ApiError
                ? error.code
                : error instanceof ZodError
                  ? "bad_request"
                  : "internal",
            message: error.message,
          },
        }),
        {
          status:
            error instanceof ApiError
              ? error.status
              : error instanceof ZodError
                ? 400
                : 500,
          headers: { "content-type": "application/json" },
        },
      ),
  );
  return client;
}
function json(body: unknown, method = "POST") {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
describe("actual D1 folder parity", () => {
  it("inherits grants additively without inheriting ownership and reports provenance", async () => {
    const { env, owner, other, stranger } = await fixture();
    const root = await createFolder(env, owner, "Root");
    await grant(env, owner, root.id, other, "editor");
    const child = await createFolder(env, other, "Child", root.id);
    await expect(requireFolder(env, owner, child.id, "viewer")).rejects.toMatchObject({
      status: 403,
    });
    const doc = await createDocument(
      env,
      other,
      "Document",
      new TextEncoder().encode("source"),
      "private",
    );
    await moveDocument(env, other, doc.id, child.id);
    await grant(env, owner, root.id, stranger, "commenter", "grant_stranger");
    expect((await requireDocument(env, stranger, doc.id, "viewer")).role).toBe(
      "commenter",
    );
    await env.DB.prepare(
      "INSERT INTO document_grants VALUES (?,?, 'user',?,'viewer',?)",
    )
      .bind("direct", doc.id, stranger.principal.id, owner.principal.id)
      .run();
    expect((await requireDocument(env, stranger, doc.id, "viewer")).role).toBe(
      "commenter",
    );
    const items = await effectiveAccess(env, "document", doc.id);
    expect(items.find((i) => i.principal.id === stranger.principal.id)).toMatchObject({
      effective_role: "commenter",
      sources: expect.arrayContaining([
        expect.objectContaining({ resource_type: "folder", resource_id: root.id }),
        expect.objectContaining({ resource_type: "document", resource_id: doc.id }),
      ]),
    });
    expect(items.filter((i) => i.effective_role === "owner")).toHaveLength(1);
  });
  it("keeps private ancestor names out of breadcrumbs and rechecks opened workspace rows after revocation", async () => {
    const { env, owner, other } = await fixture();
    const root = await createFolder(env, owner, "Private ancestor"),
      child = await createFolder(env, owner, "Shared child", root.id);
    await grant(env, owner, child.id, other);
    expect(await getFolder(env, other, child.id)).not.toHaveProperty("ancestors");
    expect((await listFolders(env, other)).items.map((i) => i.folder?.id)).toContain(
      child.id,
    );
    await env.DB.prepare("DELETE FROM folder_grants WHERE id='grant'").run();
    expect((await listFolders(env, other)).items).toEqual([]);
    await grant(env, owner, root.id, "anyone");
    expect((await listFolders(env, other)).items.map((i) => i.folder?.id)).toContain(
      child.id,
    );
    await getFolder(env, other, root.id);
    expect((await listFolders(env, other)).items.map((i) => i.folder?.id)).toEqual([
      root.id,
    ]);
  });
  it("enforces sibling uniqueness, max depth, subtree height and concurrent cycle prevention in SQLite writes", async () => {
    const { env, owner, other } = await fixture();
    const root = await createFolder(env, owner, "Root");
    await expect(createFolder(env, owner, "root")).rejects.toMatchObject({
      status: 409,
    });
    await grant(env, owner, root.id, other, "editor");
    await createFolder(env, owner, "Child", root.id);
    await expect(createFolder(env, other, "child", root.id)).rejects.toMatchObject({
      status: 409,
    });
    let parent = root.id;
    for (let depth = 2; depth <= 15; depth++)
      parent = (await createFolder(env, owner, `Depth ${depth}`, parent)).id;
    await expect(createFolder(env, owner, "Too deep", parent)).rejects.toMatchObject({
      status: 409,
    });
    const moving = await createFolder(env, owner, "Moving"),
      movingChild = await createFolder(env, owner, "Moving child", moving.id);
    await expect(
      updateFolder(env, owner, moving.id, undefined, parent),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      updateFolder(env, owner, moving.id, undefined, movingChild.id),
    ).rejects.toMatchObject({ status: 409 });
    const a = await createFolder(env, owner, "A"),
      b = await createFolder(env, owner, "B");
    const results = await Promise.allSettled([
      updateFolder(env, owner, a.id, undefined, b.id),
      updateFolder(env, owner, b.id, undefined, a.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("deletes owned descendants, preserves foreign subtree and documents, and resolves root title collisions", async () => {
    const { env, owner, other } = await fixture();
    const root = await createFolder(env, owner, "Root"),
      mine = await createFolder(env, owner, "Mine", root.id);
    await grant(env, owner, root.id, other, "editor");
    const theirs = await createFolder(env, other, "Notes", mine.id),
      kept = await createFolder(env, other, "Kept descendant", theirs.id);
    await createFolder(env, other, "Notes");
    await createFolder(env, other, "Notes (2)");
    const doc = await createDocument(
      env,
      owner,
      "Survives",
      new TextEncoder().encode("source"),
      "private",
    );
    await moveDocument(env, owner, doc.id, mine.id);
    await deleteFolder(env, owner, root.id);
    await expect(requireFolder(env, owner, mine.id, "viewer")).rejects.toMatchObject({
      status: 404,
    });
    expect(await getFolder(env, other, theirs.id)).toMatchObject({
      title: "Notes (3)",
    });
    expect(await getFolder(env, other, theirs.id)).not.toHaveProperty(
      "parent_folder_id",
    );
    expect(await getFolder(env, other, kept.id)).toMatchObject({
      parent_folder_id: theirs.id,
    });
    expect(
      (await requireDocument(env, owner, doc.id, "viewer")).document.parent_folder_id,
    ).toBeNull();
  });
  it("protects source-folder access during moves and lets document owners escape", async () => {
    const { env, owner, other, stranger } = await fixture();
    const source = await createFolder(env, owner, "Source"),
      destination = await createFolder(env, owner, "Destination");
    const doc = await createDocument(
      env,
      stranger,
      "Third owner",
      new TextEncoder().encode("source"),
      "private",
    );
    await grant(env, owner, source.id, stranger, "editor", "g_source");
    await moveDocument(env, stranger, doc.id, source.id);
    await grant(env, owner, destination.id, other, "editor", "g_destination");
    await env.DB.prepare(
      "INSERT INTO document_grants VALUES (?,?, 'user',?,'editor',?)",
    )
      .bind("doc_editor", doc.id, other.principal.id, stranger.principal.id)
      .run();
    await expect(
      moveDocument(env, other, doc.id, destination.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(moveDocument(env, other, doc.id, "")).rejects.toMatchObject({
      status: 403,
    });
    await env.DB.prepare("DELETE FROM folder_grants WHERE id='g_source'").run();
    await moveDocument(env, stranger, doc.id, "");
    expect(
      (await requireDocument(env, stranger, doc.id, "owner")).document.parent_folder_id,
    ).toBeNull();
  });
  it.each(["POST", "PATCH", "DELETE"])(
    "rejects %s grant mutations after an editor downgrade",
    async (method) => {
      const { env, owner, other } = await fixture();
      const folder = await createFolder(env, owner, "Downgrade");
      await grant(env, owner, folder.id, other, "editor", "member_editor");
      const created = await app(owner).request(
        `/v1/folders/${folder.id}/grants`,
        json({ principal: { type: "anyone" }, role: "viewer" }),
        env,
      );
      expect(created.status).toBe(201);
      const granted = z.object({ id: z.string() }).parse(await created.json());
      const prefix =
        method === "POST"
          ? "INSERT INTO folder_grants"
          : method === "PATCH"
            ? "UPDATE folder_grants SET role"
            : "DELETE FROM folder_grants";
      let downgraded = false;
      const guarded = {
        ...env,
        DB: new Proxy(env.DB, {
          get(target, key) {
            if (key === "prepare")
              return (sql: string) => {
                const statement = target.prepare(sql);
                if (!sql.startsWith(prefix)) return statement;
                const wrap = (bound: D1PreparedStatement): D1PreparedStatement =>
                  new Proxy(bound, {
                    get(target, key) {
                      if (key === "bind")
                        return (...args: unknown[]) => wrap(target.bind(...args));
                      if (key === "run")
                        return async () => {
                          await env.DB.prepare(
                            "UPDATE folder_grants SET role='commenter' WHERE id='member_editor'",
                          ).run();
                          downgraded = true;
                          return target.run();
                        };
                      const value = Reflect.get(target, key);
                      return typeof value === "function" ? value.bind(target) : value;
                    },
                  });
                return wrap(statement);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      };
      const path =
        `/v1/folders/${folder.id}/grants` + (method === "POST" ? "" : `/${granted.id}`);
      const input =
        method === "DELETE"
          ? { method }
          : { ...json({ principal: { type: "anyone" }, role: "editor" }), method };
      expect((await app(other).request(path, input, guarded)).status).toBe(
        method === "POST" ? 403 : 404,
      );
      expect(downgraded).toBe(true);
      expect(
        await env.DB.prepare("SELECT role FROM folder_grants WHERE id=?")
          .bind(granted.id)
          .first(),
      ).toEqual({ role: "viewer" });
    },
  );
  it("denies commenters folder grant mutations", async () => {
    const { env, owner, other } = await fixture();
    const folder = await createFolder(env, owner, "Sharing");
    await grant(env, owner, folder.id, other, "commenter");
    const created = await app(owner).request(
      `/v1/folders/${folder.id}/grants`,
      json({ principal: { type: "anyone" }, role: "viewer" }),
      env,
    );
    expect(created.status).toBe(201);
    const granted = z.object({ id: z.string() }).parse(await created.json());
    for (const [path, input] of [
      [
        `/v1/folders/${folder.id}/grants`,
        json({ principal: { type: "anyone" }, role: "editor" }),
      ],
      [
        `/v1/folders/${folder.id}/grants/${granted.id}`,
        { ...json({ role: "editor" }), method: "PATCH" },
      ],
      [`/v1/folders/${folder.id}/grants/${granted.id}`, { method: "DELETE" }],
    ] as const)
      expect((await app(other).request(path, input, env)).status).toBe(403);
  });
  it("preserves REST folder paths, null/absent patch semantics and editor sharing", async () => {
    const { env, owner, other } = await fixture(),
      client = app(owner);
    const created = await client.request("/v1/folders", json({ title: "API" }), env);
    expect(created.status, await created.clone().text()).toBe(201);
    const root = (await created.json()) as { id: string };
    const child = await createFolder(env, owner, "Child", root.id);
    expect((await client.request("/v1/folders?path=API/Child", {}, env)).status).toBe(
      200,
    );
    const unchanged = await client.request(
      `/v1/folders/${child.id}`,
      json({ title: "Renamed" }, "PATCH"),
      env,
    );
    expect(unchanged.status, await unchanged.clone().text()).toBe(200);
    expect(await unchanged.json()).toMatchObject({ parent_folder_id: root.id });
    const moved = await client.request(
      `/v1/folders/${child.id}`,
      json({ parent_folder_id: null }, "PATCH"),
      env,
    );
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await moved.json()).toMatchObject({ parent_folder_id: "" });
    await grant(env, owner, root.id, other, "editor");
    const shared = await app(other).request(
      `/v1/folders/${root.id}/grants`,
      json({ principal: { type: "anyone" }, role: "viewer" }),
      env,
    );
    expect(shared.status, await shared.clone().text()).toBe(201);
    const access = await app(other).request(`/v1/folders/${root.id}/access`, {}, env);
    expect(await access.json()).toMatchObject({
      current_role: "editor",
      items: expect.any(Array),
    });
    const otherRoot = await createFolder(env, other, "API");
    await grant(env, other, otherRoot.id, owner, "viewer", "g_otherroot");
    const ambiguous = await client.request("/v1/folders?path=API", {}, env);
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({
      error: { code: "ambiguous_path" },
      candidates: expect.any(Array),
    });
  });
  it("isolates document/folder pins and featured hiding while permanent sections remain visible", async () => {
    const { env, owner, other } = await fixture();
    const folder = await createFolder(env, owner, "Featured"),
      privateFolder = await createFolder(env, owner, "Private");
    await grant(env, owner, folder.id, "anyone");
    const doc = await createDocument(
      env,
      owner,
      "Featured doc",
      new TextEncoder().encode("source"),
      "viewer",
    );
    const configured = {
      ...env,
      FEATURED_SECTIONS: JSON.stringify({
        "Start here": { permanent: true, items: [folder.id] },
        Examples: { items: ["doc_missing", doc.id, folder.id, privateFolder.id] },
      }),
    };
    const client = app(other);
    expect(
      (await client.request(`/v1/pins/folder/${folder.id}`, { method: "PUT" }, env))
        .status,
    ).toBe(204);
    expect(
      (await client.request(`/v1/pins/document/${doc.id}`, { method: "PUT" }, env))
        .status,
    ).toBe(204);
    expect(
      z
        .object({ items: z.array(z.unknown()) })
        .parse(await (await client.request("/v1/pins", {}, env)).json()).items,
    ).toHaveLength(2);
    expect(
      z
        .object({ items: z.array(z.unknown()) })
        .parse(await (await app(owner).request("/v1/pins", {}, env)).json()).items,
    ).toEqual([]);
    const before = z
      .object({ items: z.array(z.object({ items: z.array(z.unknown()) })) })
      .parse(await (await client.request("/v1/featured", {}, configured)).json());
    expect(before.items).toHaveLength(2);
    expect(before.items[1].items).toHaveLength(2);
    expect(
      (
        await client.request(
          `/v1/featured/${folder.id}`,
          { method: "DELETE" },
          configured,
        )
      ).status,
    ).toBe(204);
    const after = z
      .object({ items: z.array(z.object({ items: z.array(z.unknown()) })) })
      .parse(await (await client.request("/v1/featured", {}, configured)).json());
    expect(after.items[0].items).toHaveLength(1);
    expect(after.items[1].items).toHaveLength(1);
    expect(
      (
        await client.request(
          `/v1/featured/${privateFolder.id}`,
          { method: "DELETE" },
          env,
        )
      ).status,
    ).toBe(404);
    await env.DB.prepare("DELETE FROM folder_grants").run();
    expect(
      z
        .object({ items: z.array(z.unknown()) })
        .parse(await (await client.request("/v1/pins", {}, env)).json()).items,
    ).toHaveLength(1);
  });
  it("keeps listing, ancestor and featured hydration within bounded query counts", async () => {
    const { env, owner } = await fixture();
    const root = await createFolder(env, owner, "Budget root");
    const statements = [];
    for (let index = 0; index < 60; index++)
      statements.push(
        env.DB.prepare(
          "INSERT INTO folders(id,title,title_key,owner_type,owner_id,parent_folder_id,created_at,updated_at) VALUES (?,?,?, 'user',?,?,?,?)",
        ).bind(
          `fld_budget_${index}`,
          `Budget ${index}`,
          folderTitleKey(`Budget ${index}`),
          owner.principal.id,
          root.id,
          "2026-01-01",
          "2026-01-01",
        ),
      );
    await env.DB.batch(statements);
    const db = env.DB,
      count = vi.fn((sql: string) => db.prepare(sql));
    const counted = {
      ...env,
      DB: new Proxy(db, {
        get(target, key) {
          const value = Reflect.get(target, key);
          return key === "prepare"
            ? count
            : typeof value === "function"
              ? value.bind(target)
              : value;
        },
      }),
    };
    const listing = await listFolders(counted, owner, root.id);
    expect(listing.items).toHaveLength(50);
    expect(listing.has_more).toBe(true);
    expect(count.mock.calls.length).toBeLessThanOrEqual(6);
    count.mockClear();
    await getFolder(counted, owner, "fld_budget_0");
    expect(count).toHaveBeenCalledTimes(1);
    count.mockClear();
    const configured = {
      ...counted,
      FEATURED_SECTIONS: JSON.stringify({
        All: {
          items: [root.id, ...Array.from({ length: 110 }, (_, i) => `fld_budget_${i}`)],
        },
      }),
    };
    const response = await app(owner).request("/v1/featured", {}, configured);
    expect(
      z
        .object({ items: z.array(z.object({ items: z.array(z.unknown()) })) })
        .parse(await response.json()).items[0].items,
    ).toHaveLength(61);
    expect(count).toHaveBeenCalledTimes(3);
  });
  it("supports service-account folder ownership, grants and pins through backing identities", async () => {
    const { env, owner } = await fixture();
    const identity = await seedUser(env, "sa_folder", "folder-bot@example.com");
    await env.DB.prepare("UPDATE users SET provider='service_account' WHERE id=?")
      .bind(identity.id)
      .run();
    const account: Actor = {
      principal: { ...identity, type: "service_account" },
      credentialKind: "service_account",
    };
    const folder = await createFolder(env, account, "Bot owned");
    expect(folder.owner?.type).toBe("service_account");
    expect((await requireFolder(env, account, folder.id, "owner")).role).toBe("owner");
    const shared = await createFolder(env, owner, "Shared with bot");
    const response = await app(owner).request(
      `/v1/folders/${shared.id}/grants`,
      json({ principal: { type: "service_account", id: identity.id }, role: "editor" }),
      env,
    );
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await requireFolder(env, account, shared.id, "editor")).role).toBe(
      "editor",
    );
    expect(
      (
        await app(account).request(
          `/v1/pins/folder/${folder.id}`,
          { method: "PUT" },
          env,
        )
      ).status,
    ).toBe(204);
  });
  it("rechecks revoked inherited editor access inside publication after R2 upload", async () => {
    const { env, owner, other } = await fixture();
    const folder = await createFolder(env, owner, "Inherited editor");
    const doc = await createDocument(
      env,
      owner,
      "Publication",
      new TextEncoder().encode("v1"),
      "private",
    );
    await moveDocument(env, owner, doc.id, folder.id);
    await grant(env, owner, folder.id, other, "editor");
    const paused = {
      ...env,
      DOCUMENTS: new Proxy(env.DOCUMENTS, {
        get(target, key) {
          if (key === "put")
            return async (...args: Parameters<R2Bucket["put"]>) => {
              await env.DB.prepare("DELETE FROM folder_grants WHERE id='grant'").run();
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
        other,
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
  });
  it("lists all child metadata and searches foreign descendants without inheriting ownership", async () => {
    const { env, owner, other, stranger } = await fixture();
    const root = await createFolder(env, owner, "Owned root");
    await grant(env, owner, root.id, other, "editor");
    const child = await createFolder(env, other, "Foreign child", root.id);
    const nested = await createFolder(env, other, "Foreign nested", child.id);
    const doc = await createDocument(
      env,
      other,
      "Private child document",
      new TextEncoder().encode("private"),
      "private",
    );
    await moveDocument(env, other, doc.id, root.id);
    expect((await listFolders(env, owner, root.id)).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ folder: expect.objectContaining({ id: child.id }) }),
        expect.objectContaining({ document: expect.objectContaining({ id: doc.id }) }),
      ]),
    );
    expect((await listFolderDocuments(env, owner, root.id)).map((d) => d.id)).toEqual([
      doc.id,
    ]);
    expect(
      (await searchFolders(env, owner, "Foreign")).map((i) => i.folder?.id),
    ).toEqual(expect.arrayContaining([child.id, nested.id]));
    await expect(getFolder(env, owner, child.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(requireDocument(env, owner, doc.id, "viewer")).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      updateFolder(env, owner, child.id, "Stolen", undefined),
    ).rejects.toMatchObject({ status: 403 });
    await expect(listFolders(env, stranger, root.id)).rejects.toMatchObject({
      status: 403,
    });
    await grant(env, owner, root.id, stranger, "viewer", "search_grant");
    expect(
      (await searchFolders(env, stranger, "Foreign")).map((i) => i.folder?.id),
    ).toHaveLength(2);
    await env.DB.prepare("DELETE FROM folder_grants WHERE id='search_grant'").run();
    expect(await searchFolders(env, stranger, "Foreign")).toEqual([]);
  });
  it("returns the same folder GET denial for private and absent IDs", async () => {
    const { env, owner, other } = await fixture();
    const privateFolder = await createFolder(env, owner, "Private");
    const responses = await Promise.all(
      [privateFolder.id, "fld_absent"].map((id) =>
        app(other).request(`/v1/folders/${id}`, {}, env),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([403, 403]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
  });
  it("uses Unicode title keys for create, rename, paths, search and private root ambiguity", async () => {
    const { env, owner, other } = await fixture();
    const root = await createFolder(env, owner, "Équipe");
    await expect(createFolder(env, owner, "équipe")).rejects.toMatchObject({
      status: 409,
    });
    const child = await createFolder(env, owner, "ÉTUDES", root.id);
    await expect(createFolder(env, owner, "études", root.id)).rejects.toMatchObject({
      status: 409,
    });
    const spare = await createFolder(env, owner, "Spare", root.id);
    await expect(
      updateFolder(env, owner, spare.id, "études", undefined),
    ).rejects.toMatchObject({ status: 409 });
    expect(await resolveFolderPath(env, owner, "", "éQUIPE/études")).toBe(child.id);
    expect((await searchFolders(env, owner, "éTUD")).map((i) => i.folder?.id)).toEqual([
      child.id,
    ]);
    await updateFolder(env, owner, child.id, "ÉCOLE", undefined);
    expect(await resolveFolderPath(env, owner, "", "équipe/école")).toBe(child.id);
    expect(await searchFolders(env, owner, "études")).toEqual([]);
    expect((await searchFolders(env, owner, "é%le")).map((i) => i.folder?.id)).toEqual([
      child.id,
    ]);
    const privateTwin = await createFolder(env, other, "équipe");
    expect(await resolveFolderPath(env, owner, "", "ÉQUIPE")).toBe(root.id);
    await grant(env, other, privateTwin.id, owner);
    await expect(resolveFolderPath(env, owner, "", "ÉQUIPE")).rejects.toMatchObject({
      status: 409,
      code: "ambiguous_path",
    });
  });
  it("suffixes multiple same-case foreign boundaries atomically on deletion", async () => {
    const { env, owner, other } = await fixture();
    const root = await createFolder(env, owner, "Delete root");
    const a = await createFolder(env, owner, "A", root.id);
    const b = await createFolder(env, owner, "B", root.id);
    await grant(env, owner, root.id, other, "editor");
    const first = await createFolder(env, other, "Équipe", a.id);
    const second = await createFolder(env, other, "éQUIPE", b.id);
    const kept = await createFolder(env, other, "Kept", first.id);
    await createFolder(env, other, "équipe");
    await createFolder(env, other, "ÉQUIPE (2)");
    await deleteFolder(env, owner, root.id);
    const rows = await env.DB.prepare(
      "SELECT title,title_key,parent_folder_id FROM folders WHERE id IN (?,?) ORDER BY title_key",
    )
      .bind(first.id, second.id)
      .all<{ title: string; title_key: string; parent_folder_id: string | null }>();
    expect(rows.results.map((r) => r.title_key)).toEqual(["équipe (3)", "équipe (4)"]);
    for (const row of rows.results) {
      expect(row.title_key).toBe(folderTitleKey(row.title));
      expect(row.parent_folder_id).toBeNull();
    }
    expect((await getFolder(env, other, kept.id)).parent_folder_id).toBe(first.id);
    await expect(createFolder(env, other, "ÉQUIPE (3)")).rejects.toMatchObject({
      status: 409,
    });
  });
  it("serializes concurrent create and reparent at the depth boundary", async () => {
    const { env, owner } = await fixture();
    let deep = await createFolder(env, owner, "Depth root");
    for (let depth = 2; depth <= 14; depth++)
      deep = await createFolder(env, owner, `D${depth}`, deep.id);
    const moving = await createFolder(env, owner, "Moving boundary");
    const results = await Promise.allSettled([
      createFolder(env, owner, "Concurrent child", moving.id),
      updateFolder(env, owner, moving.id, undefined, deep.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const duplicates = await Promise.allSettled([
      createFolder(env, owner, "École"),
      createFolder(env, owner, "école"),
    ]);
    expect(duplicates.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(duplicates.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it.each(["source", "destination", "document"] as const)(
    "rejects a move when %s access is revoked after prechecks",
    async (revoked) => {
      const { env, owner, other, stranger } = await fixture();
      const source = await createFolder(env, owner, "Source race");
      const destination = await createFolder(env, owner, "Destination race");
      await grant(env, owner, source.id, stranger, "editor", "setup");
      const doc = await createDocument(
        env,
        stranger,
        "Move race",
        new TextEncoder().encode("source"),
        "private",
      );
      await moveDocument(env, stranger, doc.id, source.id);
      await grant(env, owner, source.id, other, "editor", "source");
      await grant(env, owner, destination.id, other, "editor", "destination");
      await env.DB.prepare(
        "INSERT INTO document_grants VALUES (?,?,'user',?,'editor',?)",
      )
        .bind("document", doc.id, other.principal.id, stranger.principal.id)
        .run();
      // A viewer grant preserves source access while document-editor revocation
      // removes the only editor role on the document.
      if (revoked === "document")
        await env.DB.prepare(
          "UPDATE folder_grants SET role='viewer' WHERE id='source'",
        ).run();
      const paused = {
        ...env,
        DB: new Proxy(env.DB, {
          get(target, key) {
            if (key === "prepare")
              return (sql: string) => {
                const statement = target.prepare(sql);
                if (!sql.startsWith("UPDATE documents AS d SET parent_folder_id"))
                  return statement;
                const wrap = (bound: D1PreparedStatement): D1PreparedStatement =>
                  new Proxy(bound, {
                    get(target, key) {
                      if (key === "bind")
                        return (...args: unknown[]) => wrap(target.bind(...args));
                      if (key === "run")
                        return async () => {
                          await env.DB.prepare(
                            revoked === "document"
                              ? "DELETE FROM document_grants WHERE id=?"
                              : "DELETE FROM folder_grants WHERE id=?",
                          )
                            .bind(revoked)
                            .run();
                          return target.run();
                        };
                      const value = Reflect.get(target, key);
                      return typeof value === "function" ? value.bind(target) : value;
                    },
                  });
                return wrap(statement);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      };
      await expect(
        moveDocument(paused, other, doc.id, destination.id),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        (await requireDocument(env, stranger, doc.id, "owner")).document
          .parent_folder_id,
      ).toBe(source.id);
    },
  );
  it("hydrates mixed featured batches above 90 IDs and drops revoked pins", async () => {
    const { env, owner, other } = await fixture();
    const statements: D1PreparedStatement[] = [];
    const ids: string[] = [];
    for (let index = 0; index < 95; index++) {
      const folder = `fld_mixed_${index}`,
        doc = `doc_mixed_${index}`;
      ids.push(folder, doc);
      statements.push(
        env.DB.prepare(
          "INSERT INTO folders(id,title,title_key,owner_type,owner_id,created_at,updated_at) VALUES (?,?,?,'user',?,'2026-01-01','2026-01-01')",
        ).bind(folder, `Folder ${index}`, `folder ${index}`, owner.principal.id),
        env.DB.prepare(
          "INSERT INTO folder_grants(id,folder_id,principal_type,principal_id,role,granted_by_type,granted_by_id) VALUES (?,?,'anyone','','viewer','user',?)",
        ).bind(`fg_${index}`, folder, owner.principal.id),
        env.DB.prepare(
          "INSERT INTO documents(id,title,owner_user_id,updated_at) VALUES (?,?,?,'2026-01-01')",
        ).bind(doc, `Doc ${index}`, owner.principal.id),
        env.DB.prepare(
          "INSERT INTO document_grants VALUES (?,?,'anyone','','viewer',?)",
        ).bind(`dg_${index}`, doc, owner.principal.id),
      );
    }
    await env.DB.batch(statements);
    const client = app(other);
    for (const id of ids.slice(0, 2))
      expect(
        (
          await client.request(
            `/v1/pins/${id.startsWith("fld_") ? "folder" : "document"}/${id}`,
            { method: "PUT" },
            env,
          )
        ).status,
      ).toBe(204);
    const configured = {
      ...env,
      FEATURED_SECTIONS: JSON.stringify({ Mixed: { items: ids } }),
    };
    const before = await client.request("/v1/featured", {}, configured);
    const parse = (value: unknown) =>
      z
        .object({
          items: z.array(
            z.object({
              items: z.array(
                z.object({
                  type: z.string(),
                  folder: z.object({ id: z.string() }).optional(),
                  document: z.object({ id: z.string() }).optional(),
                }),
              ),
            }),
          ),
        })
        .parse(value)
        .items[0].items.map((i) => i.folder?.id ?? i.document?.id);
    expect(before.status).toBe(200);
    expect(parse(await before.json())).toEqual(ids);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM folder_grants WHERE id='fg_0'"),
      env.DB.prepare("DELETE FROM document_grants WHERE id='dg_0'"),
    ]);
    expect(
      parse(await (await client.request("/v1/featured", {}, configured)).json()),
    ).toEqual(ids.slice(2));
    expect(await (await client.request("/v1/pins", {}, env)).json()).toEqual({
      items: [],
    });
  });
  it("validates featured configuration", () => {
    expect(parseFeatured(" ")).toEqual([]);
    expect(() => parseFeatured('{"A":{"items":["doc_a"],"unknown":true}}')).toThrow();
    expect(() => parseFeatured('{"A":{"items":["ver_a"]}}')).toThrow();
  });
});
