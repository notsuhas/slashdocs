import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Hono } from "hono";
import type { AppEnv } from "../app/src/env";
import { ApiError } from "../shared/errors";
import { commentRoutes } from "../app/src/routes/comments";
import { createTestEnv, seedUser } from "./runtime";
import { createFolder, moveDocument } from "../app/src/services/folders";

const commentDTO = z.object({
  id: z.string(),
  mentions: z.array(z.unknown()),
  reactions: z.array(
    z.object({ emoji: z.string(), count: z.number(), reacted: z.boolean() }),
  ),
  status: z.string(),
  resolved_at: z.string().optional(),
  replies: z.array(z.unknown()).optional(),
});
const listDTO = z.object({ items: z.array(commentDTO) });

describe("document review permissions and DTOs", () => {
  let runtime: Awaited<ReturnType<typeof createTestEnv>>;
  let app: Hono<AppEnv>;
  beforeEach(async () => {
    runtime = await createTestEnv();
    const owner = await seedUser(runtime.env, "usr_owner");
    await seedUser(runtime.env, "usr_commenter");
    await seedUser(runtime.env, "usr_editor");
    await seedUser(runtime.env, "usr_viewer");
    for (const doc of ["doc_aaaaaaaa", "doc_bbbbbbbb"]) {
      await runtime.env.DB.prepare(
        "INSERT INTO documents(id,title,owner_user_id,current_version_id,updated_at) VALUES(?,?,?,?,?)",
      )
        .bind(
          doc,
          "Review",
          owner.id,
          doc === "doc_aaaaaaaa" ? "ver_aaaaaaaa" : "ver_bbbbbbbb",
          new Date().toISOString(),
        )
        .run();
      await runtime.env.DB.prepare(
        "INSERT INTO versions(id,document_id,number,object_key,sha256,byte_length,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
        .bind(
          doc === "doc_aaaaaaaa" ? "ver_aaaaaaaa" : "ver_bbbbbbbb",
          doc,
          1,
          doc + ".html",
          "abc",
          10,
          owner.id,
          new Date().toISOString(),
        )
        .run();
      for (const role of ["commenter", "editor", "viewer"])
        await runtime.env.DB.prepare(
          "INSERT INTO document_grants(id,document_id,principal_type,principal_id,role,granted_by_user_id) VALUES(?,?,?,?,?,?)",
        )
          .bind(doc + role, doc, "user", "usr_" + role, role, owner.id)
          .run();
    }
    app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        principal: { type: "user", id: c.req.header("X-Actor") || "usr_owner" },
        credentialKind: "session",
      });
      await next();
    });
    app.onError((error, c) =>
      c.json(
        {
          error: {
            code: error instanceof ApiError ? error.code : "internal",
            message: error.message,
          },
        },
        error instanceof ApiError ? (error.status as 400) : 500,
      ),
    );
    app.route("/", commentRoutes);
  });
  afterEach(async () => {
    await runtime.dispose();
  });
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    actor = "usr_commenter",
  ) {
    return app.request(
      "/v1/documents/" + path,
      {
        method,
        headers: { "Content-Type": "application/json", "X-Actor": actor },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      runtime.env,
    );
  }
  async function create() {
    const response = await call("doc_aaaaaaaa/comments", "POST", {
      version_id: "ver_aaaaaaaa",
      body: "Review this",
      anchor: { quote: "this" },
    });
    expect(response.status).toBe(201);
    return commentDTO.parse(await response.json());
  }
  it("uses inherited folder access for comment writes and rejects writes after revocation", async () => {
    const owner = {
      principal: { type: "user" as const, id: "usr_owner" },
      credentialKind: "session" as const,
    };
    const folder = await createFolder(runtime.env, owner, "Reviews");
    await moveDocument(runtime.env, owner, "doc_aaaaaaaa", folder.id);
    await runtime.env.DB.prepare("DELETE FROM document_grants WHERE document_id=?")
      .bind("doc_aaaaaaaa")
      .run();
    await runtime.env.DB.prepare(
      "INSERT INTO folder_grants(id,folder_id,principal_type,principal_id,role,granted_by_type,granted_by_id) VALUES('inherited',?,'user','usr_commenter','commenter','user','usr_owner')",
    )
      .bind(folder.id)
      .run();
    const response = await call(
      "doc_aaaaaaaa/comments",
      "POST",
      { version_id: "ver_aaaaaaaa", body: "Inherited", anchor: { quote: "this" } },
      "usr_commenter",
    );
    expect(response.status).toBe(201);
    const comment = commentDTO.parse(await response.json());
    await runtime.env.DB.prepare(
      "DELETE FROM folder_grants WHERE id='inherited'",
    ).run();
    expect(
      (
        await call(
          `doc_aaaaaaaa/comments/${comment.id}`,
          "PATCH",
          { body: "Revoked" },
          "usr_commenter",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "doc_aaaaaaaa/comments",
          "POST",
          { version_id: "ver_aaaaaaaa", body: "Denied", anchor: { quote: "this" } },
          "usr_commenter",
        )
      ).status,
    ).toBe(403);
  });
  it("creates anchored threads and replies with empty mentions/reactions; validates version and parent document membership", async () => {
    expect(
      (
        await call("doc_aaaaaaaa/comments", "POST", {
          version_id: "ver_bbbbbbbb",
          body: "Review",
          anchor: { quote: "this" },
        })
      ).status,
    ).toBe(404);
    const root = await create();
    expect(root.mentions).toEqual([]);
    expect(root.reactions).toEqual([]);
    expect(
      (
        await call(`doc_bbbbbbbb/comments/${root.id}/replies`, "POST", {
          body: "Reply",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(`doc_aaaaaaaa/comments/${root.id}/replies`, "POST", {
          body: "Reply",
        })
      ).status,
    ).toBe(201);
    const list = listDTO.parse(await (await call("doc_aaaaaaaa/comments")).json());
    expect(list.items).toHaveLength(1);
    expect(list.items[0].replies).toHaveLength(1);
  });
  it("enforces viewer, author-only deletion and editor moderation; resolves and reopens", async () => {
    const root = await create();
    expect(
      (
        await call(
          "doc_aaaaaaaa/comments",
          "POST",
          { version_id: "ver_aaaaaaaa", body: "bad", anchor: { quote: "this" } },
          "usr_viewer",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          `doc_aaaaaaaa/comments/${root.id}`,
          "PATCH",
          { body: "moderated" },
          "usr_editor",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          `doc_aaaaaaaa/comments/${root.id}`,
          "DELETE",
          undefined,
          "usr_editor",
        )
      ).status,
    ).toBe(403);
    const resolved = commentDTO.parse(
      await (
        await call(`doc_aaaaaaaa/comments/${root.id}`, "PATCH", {
          body: "",
          status: "resolved",
        })
      ).json(),
    );
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolved_at).toBeTruthy();
    const reopened = commentDTO.parse(
      await (
        await call(`doc_aaaaaaaa/comments/${root.id}`, "PATCH", { status: "open" })
      ).json(),
    );
    expect(reopened.status).toBe("open");
    expect(reopened.resolved_at).toBeUndefined();
  });
  it("confines idempotent reactions to the named document and enforces structured mention media types", async () => {
    const root = await create();
    expect(
      (await call(`doc_bbbbbbbb/comments/${root.id}/reactions/heart`, "PUT")).status,
    ).toBe(404);
    expect(
      (await call(`doc_aaaaaaaa/comments/${root.id}/reactions/heart`, "PUT")).status,
    ).toBe(204);
    expect(
      (await call(`doc_aaaaaaaa/comments/${root.id}/reactions/heart`, "PUT")).status,
    ).toBe(204);
    const list = listDTO.parse(await (await call("doc_aaaaaaaa/comments")).json());
    expect(list.items[0].reactions[0]).toMatchObject({
      emoji: "heart",
      count: 1,
      reacted: true,
    });
    expect(
      (
        await call(`doc_aaaaaaaa/comments/${root.id}`, "PATCH", {
          mentions: [
            { principal: { type: "user", id: "usr_editor" }, offset: 0, length: 3 },
          ],
        })
      ).status,
    ).toBe(415);
  });
  it("removes only author-owned threads and blocks subsequent mutation of deleted or inaccessible comments", async () => {
    const root = await create();
    const reply = commentDTO.parse(
      await (
        await call(`doc_aaaaaaaa/comments/${root.id}/replies`, "POST", {
          body: "Child",
        })
      ).json(),
    );
    expect(
      (
        await call(
          `doc_aaaaaaaa/comments/${root.id}/reactions/heart`,
          "PUT",
          undefined,
          "usr_viewer",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          `doc_aaaaaaaa/comments/${root.id}`,
          "PATCH",
          { body: "bad" },
          "usr_viewer",
        )
      ).status,
    ).toBe(403);
    expect((await call(`doc_aaaaaaaa/comments/${root.id}`, "DELETE")).status).toBe(204);
    expect(
      listDTO.parse(await (await call("doc_aaaaaaaa/comments")).json()).items,
    ).toEqual([]);
    expect(
      (
        await call(`doc_aaaaaaaa/comments/${root.id}/replies`, "POST", {
          body: "Child",
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(`doc_aaaaaaaa/comments/${reply.id}/reactions/heart`, "PUT")).status,
    ).toBe(404);
    await runtime.env.DB.prepare(
      "DELETE FROM document_grants WHERE document_id=? AND principal_id=?",
    )
      .bind("doc_aaaaaaaa", "usr_commenter")
      .run();
    expect((await call("doc_aaaaaaaa/comments")).status).toBe(403);
  });
  it("rejects empty bodies, legacy mention markers, invalid status and cross-document edits without changing data", async () => {
    const root = await create();
    expect(
      (await call(`doc_aaaaaaaa/comments/${root.id}`, "PATCH", { body: "" })).status,
    ).toBe(400);
    expect(
      (
        await call(`doc_aaaaaaaa/comments/${root.id}`, "PATCH", {
          body: "old\u2063mention",
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(`doc_aaaaaaaa/comments/${root.id}`, "PATCH", { status: "unknown" }))
        .status,
    ).toBe(400);
    expect(
      (await call(`doc_bbbbbbbb/comments/${root.id}`, "PATCH", { body: "changed" }))
        .status,
    ).toBe(404);
    expect(
      (await call(`doc_aaaaaaaa/comments/${root.id}/reactions/unsupported`, "PUT"))
        .status,
    ).toBe(400);
    expect(
      (await call(`doc_aaaaaaaa/comments/${root.id}/reactions/heart`, "DELETE")).status,
    ).toBe(204);
    expect(
      listDTO.parse(await (await call("doc_aaaaaaaa/comments")).json()).items[0]
        .reactions,
    ).toEqual([]);
  });
});
