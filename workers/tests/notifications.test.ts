import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import type { Actor, AppEnv } from "../app/src/env";
import { ApiError } from "../shared/errors";
import { createTestEnv, seedUser } from "./runtime";
import { grantRoutes } from "../app/src/routes/grants";
import { notificationRoutes } from "../app/src/routes/notifications";
import {
  accessNotificationStatements,
  captureNotificationMutation,
  clearNotificationMutation,
  commentNotificationStatements,
  newMentionNotificationStatements,
  notificationPreferences,
  queuedGrantNotificationStatements,
  requestDocumentAccess,
  setNotificationPreferences,
  snapshotGrantNotificationStatements,
  notificationLifetime,
  type NotificationEnv,
} from "../app/src/services/notifications";
import {
  claimNotification,
  deliverNext,
  deliverNotification,
  finishNotification,
} from "../app/src/notifications/delivery";
import {
  DeliveryError,
  notificationPreview,
  notificationRetry,
  SlackSender,
  type SlackHTTP,
  slackMessage,
} from "../app/src/notifications/slack";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
const at = Date.now();
async function setup(enabled = true) {
  const rt = await createTestEnv(
    enabled ? { SLASHDOCS_SLACK_BOT_TOKEN: "test-token" } : {},
  );
  cleanup.push(rt.dispose);
  const env: NotificationEnv = rt.env;
  const owner = await seedUser(env, "owner", "owner@example.com");
  const reader = await seedUser(env, "reader", "reader@example.com");
  const author = await seedUser(env, "author", "author@example.com");
  await env.DB.prepare(
    "INSERT INTO documents(id,title,owner_user_id,updated_at) VALUES('doc','Test Document','owner',?)",
  )
    .bind(new Date(at).toISOString())
    .run();
  await env.DB.prepare(
    "INSERT INTO versions(id,document_id,number,object_key,sha256,byte_length,created_by_user_id,created_at) VALUES('ver','doc',1,'test','hash',1,'owner',?)",
  )
    .bind(new Date(at).toISOString())
    .run();
  const actor: Actor = { principal: reader, credentialKind: "session" };
  return { env, owner, reader, author, actor };
}
async function comment(
  env: NotificationEnv,
  id: string,
  author = "author",
  parent: string | null = null,
  root: string | null = null,
) {
  await env.DB.prepare(
    `INSERT INTO comments(id,document_id,created_on_version_id,author_user_id,parent_comment_id,root_comment_id,body,anchor_json,created_at,updated_at) VALUES(?,'doc','ver',?,?,?,'Hello','{"quote":"highlight"}',?,?)`,
  )
    .bind(
      id,
      author,
      parent,
      root,
      new Date(at).toISOString(),
      new Date(at).toISOString(),
    )
    .run();
}
async function grant(env: NotificationEnv, user = "reader", role = "viewer") {
  await env.DB.prepare(
    "INSERT INTO document_grants(id,document_id,principal_type,principal_id,role,granted_by_user_id) VALUES(?,'doc','user',?,?,'owner') ON CONFLICT(document_id,principal_type,principal_id) DO UPDATE SET role=excluded.role",
  )
    .bind("g_" + user, user, role)
    .run();
}
async function count(env: NotificationEnv, table: string) {
  return (
    await env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{ n: number }>()
  )?.n;
}
function routes(env: NotificationEnv, actor: Actor) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", notificationRoutes);
  app.route("/", grantRoutes);
  app.onError((error) =>
    error instanceof ApiError
      ? new Response(JSON.stringify({ error: error.code }), { status: error.status })
      : new Response(String(error), { status: 500 }),
  );
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request("https://app.example.com" + path, init), env);
}
describe("notification preferences and access requests on real D1", () => {
  it("defaults to enabled even without Slack, applies personal global/doc preference and clears all backlogs", async () => {
    const { env, actor, owner } = await setup(false);
    expect(await notificationPreferences(env, owner)).toEqual({
      enabled: true,
      effective_enabled: true,
    });
    expect(await setNotificationPreferences(env, owner, "doc", false)).toEqual({
      enabled: false,
      effective_enabled: false,
    });
    expect(await setNotificationPreferences(env, owner, "", false)).toEqual({
      enabled: false,
      effective_enabled: false,
    });
    expect(await setNotificationPreferences(env, owner, "doc", true)).toEqual({
      enabled: true,
      effective_enabled: false,
    });
    await setNotificationPreferences(env, owner, "", true);
    await comment(env, "c");
    const configured: NotificationEnv = {
      ...env,
      SLASHDOCS_SLACK_BOT_TOKEN: "test-token",
    };
    await configured.DB.batch(commentNotificationStatements(configured, "c", at));
    await requestDocumentAccess(configured, actor, "doc", at);
    await configured.DB.batch(
      accessNotificationStatements(
        configured,
        "doc",
        "direct",
        actor.principal,
        new Map([["owner", "viewer"]]),
        new Map([["owner", "editor"]]),
        at,
      ),
    );
    expect(await count(env, "comment_notification_outbox")).toBe(1);
    expect(await count(env, "document_access_request_notification_outbox")).toBe(1);
    expect(await count(env, "document_access_notification_outbox")).toBe(1);
    await setNotificationPreferences(env, owner, "doc", false);
    for (const table of [
      "comment_notification_outbox",
      "document_access_request_notification_outbox",
      "document_access_notification_outbox",
    ])
      expect(await count(env, table)).toBe(0);
    await setNotificationPreferences(env, owner, "doc", true);
    expect(await count(env, "comment_notification_outbox")).toBe(0);
  });
  it("returns identical 202 for missing/denied/repeat/access/config-disabled and coalesces at the 24h boundary", async () => {
    const { env, actor } = await setup();
    const call = routes(env, actor);
    for (const id of ["missing", "doc", "doc"]) {
      const res = await call(`/v1/documents/${id}/access-requests`, { method: "POST" });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "sent" });
    }
    expect(await count(env, "document_access_requests")).toBe(1);
    expect(await count(env, "document_access_request_notification_outbox")).toBe(1);
    await env.DB.prepare("DELETE FROM document_access_requests").run();
    await env.DB.prepare(
      "DELETE FROM document_access_request_notification_outbox",
    ).run();
    await Promise.all([
      requestDocumentAccess(env, actor, "doc", at),
      requestDocumentAccess(env, actor, "doc", at),
    ]);
    await env.DB.prepare(
      "DELETE FROM document_access_request_notification_outbox",
    ).run();
    await requestDocumentAccess(env, actor, "doc", at + notificationLifetime - 1);
    expect(await count(env, "document_access_request_notification_outbox")).toBe(0);
    await requestDocumentAccess(env, actor, "doc", at + notificationLifetime);
    expect(await count(env, "document_access_request_notification_outbox")).toBe(1);
    await grant(env);
    const res = await call("/v1/documents/doc/access-requests", { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "sent" });
    const disabled = await setup(false);
    await requestDocumentAccess(disabled.env, disabled.actor, "doc", at);
    expect(await count(disabled.env, "document_access_requests")).toBe(0);
  });
  it("requires doc viewer before parsing preferences, validates boolean/1024 bytes and keeps personal scopes", async () => {
    const { env, actor } = await setup();
    const call = routes(env, actor);
    expect((await call("/v1/documents/doc/notifications")).status).toBe(403);
    await grant(env);
    for (const body of [
      "{}",
      '{"enabled":null}',
      '{"enabled":1}',
      "not json",
      JSON.stringify({ enabled: true, padding: "x".repeat(1024) }),
    ])
      expect((await call("/v1/me/notifications", { method: "PUT", body })).status).toBe(
        400,
      );
    const res = await call("/v1/documents/doc/notifications", {
      method: "PUT",
      body: '{"enabled":false}',
    });
    expect(await res.json()).toEqual({ enabled: false, effective_enabled: false });
    expect(
      await notificationPreferences(env, { type: "user", id: "owner" }, "doc"),
    ).toEqual({ enabled: true, effective_enabled: true });
  });
  it("routes requests to service-account human owner and uses service-account name", async () => {
    const { env, actor } = await setup();
    await env.DB.prepare(
      "INSERT INTO users(id,provider,provider_subject,email,name,created_at) VALUES('sa','service_account','sa','','Bot',?)",
    )
      .bind(new Date(at).toISOString())
      .run();
    await env.DB.prepare(
      "INSERT INTO service_accounts(id,name,owner_user_id,created_by_user_id,created_at) VALUES('sa','Bot','owner','owner',?)",
    )
      .bind(new Date(at).toISOString())
      .run();
    await env.DB.prepare(
      "UPDATE documents SET owner_user_id='sa' WHERE id='doc'",
    ).run();
    await requestDocumentAccess(env, actor, "doc", at);
    expect(
      await env.DB.prepare(
        "SELECT recipient_id FROM document_access_request_notification_outbox",
      ).first(),
    ).toMatchObject({ recipient_id: "owner" });
    await env.DB.prepare(
      "UPDATE documents SET owner_user_id='owner' WHERE id='doc'",
    ).run();
    await requestDocumentAccess(
      env,
      {
        principal: { type: "service_account", id: "sa", name: "Wrong name" },
        credentialKind: "service_account",
      },
      "doc",
      at,
    );
    expect(
      await env.DB.prepare(
        "SELECT requester_label FROM document_access_request_notification_outbox WHERE requester_id='sa'",
      ).first(),
    ).toMatchObject({ requester_label: "Bot" });
  });
});
describe("queued recipient and grant transaction parity", () => {
  it("chooses mention > reply > owner, suppresses self/SA/muted recipients and edits upgrade only new mentions", async () => {
    const { env, owner } = await setup();
    await comment(env, "root", "owner");
    await comment(env, "reply", "author", "root", "root");
    await env.DB.prepare(
      "INSERT INTO comment_mentions(comment_id,principal_type,principal_id,offset,length) VALUES('reply','user','owner',0,1),('reply','user','reader',2,1),('reply','user','author',4,1)",
    ).run();
    await env.DB.batch(commentNotificationStatements(env, "reply", at));
    expect(
      (
        await env.DB.prepare(
          "SELECT recipient_id,reason FROM comment_notification_outbox ORDER BY recipient_id",
        ).all()
      ).results,
    ).toEqual([
      { recipient_id: "owner", reason: "mention" },
      { recipient_id: "reader", reason: "mention" },
    ]);
    await env.DB.prepare("DELETE FROM comment_notification_outbox").run();
    await env.DB.prepare("DELETE FROM comment_mentions").run();
    await env.DB.batch(commentNotificationStatements(env, "reply", at));
    expect(
      await env.DB.prepare("SELECT reason FROM comment_notification_outbox").first(),
    ).toMatchObject({ reason: "reply" });
    await env.DB.batch(
      newMentionNotificationStatements(env, "reply", ["owner"], at + 100),
    );
    expect(
      await env.DB.prepare(
        "SELECT reason,available_at FROM comment_notification_outbox",
      ).first(),
    ).toMatchObject({ reason: "mention", available_at: at });
    await setNotificationPreferences(env, owner, "doc", false);
    await env.DB.batch(commentNotificationStatements(env, "reply", at));
    expect(await count(env, "comment_notification_outbox")).toBe(0);
  });
  it("never enqueues comment mentions after a failed CAS", async () => {
    const { env } = await setup();
    await comment(env, "c");
    const token = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("UPDATE comments SET body='changed' WHERE id='missing'"),
      captureNotificationMutation(env, token),
      ...newMentionNotificationStatements(env, "c", ["reader"], at, token),
      ...clearNotificationMutation(env, token),
    ]);
    expect(await count(env, "comment_notification_outbox")).toBe(0);
    expect(await count(env, "notification_mutation_guards")).toBe(0);
  });
  it("captures direct roles within the mutation batch, coalesces to original role, cancels roundtrips and excludes failed CAS", async () => {
    const { env, owner, reader } = await setup();
    async function change(role: string | undefined, fail = false) {
      const token = crypto.randomUUID();
      const mutation = role
        ? env.DB.prepare(
            "INSERT INTO document_grants(id,document_id,principal_type,principal_id,role,granted_by_user_id) SELECT 'g','doc','user','reader',?,'owner' WHERE ?=0 ON CONFLICT(document_id,principal_type,principal_id) DO UPDATE SET role=excluded.role",
          ).bind(role, Number(fail))
        : env.DB.prepare(
            "DELETE FROM document_grants WHERE document_id='doc' AND principal_id='reader' AND ?=0",
          ).bind(Number(fail));
      await env.DB.batch([
        ...snapshotGrantNotificationStatements(env, "doc", reader, token),
        mutation,
        captureNotificationMutation(env, token),
        ...queuedGrantNotificationStatements(env, owner, token, at),
        ...clearNotificationMutation(env, token),
      ]);
    }
    await change("viewer", true);
    expect(await count(env, "document_access_notification_outbox")).toBe(0);
    await change("viewer");
    expect(
      await env.DB.prepare(
        "SELECT reason,previous_role,role FROM document_access_notification_outbox",
      ).first(),
    ).toEqual({ reason: "access_shared", previous_role: "", role: "viewer" });
    await change("editor");
    expect(
      await env.DB.prepare(
        "SELECT reason,previous_role,role FROM document_access_notification_outbox",
      ).first(),
    ).toEqual({ reason: "access_shared", previous_role: "", role: "editor" });
    await change(undefined);
    expect(await count(env, "document_access_notification_outbox")).toBe(0);
    expect(await count(env, "notification_access_snapshots")).toBe(0);
  });
});
describe("org-wide grant recipient snapshots", () => {
  it("only notifies opened human users, compares inherited effective roles, and never queues failed CAS", async () => {
    const { env, owner } = await setup();
    await env.DB.prepare(
      "INSERT INTO document_workspace_entries(document_id,principal_type,principal_id) VALUES('doc','user','reader')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO folders(id,title,title_key,owner_type,owner_id,created_at,updated_at) VALUES('folder','Folder','folder','user','owner',?,?)",
    )
      .bind(new Date(at).toISOString(), new Date(at).toISOString())
      .run();
    await env.DB.prepare(
      "UPDATE documents SET parent_folder_id='folder' WHERE id='doc'",
    ).run();
    await env.DB.prepare(
      "INSERT INTO folder_grants(id,folder_id,principal_type,principal_id,role,granted_by_type,granted_by_id) VALUES('fg','folder','user','reader','viewer','user','owner')",
    ).run();
    async function change(fail = false) {
      const token = crypto.randomUUID();
      await env.DB.batch([
        ...snapshotGrantNotificationStatements(
          env,
          "doc",
          { type: "anyone", id: "*" },
          token,
        ),
        env.DB.prepare(
          "INSERT INTO document_grants(id,document_id,principal_type,principal_id,role,granted_by_user_id) SELECT 'public','doc','anyone','*','editor','owner' WHERE ?=0",
        ).bind(Number(fail)),
        captureNotificationMutation(env, token),
        ...queuedGrantNotificationStatements(env, owner, token, at),
        ...clearNotificationMutation(env, token),
      ]);
    }
    await change(true);
    expect(await count(env, "document_access_notification_outbox")).toBe(0);
    await change();
    expect(
      (
        await env.DB.prepare(
          "SELECT recipient_id,source,reason,previous_role,role FROM document_access_notification_outbox",
        ).all()
      ).results,
    ).toEqual([
      {
        recipient_id: "reader",
        source: "opened",
        reason: "access_updated",
        previous_role: "viewer",
        role: "editor",
      },
    ]);
  });
});
describe("durable claim and delivery policy", () => {
  it("leases atomically, recovers after one minute, ignores stale finish and expires strictly older than 24h", async () => {
    const { env } = await setup();
    await comment(env, "c");
    await env.DB.batch(commentNotificationStatements(env, "c", at));
    const first = await claimNotification(env, "comment", at);
    expect(first?.attempts).toBe(1);
    expect(await claimNotification(env, "comment", at + 59999)).toBeNull();
    const second = await claimNotification(env, "comment", at + 60000);
    expect(second?.attempts).toBe(2);
    if (!first || !second) throw new Error("missing claim");
    await finishNotification(env, "comment", first, 0, at);
    expect(await count(env, "comment_notification_outbox")).toBe(1);
    await finishNotification(env, "comment", second, 1000, at + 60000);
    expect(
      (await claimNotification(env, "comment", at + notificationLifetime))?.attempts,
    ).toBe(3);
    expect(
      await claimNotification(env, "comment", at + notificationLifetime + 1),
    ).toBeNull();
    expect(await count(env, "comment_notification_outbox")).toBe(0);
  });
  it("rechecks access, owner and requester access, applies per-user 6s gate and retries transient failures", async () => {
    const { env, actor } = await setup();
    await comment(env, "c");
    await env.DB.batch(commentNotificationStatements(env, "c", at));
    const send = vi.fn(async () => {});
    expect(await deliverNext(env, "comment", { send }, at)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toHaveLength(2);
    await requestDocumentAccess(env, actor, "doc", at);
    expect(await deliverNext(env, "request", { send }, at + 1)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await count(env, "document_access_request_notification_outbox")).toBe(1);
    await grant(env);
    await deliverNext(env, "request", { send }, at + 6001);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await count(env, "document_access_request_notification_outbox")).toBe(0);
    await env.DB.prepare("DELETE FROM document_access_requests").run();
    await env.DB.prepare("DELETE FROM document_grants").run();
    await requestDocumentAccess(env, actor, "doc", at + 6002);
    const fail = vi.fn(async () => {
      throw new DeliveryError("rate_limited", false, 30000);
    });
    await deliverNext(env, "request", { send: fail }, at + 6002);
    expect(
      await env.DB.prepare(
        "SELECT attempts,available_at FROM document_access_request_notification_outbox",
      ).first(),
    ).toMatchObject({ attempts: 1, available_at: at + 36002 });
  });
  it("drops stale direct grants, unreadable comments and owner-changed requests", async () => {
    const { env, actor, owner, reader } = await setup();
    await env.DB.batch(
      accessNotificationStatements(
        env,
        "doc",
        "direct",
        owner,
        new Map([["reader", ""]]),
        new Map([["reader", "viewer"]]),
        at,
      ),
    );
    const send = vi.fn(async () => {});
    await deliverNext(env, "access", { send }, at);
    expect(send).not.toHaveBeenCalled();
    await comment(env, "c", "owner");
    await env.DB.batch(newMentionNotificationStatements(env, "c", ["reader"], at));
    const n = await claimNotification(env, "comment", at);
    if (!n) throw new Error("missing claim");
    expect(await deliverNotification(env, "comment", n, { send }, at)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    await requestDocumentAccess(env, actor, "doc", at);
    await env.DB.prepare("UPDATE documents SET owner_user_id=?").bind(reader.id).run();
    await deliverNext(env, "request", { send }, at);
    expect(send).not.toHaveBeenCalled();
  });
});
describe("Slack parity with external HTTP mocked", () => {
  it("redacts before Unicode truncation and keeps mentions literal with no removal action", () => {
    expect(
      notificationPreview("password: secret OTP is 123456 4111 1111 1111 1111", 200),
    ).toBe("password: [redacted] OTP is [redacted] [redacted card number]");
    expect(notificationPreview("😀😀😀", 2)).toBe("😀…");
    const msg = slackMessage("dm", {
      reason: "mention",
      link: "https://app.example.com/app/d/doc",
      documentTitle: "<@everyone>",
      body: "<!channel>",
    });
    expect(msg).toMatchObject({
      mrkdwn: false,
      parse: "none",
      link_names: false,
      unfurl_links: false,
    });
    expect(JSON.stringify(msg.blocks)).toContain("<!channel>");
    expect(
      slackMessage("dm", {
        reason: "access_removed",
        link: "https://app.example.com/app/d/doc",
        documentTitle: "Doc",
        previousRole: "editor",
      }).blocks,
    ).toHaveLength(2);
    expect(notificationRetry(10, new Error())).toBe(256000);
    expect(notificationRetry(1, new DeliveryError("invalid_auth", true))).toBe(0);
  });
  it("looks up email, opens DM and posts with Go payload, retries429 and permanently drops ineligible users", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const http: SlackHTTP = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify(
          calls.length === 1
            ? { ok: true, user: { id: "U" } }
            : calls.length === 2
              ? { ok: true, channel: { id: "D" } }
              : { ok: true },
        ),
      );
    };
    await new SlackSender("token", http).send("reader@example.com", {
      reason: "access_requested",
      documentTitle: "Doc",
      link: "https://app.example.com/d/doc",
      requester: "Reader",
    });
    expect(calls.map((c) => c.url.split("/").at(-1))).toEqual([
      "users.lookupByEmail",
      "conversations.open",
      "chat.postMessage",
    ]);
    expect(calls[0].init).toMatchObject({
      redirect: "manual",
      body: "email=reader%40example.com",
    });
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({
      channel: "D",
      parse: "none",
    });
    const rate: SlackHTTP = async () =>
      new Response("", { status: 429, headers: { "Retry-After": "31" } });
    await expect(
      new SlackSender("token", rate).send("x", {
        reason: "owner",
        documentTitle: "",
        link: "",
      }),
    ).rejects.toMatchObject({ code: "rate_limited", retryAfter: 31000 });
    const bot: SlackHTTP = async () =>
      new Response(JSON.stringify({ ok: true, user: { id: "U", is_bot: true } }));
    await expect(
      new SlackSender("token", bot).send("x", {
        reason: "owner",
        documentTitle: "",
        link: "",
      }),
    ).rejects.toMatchObject({ code: "ineligible_user", permanent: true });
  });
});

describe("document grant HTTP mutations queue atomically", () => {
  const body = (value: unknown, method = "POST") => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  it("coalesces grant CRUD, respects preferences, and increments self-revocation revision", async () => {
    const { env, owner, reader } = await setup();
    const request = routes(env, { principal: owner, credentialKind: "session" });
    const created = await request(
      "/v1/documents/doc/grants",
      body({ principal: { type: "user", id: reader.id }, role: "viewer" }),
    );
    expect(created.status).toBe(201);
    const createdGrant = z.object({ id: z.string() }).parse(await created.json());
    expect(await count(env, "document_access_notification_outbox")).toBe(1);
    expect(
      (
        await request(
          `/v1/documents/doc/grants/${createdGrant.id}`,
          body({ role: "editor" }, "PATCH"),
        )
      ).status,
    ).toBe(200);
    const pending = await env.DB.prepare(
      "SELECT previous_role,role,reason FROM document_access_notification_outbox",
    ).first();
    expect(pending).toMatchObject({
      previous_role: "",
      role: "editor",
      reason: "access_shared",
    });
    expect(
      (
        await request(`/v1/documents/doc/grants/${createdGrant.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(await count(env, "document_access_notification_outbox")).toBe(0);
    await setNotificationPreferences(env, reader, "doc", false);
    expect(
      (
        await request(
          "/v1/documents/doc/grants",
          body({ principal: { type: "user", id: reader.id }, role: "commenter" }),
        )
      ).status,
    ).toBe(201);
    expect(await count(env, "document_access_notification_outbox")).toBe(0);
    const selfGrant = await env.DB.prepare(
      "SELECT id FROM document_grants WHERE principal_id=?",
    )
      .bind(reader.id)
      .first<{ id: string }>();
    const before = await env.DB.prepare(
      "SELECT access_revision FROM documents WHERE id='doc'",
    ).first<{ access_revision: number }>();
    const selfRequest = routes(env, { principal: reader, credentialKind: "session" });
    expect(
      (
        await selfRequest(`/v1/documents/doc/grants/${selfGrant?.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(
      await env.DB.prepare(
        "SELECT access_revision FROM documents WHERE id='doc'",
      ).first(),
    ).toMatchObject({ access_revision: (before?.access_revision ?? 0) + 1 });
    expect(await count(env, "notification_mutation_guards")).toBe(0);
    expect(await count(env, "notification_access_snapshots")).toBe(0);
  });
  it("suppresses queue and revision when permission is revoked between preflight and grant CAS", async () => {
    const { env, reader, author } = await setup();
    await grant(env, reader.id, "commenter");
    const db = env.DB;
    const racingEnv = {
      ...env,
      DB: new Proxy(db, {
        get(target, key) {
          if (key === "batch")
            return async (statements: D1PreparedStatement[]) => {
              await db
                .prepare("DELETE FROM document_grants WHERE principal_id=?")
                .bind(reader.id)
                .run();
              return db.batch(statements);
            };
          return Reflect.get(target, key);
        },
      }),
    };
    const request = routes(racingEnv, { principal: reader, credentialKind: "session" });
    expect(
      (
        await request(
          "/v1/documents/doc/grants",
          body({ principal: { type: "user", id: author.id }, role: "viewer" }),
        )
      ).status,
    ).toBe(403);
    expect(await count(env, "document_access_notification_outbox")).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT access_revision FROM documents WHERE id='doc'",
      ).first(),
    ).toMatchObject({ access_revision: 0 });
    expect(await count(env, "notification_mutation_guards")).toBe(0);
    expect(await count(env, "notification_access_snapshots")).toBe(0);
  });
  it("captures CAS success without Slack configured", async () => {
    const { env, owner, reader } = await setup(false);
    const request = routes(env, { principal: owner, credentialKind: "session" });
    expect(
      (
        await request(
          "/v1/documents/doc/grants",
          body({ principal: { type: "user", id: reader.id }, role: "viewer" }),
        )
      ).status,
    ).toBe(201);
    expect(
      await env.DB.prepare(
        "SELECT access_revision FROM documents WHERE id='doc'",
      ).first(),
    ).toMatchObject({ access_revision: 1 });
    expect(await count(env, "document_access_notification_outbox")).toBe(0);
    expect(await count(env, "notification_mutation_guards")).toBe(0);
  });
});
