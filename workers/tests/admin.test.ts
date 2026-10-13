import { afterEach, beforeEach, expect, it } from "vitest";
import { app } from "../app/src/index";
import { hashToken, nowSeconds } from "../app/src/auth/tokens";
import { createTestEnv, seedUser } from "./runtime";
let runtime: Awaited<ReturnType<typeof createTestEnv>>;
const token = "admin-test-session";
const headers = { Cookie: `__Host-slashdocs_session=${token}` };
beforeEach(async () => {
  runtime = await createTestEnv({
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
