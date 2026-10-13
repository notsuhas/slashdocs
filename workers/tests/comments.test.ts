import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app/src/env";
import { ApiError } from "../shared/errors";
import { requireComment, updateComment } from "../app/src/services/comments";
import { commentRoutes } from "../app/src/routes/comments";
import { createTestEnv, seedUser } from "./runtime";

const dto = z.object({
  id: z.string(),
  body: z.string(),
  author: z.object({ type: z.string(), name: z.string().optional() }),
  mentions: z.array(
    z.object({
      principal: z.object({
        type: z.string(),
        id: z.string(),
        name: z.string().optional(),
        email: z.string().optional(),
      }),
      offset: z.number(),
      length: z.number(),
    }),
  ),
  reactions: z.array(z.unknown()),
  parent_comment_id: z.string().optional(),
  current_placement: z
    .object({ status: z.string(), confidence: z.number(), matched_text: z.string() })
    .optional(),
  replies: z.array(z.unknown()).optional(),
});
const structured = "application/vnd.slashdocs.comment-mentions+json";
describe("Go comment contract on D1 and R2", () => {
  let runtime: Awaited<ReturnType<typeof createTestEnv>>;
  let app: Hono<AppEnv>;
  beforeAll(async () => {
    runtime = await createTestEnv();
    await seedUser(runtime.env, "usr_owner", "owner@example.com");
    await seedUser(runtime.env, "usr_target", "target@example.com");
    await runtime.env.DB.prepare(
      "INSERT INTO users(id,provider,provider_subject,email,name,created_at) VALUES('sa_bot','service_account','sa_bot','','Robot',?)",
    )
      .bind(new Date().toISOString())
      .run();
    await runtime.env.DB.prepare(
      "INSERT INTO documents(id,title,owner_user_id,current_version_id,updated_at) VALUES('doc_comments','Comments','usr_owner','ver_second',?)",
    )
      .bind(new Date().toISOString())
      .run();
    for (const [id, number, html] of [
      ["ver_first", 1, "<p>selected text</p>"],
      ["ver_second", 2, "<p>different text</p>"],
    ] satisfies [string, number, string][]) {
      await runtime.env.DB.prepare(
        "INSERT INTO versions(id,document_id,number,object_key,sha256,byte_length,created_by_user_id,created_at) VALUES(?,'doc_comments',?,?,?,?,'usr_owner',?)",
      )
        .bind(id, number, id, "abc", html.length, new Date().toISOString())
        .run();
      await runtime.env.DOCUMENTS.put(id, html);
    }
    app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        principal: { type: "user", id: "usr_owner" },
        credentialKind: "session",
      });
      await next();
    });
    app.onError((error) =>
      Response.json(
        { error: { message: error.message } },
        { status: error instanceof ApiError ? error.status : 500 },
      ),
    );
    app.route("/", commentRoutes);
  });
  afterAll(async () => runtime.dispose());
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    media = "application/json",
  ) {
    return app.request(
      "/v1/documents/doc_comments/comments" + path,
      {
        method,
        headers: { "Content-Type": media },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      runtime.env,
    );
  }
  async function create(body = "Plain", mentions: unknown[] = [], media = structured) {
    const response = await call(
      "",
      "POST",
      { body, mentions, version_id: "ver_first", anchor: { quote: "selected text" } },
      media,
    );
    expect(response.status).toBe(201);
    return dto.parse(await response.json());
  }
  const target = (offset: number, length: number) => ({
    principal: { type: "user", id: "usr_target", name: "spoof" },
    offset,
    length,
  });
  it("hydrates canonical identities and UTF-16 ranges for users and service accounts", async () => {
    const root = await create("😀 @target@example.com and @Robot", [
      { principal: { type: "service_account", id: "sa_bot" }, offset: 27, length: 6 },
      target(3, 19),
    ]);
    expect(root.mentions).toEqual([
      {
        principal: {
          type: "user",
          id: "usr_target",
          email: "target@example.com",
          name: "Test Reader",
        },
        offset: 3,
        length: 19,
      },
      {
        principal: { type: "service_account", id: "sa_bot", name: "Robot" },
        offset: 27,
        length: 6,
      },
    ]);
    const reply = await call(
      `/${root.id}/replies`,
      "POST",
      {
        body: "@Robot",
        mentions: [
          {
            principal: { type: "service_account", id: "sa_bot" },
            offset: 0,
            length: 6,
          },
        ],
      },
      structured,
    );
    expect(reply.status).toBe(201);
    const result = await reply.json();
    expect(dto.parse(result).mentions).toHaveLength(1);
    expect(result).not.toHaveProperty("current_placement");
    expect(result).not.toHaveProperty("root_comment_id");
  });
  it("enforces current and legacy structured media types while allowing empty creation mentions", async () => {
    expect(
      (
        await call("", "POST", {
          body: "@target@example.com",
          mentions: [target(0, 19)],
          version_id: "ver_first",
          anchor: { quote: "x" },
        })
      ).status,
    ).toBe(415);
    await create(
      "@target@example.com",
      [target(0, 19)],
      "application/vnd.aidocs.comment-mentions+json; charset=utf-8",
    );
    const root = await create("Plain", [], "application/json");
    expect((await call(`/${root.id}`, "PATCH", { mentions: [] })).status).toBe(415);
    expect(
      (await call(`/${root.id}`, "PATCH", { mentions: [] }, structured)).status,
    ).toBe(200);
  });
  it("preserves mentions on status and identical-body patches and clears them on changed bodies", async () => {
    const root = await create("@target@example.com", [target(0, 19)]);
    for (const update of [{ status: "resolved" }, { body: "@target@example.com" }]) {
      const response = await call(`/${root.id}`, "PATCH", update);
      expect(response.status).toBe(200);
      expect(dto.parse(await response.json()).mentions).toHaveLength(1);
    }
    const response = await call(`/${root.id}`, "PATCH", { body: "Changed" });
    expect(dto.parse(await response.json()).mentions).toEqual([]);
  });
  it("retains historical renamed labels only up to their stored occurrence count", async () => {
    const root = await create("@Test Reader", [target(0, 12)]);
    await runtime.env.DB.prepare(
      "UPDATE users SET name='New Name' WHERE id='usr_target'",
    ).run();
    const moved = await call(
      `/${root.id}`,
      "PATCH",
      { body: "Now @Test Reader", mentions: [target(4, 12)] },
      structured,
    );
    expect(moved.status).toBe(200);
    expect(dto.parse(await moved.json()).mentions[0].principal.name).toBe("New Name");
    expect(
      (
        await call(
          `/${root.id}`,
          "PATCH",
          {
            body: "@Test Reader @Test Reader",
            mentions: [target(0, 12), target(13, 12)],
          },
          structured,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          "",
          "POST",
          {
            body: "@Test Reader",
            mentions: [target(0, 12)],
            version_id: "ver_first",
            anchor: { quote: "x" },
          },
          structured,
        )
      ).status,
    ).toBe(400);
    await runtime.env.DB.prepare(
      "UPDATE users SET name='Test Reader' WHERE id='usr_target'",
    ).run();
  });
  it("rejects split surrogate pairs, overlap, nonexistent principals and partial or spoofed labels", async () => {
    const cases = [
      { body: "😀 @target@example.com", mentions: [target(1, 20)] },
      { body: "@target@example.com", mentions: [target(0, 19), target(0, 19)] },
      { body: "@target@example.com", mentions: [target(0, 7)] },
      { body: "x@target@example.com", mentions: [target(1, 19)] },
      { body: "@fake", mentions: [target(0, 5)] },
      {
        body: "@missing",
        mentions: [
          { principal: { type: "user", id: "missing" }, offset: 0, length: 8 },
        ],
      },
    ];
    for (const item of cases)
      expect(
        (
          await call(
            "",
            "POST",
            { ...item, version_id: "ver_first", anchor: { quote: "x" } },
            structured,
          )
        ).status,
      ).toBe(400);
  });
  it("accepts terminal Unicode punctuation and exactly 50 mentions", async () => {
    await create("(@target@example.com)!", [target(1, 19)]);
    const label = "@target@example.com";
    await create(
      Array(50).fill(label).join(" "),
      Array.from({ length: 50 }, (_, i) => target(i * 20, 19)),
    );
    expect(
      (
        await call(
          "",
          "POST",
          {
            body: Array(51).fill(label).join(" "),
            mentions: Array.from({ length: 51 }, (_, i) => target(i * 20, 19)),
            version_id: "ver_first",
            anchor: { quote: "x" },
          },
          structured,
        )
      ).status,
    ).toBe(400);
  });
  it("uses Go raw-HTML placement and literal stored-status filtering", async () => {
    const root = await create();
    const list = z.object({ items: z.array(dto) }).parse(await (await call("")).json());
    expect(
      list.items.find((item) => item.id === root.id)?.current_placement,
    ).toMatchObject({ status: "orphaned", confidence: 0, matched_text: "" });
    const first = z
      .object({ items: z.array(dto) })
      .parse(await (await call("?version_id=ver_first")).json());
    expect(
      first.items.find((item) => item.id === root.id)?.current_placement?.status,
    ).toBe("attached");
    for (const status of ["all", "orphaned", "stale", "unknown"])
      expect(await (await call("?status=" + status)).json()).toEqual({ items: [] });
  });
  it("cascades visible deletion through nested replies and rejects legacy markers", async () => {
    const root = await create();
    const reply = dto.parse(
      await (await call(`/${root.id}/replies`, "POST", { body: "Reply" })).json(),
    );
    const nested = dto.parse(
      await (await call(`/${reply.id}/replies`, "POST", { body: "Nested" })).json(),
    );
    expect((await call(`/${reply.id}`, "DELETE")).status).toBe(204);
    expect((await call(`/${nested.id}/replies`, "POST", { body: "No" })).status).toBe(
      404,
    );
    expect(
      (await call(`/${root.id}`, "PATCH", { body: "old\u2063marker" })).status,
    ).toBe(400);
  });
  it("matches omitted/null patch fields and validates MIME parameters", async () => {
    const root = await create();
    expect(
      (
        await call(`/${root.id}`, "PATCH", {
          body: null,
          status: "resolved",
          mentions: null,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(`/${root.id}`, "PATCH", { body: null, status: null, mentions: null }))
        .status,
    ).toBe(400);
    expect(
      (
        await call(
          "",
          "POST",
          { body: "plain", version_id: "ver_first", anchor: { quote: "x" } },
          "application/json; invalid",
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await call(
          `/${root.id}`,
          "PATCH",
          { mentions: [] },
          structured + '; charset="utf-8"',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          `/${root.id}`,
          "PATCH",
          { mentions: [] },
          structured + "; charset=utf-8; charset=ascii",
        )
      ).status,
    ).toBe(415);
    expect((await call("/missing", "PATCH", { body: "x" })).status).toBe(403);
  });
  it("queues new mentions through real mutation batches and excludes failed CAS", async () => {
    runtime.env.SLASHDOCS_SLACK_BOT_TOKEN = "test-slack-token";
    try {
      const root = await create("@target@example.com", [target(0, 19)]);
      expect(
        await runtime.env.DB.prepare(
          "SELECT reason FROM comment_notification_outbox WHERE comment_id=? AND recipient_id='usr_target'",
        )
          .bind(root.id)
          .first(),
      ).toEqual({ reason: "mention" });
      const plain = await create();
      const row = await requireComment(runtime.env, "doc_comments", plain.id);
      await runtime.env.DB.prepare(
        "UPDATE comments SET updated_at='concurrent' WHERE id=?",
      )
        .bind(plain.id)
        .run();
      await expect(
        updateComment(
          runtime.env,
          { principal: { type: "user", id: "usr_owner" }, credentialKind: "session" },
          row,
          "@target@example.com",
          undefined,
          [target(0, 19)],
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        await runtime.env.DB.prepare(
          "SELECT comment_id FROM comment_notification_outbox WHERE comment_id=?",
        )
          .bind(plain.id)
          .first(),
      ).toBeNull();
      expect(
        await runtime.env.DB.prepare(
          "SELECT comment_id FROM comment_mentions WHERE comment_id=?",
        )
          .bind(plain.id)
          .first(),
      ).toBeNull();
      expect(
        await runtime.env.DB.prepare(
          "SELECT token FROM notification_mutation_guards",
        ).first(),
      ).toBeNull();
      const updated = await call(
        `/${plain.id}`,
        "PATCH",
        { body: "@target@example.com", mentions: [target(0, 19)] },
        structured,
      );
      expect(updated.status).toBe(200);
      expect(
        await runtime.env.DB.prepare(
          "SELECT reason FROM comment_notification_outbox WHERE comment_id=?",
        )
          .bind(plain.id)
          .first(),
      ).toEqual({ reason: "mention" });
    } finally {
      runtime.env.SLASHDOCS_SLACK_BOT_TOKEN = undefined;
    }
  });
  it("orders emoji groups by first reaction and preserves historical comment author names", async () => {
    const root = await create();
    expect((await call(`/${root.id}/reactions/rocket`, "PUT")).status).toBe(204);
    expect((await call(`/${root.id}/reactions/+1`, "PUT")).status).toBe(204);
    expect((await call(`/${root.id}/reactions/rocket`, "PUT")).status).toBe(204);
    const list = z
      .object({
        items: z.array(
          z.object({
            id: z.string(),
            reactions: z.array(z.object({ emoji: z.string(), count: z.number() })),
          }),
        ),
      })
      .parse(await (await call("")).json());
    expect(list.items.find((item) => item.id === root.id)?.reactions).toEqual([
      { emoji: "rocket", count: 1 },
      { emoji: "+1", count: 1 },
    ]);
    await runtime.env.DB.prepare(
      "UPDATE users SET name='Renamed Owner' WHERE id='usr_owner'",
    ).run();
    try {
      const response = await call(`/${root.id}`, "PATCH", { status: "resolved" });
      expect(dto.parse(await response.json()).author.name).toBe("Test Reader");
    } finally {
      await runtime.env.DB.prepare(
        "UPDATE users SET name='Test Reader' WHERE id='usr_owner'",
      ).run();
    }
  });
});
