import { Hono } from "hono";
import type { AppEnv } from "../app/src/env";
import { requireAuth } from "../app/src/auth/middleware";
import { activityRateLimit } from "../app/src/auth/activity-limit";
import { observeActivity, pruneAdminObservations } from "../app/src/services/admin";
import { afterEach, beforeEach, expect, it } from "vitest";
import { app } from "../app/src/index";
import { hashToken, nowSeconds } from "../app/src/auth/tokens";
import { seedUser } from "./runtime";
import { createMCPRuntime } from "./mcp-runtime";
let runtime: Awaited<ReturnType<typeof createMCPRuntime>>;
const token = "admin-test-session";
const headers = { Cookie: `__Host-slashdocs_session=${token}` };
beforeEach(async () => {
  runtime = await createMCPRuntime({
    ADMIN_USERS: "  READER@EXAMPLE.COM,other@example.com ",
  });
  await seedUser(runtime.env);
  await runtime.env.DB.prepare("INSERT INTO sessions VALUES(?,?,?)")
    .bind(await hashToken(token), "usr_test", nowSeconds() + 3600)
    .run();
});
afterEach(async () => {
  await runtime.dispose();
});
it("denies anonymous callers and users outside the admin allowlist", async () => {
  expect(
    (await app.request("https://app.example.com/v1/admin/stats", {}, runtime.env))
      .status,
  ).toBe(401);
  runtime.env.ADMIN_USERS = "";
  expect(
    (
      await app.request(
        "https://app.example.com/v1/admin/stats",
        { headers },
        runtime.env,
      )
    ).status,
  ).toBe(403);
  runtime.env.ADMIN_USERS = "someone@example.com";
  expect(
    (
      await app.request(
        "https://app.example.com/v1/admin/stats",
        { headers },
        runtime.env,
      )
    ).status,
  ).toBe(403);
});
it("reports real D1 counts, excludes placeholders and expired sessions, and does not count dashboard requests", async () => {
  await seedUser(runtime.env, "invited", "invited@example.com");
  await runtime.env.DB.prepare(
    "UPDATE users SET provider='placeholder' WHERE id='invited'",
  ).run();
  await runtime.env.DB.prepare("INSERT INTO sessions VALUES('expired','invited',?)")
    .bind(nowSeconds() - 1)
    .run();
  await app.request("https://app.example.com/v1/me", { headers }, runtime.env);
  const response = await app.request(
    "https://app.example.com/v1/admin/stats",
    { headers },
    runtime.env,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({
    users: 1,
    active_24h: 1,
    active_7d: 1,
    active_30d: 1,
    logged_in_users: 1,
    sessions: 1,
    documents: 0,
    storage_bytes: 0,
    daily: [{ requests: 1, active_users: 1 }],
  });
  await app.request(
    "https://app.example.com/v1/auth/logout",
    { method: "POST", headers: { ...headers, Origin: runtime.env.APP_ORIGIN } },
    runtime.env,
  );
  const token2 = "admin-test-session-2";
  await runtime.env.DB.prepare("INSERT INTO sessions VALUES(?,?,?)")
    .bind(await hashToken(token2), "usr_test", nowSeconds() + 3600)
    .run();
  const me = await app.request(
    "https://app.example.com/v1/me",
    { headers: { Cookie: `__Host-slashdocs_session=${token2}` } },
    runtime.env,
  );
  expect(await me.json()).toMatchObject({ is_admin: true });
  expect(
    await runtime.env.DB.prepare(
      "SELECT count(*) AS n FROM sessions WHERE token_hash=?",
    )
      .bind(await hashToken(token))
      .first(),
  ).toEqual({ n: 0 });
});

it("excludes deleted documents from content totals", async () => {
  const now = new Date().toISOString();
  await runtime.env.DB.prepare(
    "INSERT INTO documents(id,title,owner_user_id,updated_at) VALUES('doc_live','Live','usr_test',?)",
  )
    .bind(now)
    .run();
  await runtime.env.DB.prepare(
    "INSERT INTO versions(id,document_id,number,object_key,sha256,byte_length,created_by_user_id,created_at) VALUES('ver_live','doc_live',1,'live','sha',42,'usr_test',?)",
  )
    .bind(now)
    .run();
  let response = await app.request(
    "https://app.example.com/v1/admin/stats",
    { headers },
    runtime.env,
  );
  expect(await response.json()).toMatchObject({
    documents: 1,
    versions: 1,
    storage_bytes: 42,
  });
  await runtime.env.DB.prepare("UPDATE documents SET deleted_at=? WHERE id='doc_live'")
    .bind(now)
    .run();
  response = await app.request(
    "https://app.example.com/v1/admin/stats",
    { headers },
    runtime.env,
  );
  expect(await response.json()).toMatchObject({
    documents: 0,
    versions: 0,
    storage_bytes: 0,
  });
});
it("denies service accounts even if their email matches the admin allowlist", async () => {
  const now = new Date().toISOString();
  await runtime.env.DB.prepare(
    "INSERT INTO users(id,provider,provider_subject,email,name,picture_url,created_at) VALUES('sa_test','service_account','sa_test','reader@example.com','Bot','',?)",
  )
    .bind(now)
    .run();
  await runtime.env.DB.prepare(
    "INSERT INTO service_accounts(id,name,owner_user_id,created_by_user_id,created_at) VALUES('sa_test','Bot','usr_test','usr_test',?)",
  )
    .bind(now)
    .run();
  const token = "slashdocs_sa_test";
  await runtime.env.DB.prepare(
    "INSERT INTO service_account_keys(id,service_account_id,name,token_hash,created_at) VALUES('key_test','sa_test','test',?,?)",
  )
    .bind(await hashToken(token), now)
    .run();
  const response = await app.request(
    "https://app.example.com/v1/admin/stats",
    { headers: { Authorization: `Bearer ${token}` } },
    runtime.env,
  );
  expect(response.status).toBe(403);
});

it("counts a forwarded realtime KV request once and excludes heartbeats and streams", async () => {
  await runtime.env.DB.prepare(
    "INSERT INTO documents(id,title,owner_user_id,updated_at) VALUES('doc_kv','KV','usr_test',?)",
  )
    .bind(new Date().toISOString())
    .run();
  const response = await runtime.fetch(
    "https://app.example.com/v1/documents/doc_kv/kv",
    { headers },
  );
  expect(response.status).toBe(200);
  expect(
    await runtime.env.DB.prepare(
      "SELECT sum(requests) AS n FROM admin_activity",
    ).first(),
  ).toEqual({ n: 1 });
  await runtime.fetch("https://app.example.com/v1/documents/doc_kv/presence", {
    method: "POST",
    headers: {
      ...headers,
      Origin: runtime.env.APP_ORIGIN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ version_id: "missing" }),
  });
  const stream = await runtime.fetch(
    "https://app.example.com/v1/documents/doc_kv/kv/events",
    { headers },
  );
  await stream.body?.cancel();
  expect(
    await runtime.env.DB.prepare(
      "SELECT sum(requests) AS n FROM admin_activity",
    ).first(),
  ).toEqual({ n: 1 });
});
it("persists initialization independently of first traffic and prunes old activity", async () => {
  const started = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  await runtime.env.DB.prepare("UPDATE admin_metadata SET tracking_started_at=?")
    .bind(started)
    .run();
  let response = await app.request(
    "https://app.example.com/v1/admin/stats",
    { headers },
    runtime.env,
  );
  expect(await response.json()).toMatchObject({ tracking_since: started, daily: [] });
  await runtime.env.DB.prepare(
    "INSERT INTO admin_activity VALUES('2000-01-01','old',1,5,'2000-01-01T00:00:00.000Z')",
  ).run();
  await runtime.env.DB.prepare("INSERT INTO sessions VALUES('expired','usr_test',?)")
    .bind(nowSeconds() - 1)
    .run();
  await pruneAdminObservations(runtime.env);
  response = await app.request(
    "https://app.example.com/v1/admin/stats",
    { headers },
    runtime.env,
  );
  expect(await response.json()).toMatchObject({
    tracking_since: started,
    daily: [],
    sessions: 1,
  });
  expect(
    await runtime.env.DB.prepare("SELECT count(*) AS n FROM admin_activity").first(),
  ).toEqual({ n: 0 });
  expect(
    await runtime.env.DB.prepare(
      "SELECT count(*) AS n FROM sessions WHERE token_hash='expired'",
    ).first(),
  ).toEqual({ n: 0 });
});
it("records MCP API operations exactly once without counting discovery messages", async () => {
  const token = "slashdocs_mcp_admin";
  await runtime.env.DB.prepare(
    "INSERT INTO mcp_tokens(token_hash,user_id,resource,scope,expires_at) VALUES(?,'usr_test',?,'mcp',?)",
  )
    .bind(await hashToken(token), runtime.env.APP_ORIGIN + "/mcp", nowSeconds() + 3600)
    .run();
  const mcp = (method: string, params: object) =>
    app.request(
      "https://app.example.com/mcp",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      },
      runtime.env,
    );
  expect((await mcp("tools/list", {})).status).toBe(200);
  expect(
    await runtime.env.DB.prepare("SELECT count(*) AS n FROM admin_activity").first(),
  ).toEqual({ n: 0 });
  expect((await mcp("tools/call", { name: "whoami", arguments: {} })).status).toBe(200);
  expect(
    await runtime.env.DB.prepare(
      "SELECT sum(requests) AS n FROM admin_activity",
    ).first(),
  ).toEqual({ n: 1 });
});
it("does not count rate-limited API attempts", async () => {
  const isolated = new Hono<AppEnv>();
  isolated.use("*", requireAuth, observeActivity, activityRateLimit());
  isolated.get("/v1/test", (c) => c.json({ ok: true }));
  for (let i = 0; i < 61; i++) {
    const response = await isolated.request(
      "https://app.example.com/v1/test",
      { headers },
      runtime.env,
    );
    expect(response.status).toBe(i === 60 ? 429 : 200);
  }
  expect(
    await runtime.env.DB.prepare(
      "SELECT sum(requests) AS n FROM admin_activity",
    ).first(),
  ).toEqual({ n: 60 });
});

it("prunes old records on the first operation without requiring a cron", async () => {
  await runtime.env.DB.prepare(
    "INSERT INTO admin_activity VALUES('2000-01-01','old',1,3,'2000-01-01T00:00:00.000Z')",
  ).run();
  await runtime.env.DB.prepare(
    "INSERT INTO sessions VALUES('expired-old','usr_test',?)",
  )
    .bind(nowSeconds() - 1)
    .run();
  await app.request("https://app.example.com/v1/me", { headers }, runtime.env);
  expect(
    await runtime.env.DB.prepare(
      "SELECT count(*) AS n FROM admin_activity WHERE day='2000-01-01'",
    ).first(),
  ).toEqual({ n: 0 });
  expect(
    await runtime.env.DB.prepare(
      "SELECT count(*) AS n FROM sessions WHERE token_hash='expired-old'",
    ).first(),
  ).toEqual({ n: 0 });
});
