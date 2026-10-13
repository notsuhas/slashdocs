import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app/src/env";
import { listDocuments } from "../app/src/services/documents";
import { listComments } from "../app/src/services/comments";
import { versionRoutes } from "../app/src/routes/versions";
import { grantRoutes } from "../app/src/routes/grants";
import { createTestEnv, seedUser } from "./runtime";

describe("D1 list query budgets", () => {
  let runtime: Awaited<ReturnType<typeof createTestEnv>>;
  const actor = {
    principal: { type: "user" as const, id: "usr_owner" },
    credentialKind: "session" as const,
  };
  beforeEach(async () => {
    runtime = await createTestEnv();
    await seedUser(runtime.env, actor.principal.id);
    const db = runtime.env.DB;
    for (let i = 0; i < 60; i++) {
      await seedUser(runtime.env, `usr_${i}`, `reader${i}@example.com`);
      await db.batch([
        db
          .prepare(
            "INSERT INTO documents(id,title,owner_user_id,current_version_id,updated_at) VALUES(?,?,?,?,?)",
          )
          .bind(
            `doc_${i}`,
            `Document ${i}`,
            actor.principal.id,
            `ver_${i}`,
            "2026-01-01",
          ),
        db
          .prepare(
            "INSERT INTO versions(id,document_id,number,object_key,sha256,byte_length,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .bind(
            `ver_${i}`,
            `doc_${i}`,
            1,
            `${i}.html`,
            "abc",
            10,
            `usr_${i}`,
            "2026-01-01",
          ),
      ]);
      await db.batch([
        db
          .prepare(
            "INSERT INTO versions(id,document_id,number,object_key,sha256,byte_length,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .bind(
            `history_${i}`,
            "doc_0",
            i + 2,
            `history_${i}.html`,
            "abc",
            10,
            `usr_${i}`,
            "2026-01-01",
          ),
        db
          .prepare(
            "INSERT INTO comments(id,document_id,created_on_version_id,author_user_id,author_email,author_name,body,anchor_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            `cmt_${i}`,
            "doc_0",
            "ver_0",
            `usr_${i}`,
            `reader${i}@example.com`,
            "Test Reader",
            `Comment ${i}`,
            '{"quote":"hello"}',
            "2026-01-01",
            "2026-01-01",
          ),
        db
          .prepare(
            "INSERT INTO document_grants(id,document_id,principal_type,principal_id,role,granted_by_user_id) VALUES(?,?,'user',?,'viewer',?)",
          )
          .bind(`grt_${i}`, "doc_0", `usr_${i}`, actor.principal.id),
      ]);
      await db
        .prepare(
          "INSERT INTO comment_reactions(comment_id,user_id,emoji) VALUES(?,?,'thumbsup')",
        )
        .bind(`cmt_${i}`, `usr_${i}`)
        .run();
    }
    await runtime.env.DOCUMENTS.put("0.html", "hello");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await runtime.dispose();
  });
  it("hydrates every document owner in one statement", async () => {
    const db = runtime.env.DB;
    const count = vi.fn((query: string) => db.prepare(query));
    const env = {
      ...runtime.env,
      DB: new Proxy(db, {
        get(target, key) {
          return key === "prepare" ? count : Reflect.get(target, key);
        },
      }),
    };
    const items = await listDocuments(env, actor, "");
    expect(items).toHaveLength(25);
    expect(items.every((item) => item.owner?.email === "reader@example.com")).toBe(
      true,
    );
    expect(count).toHaveBeenCalledTimes(1);
  });
  it("hydrates 60 comment authors, mentions and reactions in four statements", async () => {
    const db = runtime.env.DB;
    const count = vi.fn((query: string) => db.prepare(query));
    const env = {
      ...runtime.env,
      DB: new Proxy(db, {
        get(target, key) {
          return key === "prepare" ? count : Reflect.get(target, key);
        },
      }),
    };
    const items = await listComments(env, actor, "doc_0", "", "ver_0");
    expect(items).toHaveLength(60);
    expect(
      items.every(
        (item) =>
          item.author?.email &&
          item.reactions?.[0]?.count === 1 &&
          item.reactions[0].reactors?.[0]?.email === item.author.email,
      ),
    ).toBe(true);
    expect(count).toHaveBeenCalledTimes(4);
  });
  it("hydrates 61 version creators and 60 access principals within the Free budget", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    app.route("/", versionRoutes);
    app.route("/", grantRoutes);
    const db = runtime.env.DB;
    const count = vi.fn((query: string) => db.prepare(query));
    const env = {
      ...runtime.env,
      DB: new Proxy(db, {
        get(target, key) {
          return key === "prepare" ? count : Reflect.get(target, key);
        },
      }),
    };
    const versions = await app.request(
      "https://app.example.com/v1/documents/doc_0/versions",
      undefined,
      env,
    );
    const versionList = z
      .object({
        items: z.array(z.object({ created_by: z.object({ email: z.string() }) })),
      })
      .parse(await versions.json());
    expect(versionList.items).toHaveLength(61);
    expect(count.mock.calls.length).toBeLessThanOrEqual(4);
    count.mockClear();
    const access = await app.request(
      "https://app.example.com/v1/documents/doc_0/access",
      undefined,
      env,
    );
    const accessList = z
      .object({
        items: z.array(z.object({ principal: z.object({ email: z.string() }) })),
      })
      .parse(await access.json());
    expect(accessList.items).toHaveLength(61);
    expect(count.mock.calls.length).toBeLessThanOrEqual(5);
  });
});
