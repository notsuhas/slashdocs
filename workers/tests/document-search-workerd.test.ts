import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import type { Actor, Env } from "../app/src/env";
import { hashToken, nowSeconds } from "../app/src/auth/tokens";
import { createDocument } from "../app/src/services/documents";
import { loadMigrationStatements } from "../scripts/read-migrations";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});
let bundle: Promise<string> | undefined;
async function fixture(overrides: Record<string, string> = {}) {
  bundle ||= build({
    stdin: {
      contents: `
        import app from './workers/app/src/index';
        import { DocumentSearch as Search } from './workers/app/src/realtime/document-search';
        export default app;
        // Test-only marker proves the public route crossed the real DO binding.
        export class DocumentSearch extends Search {
          async fetch(request) {
            const response = await super.fetch(request);
            response.headers.set('X-fixture-execution', 'durable-object');
            return response;
          }
        }
        export { DocumentRealtime } from './workers/app/src/realtime/document-realtime';
        export { NotificationDelivery } from './workers/app/src/notifications/delivery';
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
  }).then((result) => result.outputFiles[0].text);
  const mf = new Miniflare({
    modules: true,
    script: await bundle,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    r2Buckets: ["DOCUMENTS"],
    durableObjects: {
      DOCUMENT_SEARCH: { className: "DocumentSearch", useSQLite: true },
    },
    serviceBindings: {
      ASSETS: () => new Response("fixture"),
      GOOGLE_GROUPS_FETCHER: () => new Response("unavailable", { status: 503 }),
    },
    bindings: {
      APP_ORIGIN: "https://app.example.com",
      RENDER_ORIGIN: "https://render.example.com",
      SESSION_SECRET: "fixture-secret-not-used-for-signing",
      RENDER_PRIVATE_KEY: "{}",
      RENDER_PUBLIC_KEY: "{}",
      ...overrides,
    },
  });
  disposals.push(() => mf.dispose());
  const env = await mf.getBindings<Env & { DOCUMENT_SEARCH: DurableObjectNamespace }>();
  for (const statement of await loadMigrationStatements())
    await env.DB.prepare(statement).run();
  async function user(id: string) {
    await env.DB.prepare(
      "INSERT INTO users(id,provider,provider_subject,email,name,picture_url,created_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(id, "google", id, `${id}@example.com`, id, "", new Date().toISOString())
      .run();
    const credentialId = await hashToken(id);
    await env.DB.prepare("INSERT INTO sessions VALUES (?,?,?)")
      .bind(credentialId, id, nowSeconds() + 3600)
      .run();
    return {
      principal: { type: "user", id, email: `${id}@example.com` },
      credentialKind: "session",
      credentialId,
    } satisfies Actor;
  }
  const privateList = (actor: Actor, extra: Record<string, unknown> = {}) =>
    env.DOCUMENT_SEARCH.get(
      env.DOCUMENT_SEARCH.idFromName(
        `actor:${actor.principal.type}:${actor.principal.id}`,
      ),
    ).fetch("https://search.internal/list", {
      method: "POST",
      body: JSON.stringify({ actor, q: "", tz: "UTC", label: "", ...extra }),
    });
  return { mf, env, user, privateList };
}

it("runs the real app's capped-body search inside a SQLite Durable Object", async () => {
  const { mf, env, user } = await fixture();
  const actor = await user("bench");
  const doc = await createDocument(
    env,
    actor,
    "Title",
    new TextEncoder().encode("needle ".repeat(37449)),
    "private",
  );
  const timings: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const response = await mf.dispatchFetch(
      "https://app.example.com/v1/documents?q=needle",
      {
        headers: { Cookie: "__Host-slashdocs_session=bench" },
      },
    );
    const result = await response.json();
    timings.push(performance.now() - start);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-fixture-execution")).toBe("durable-object");
    expect(result).toMatchObject({
      items: [{ id: doc.id, snippet: expect.stringContaining("\x02needle\x03") }],
    });
  }
  console.info(
    JSON.stringify({
      benchmark: "app GET -> SQLite DocumentSearch, 262143-byte source, D1/R2",
      coldMs: timings[0],
      warmMs: timings.slice(1),
    }),
  );
  // Host elapsed time includes D1/IPC. Placement, not timing, establishes which
  // Cloudflare request budget applies. Local workerd does not meter Free CPU.
  expect(Math.max(...timings)).toBeLessThan(2000);
});

it("revalidates exact human and native service-account credentials across the binding", async () => {
  const { env, user, privateList } = await fixture();
  const actor = await user("reader"),
    other = await user("other");
  await createDocument(
    env,
    actor,
    "Private",
    new TextEncoder().encode("needle"),
    "private",
  );
  expect((await privateList(actor)).status).toBe(200);
  expect(await (await privateList(other)).json()).toEqual({ items: [] });
  expect(
    (await privateList({ ...actor, credentialId: other.credentialId })).status,
  ).toBe(401);
  await env.DB.prepare("UPDATE sessions SET expires_at=? WHERE token_hash=?")
    .bind(nowSeconds() - 1, actor.credentialId)
    .run();
  expect((await privateList(actor)).status).toBe(401);
  await env.DB.prepare(
    "INSERT INTO cli_credentials VALUES ('cli','cli-hash','reader','CLI','now',NULL,NULL)",
  ).run();
  const cli: Actor = { ...actor, credentialKind: "cli", credentialId: "cli" };
  expect((await privateList(cli)).status).toBe(200);
  await env.DB.prepare(
    "UPDATE cli_credentials SET revoked_at='now' WHERE id='cli'",
  ).run();
  expect((await privateList(cli)).status).toBe(401);
  await env.DB.prepare(
    "INSERT INTO users(id,provider,provider_subject,email,name,picture_url,created_at) VALUES ('sa','service_account','sa','','Robot','','now')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO service_accounts VALUES ('sa','Robot','reader','reader','now',NULL)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO service_account_keys VALUES ('key','sa','key-hash','Key','now',NULL,NULL)",
  ).run();
  const sa: Actor = {
    principal: { type: "service_account", id: "sa" },
    credentialKind: "service_account",
    credentialId: "key",
  };
  expect((await privateList(sa)).status).toBe(200);
  await env.DB.prepare(
    "UPDATE service_accounts SET disabled_at='now' WHERE id='sa'",
  ).run();
  expect((await privateList(sa)).status).toBe(401);
});

it("checks MCP expiry, resource, scope and human identity, and preserves Go errors", async () => {
  const { env, user, privateList } = await fixture();
  const actor: Actor = {
    ...(await user("reader")),
    credentialKind: "mcp",
    credentialId: "mcp-hash",
  };
  await env.DB.prepare("INSERT INTO mcp_tokens VALUES (?,?,?,?,?)")
    .bind(
      "mcp-hash",
      "reader",
      "https://app.example.com/mcp",
      "mcp",
      nowSeconds() + 3600,
    )
    .run();
  expect((await privateList(actor)).status).toBe(200);
  const long = await privateList(actor, { q: "é".repeat(257) });
  expect(long.status).toBe(400);
  expect(await long.json()).toEqual({
    error: { code: "bad_request", message: "invalid search query: query is too long" },
  });
  const label = await privateList(actor, { label: "test" });
  expect(label.status).toBe(404);
  expect(await label.json()).toMatchObject({ error: { code: "feature_disabled" } });
  for (const change of [
    "scope='other'",
    "resource='https://evil.example/mcp'",
    `expires_at=${nowSeconds() - 1}`,
    "user_id='other'",
  ]) {
    if (change === "user_id='other'") await user("other");
    await env.DB.prepare(
      `UPDATE mcp_tokens SET ${change} WHERE token_hash='mcp-hash'`,
    ).run();
    expect((await privateList(actor)).status).toBe(401);
    await env.DB.prepare(
      "UPDATE mcp_tokens SET scope='mcp',resource='https://app.example.com/mcp',expires_at=?,user_id='reader'",
    )
      .bind(nowSeconds() + 3600)
      .run();
  }
  await env.DB.prepare(
    "UPDATE users SET provider='service_account' WHERE id='reader'",
  ).run();
  expect((await privateList(actor)).status).toBe(401);
});

it("rejects public actor spoofing and private caller configuration, and bounds bodies", async () => {
  const { mf, env, user, privateList } = await fixture();
  const actor = await user("reader");
  expect(
    (
      await mf.dispatchFetch("https://app.example.com/v1/documents", {
        headers: {
          "X-Actor": JSON.stringify(actor),
          "X-Internal-Actor": JSON.stringify(actor),
        },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await mf.dispatchFetch("https://app.example.com/list", {
        method: "POST",
        body: JSON.stringify({ actor }),
      })
    ).status,
  ).toBe(404);
  expect(
    (await privateList(actor, { env: { GOOGLE_GROUPS_ENABLED: "false" } })).status,
  ).toBe(400);
  expect((await privateList({ ...actor, credentialId: undefined })).status).toBe(400);
  expect(
    (await privateList(actor, { actor: { ...actor, groupIDs: ["groups/fake"] } }))
      .status,
  ).toBe(400);
  const stub = env.DOCUMENT_SEARCH.get(env.DOCUMENT_SEARCH.idFromName("invalid"));
  expect(
    (
      await stub.fetch("https://search.internal/list", {
        method: "POST",
        body: "x".repeat(128 * 1024 + 1),
      })
    ).status,
  ).toBe(413);
  expect(
    (await stub.fetch("https://search.internal/list", { method: "POST", body: "{" }))
      .status,
  ).toBe(400);
  expect((await stub.fetch("https://search.internal/list")).status).toBe(405);
});

it("indexes current sources through private maintenance with unchanged batch results", async () => {
  const { env, user } = await fixture();
  const actor = await user("reader");
  const doc = await createDocument(
    env,
    actor,
    "Title",
    new TextEncoder().encode("needle"),
    "private",
  );
  await env.DB.prepare("UPDATE versions SET search_text=NULL WHERE id=?")
    .bind(doc.current_version_id)
    .run();
  const stub = env.DOCUMENT_SEARCH.get(env.DOCUMENT_SEARCH.idFromName("maintenance"));
  const response = await stub.fetch("https://search.internal/index", {
    method: "POST",
    body: JSON.stringify({ after: "" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ indexed: 1, failed: [] });
  expect(
    await env.DB.prepare("SELECT search_text FROM versions WHERE id=?")
      .bind(doc.current_version_id)
      .first(),
  ).toMatchObject({ search_text: "needle" });
  expect(
    (
      await stub.fetch("https://search.internal/index", {
        method: "POST",
        body: JSON.stringify({ after: "", env: {} }),
      })
    ).status,
  ).toBe(400);
  await env.DB.prepare("UPDATE versions SET search_text=NULL WHERE id=?")
    .bind(doc.current_version_id)
    .run();
  await env.DB.prepare(
    "CREATE TRIGGER fail_source BEFORE UPDATE OF search_text ON versions BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  ).run();
  const failed = await stub.fetch("https://search.internal/index", {
    method: "POST",
    body: JSON.stringify({ after: "" }),
  });
  expect(failed.status).toBe(200);
  expect(await failed.json()).toEqual({ indexed: 0, failed: [doc.current_version_id] });
});

it("reloads group snapshots and permissions for each request using the bound environment", async () => {
  const { env, user, privateList } = await fixture({
    GOOGLE_GROUPS_ENABLED: "true",
    GOOGLE_GROUPS_CUSTOMER_ID: "Ctest",
    GOOGLE_GROUPS_ACCESS_TOKEN: "fixture-only",
  });
  const owner = await user("owner"),
    reader = await user("reader"),
    other = await user("other");
  const doc = await createDocument(
    env,
    owner,
    "Title",
    new TextEncoder().encode("needle"),
    "private",
  );
  await env.DB.prepare(
    "INSERT INTO google_groups VALUES ('groups/team','Ctest','team@example.com','Team',?)",
  )
    .bind(Date.now())
    .run();
  for (const actor of [reader, other])
    await env.DB.prepare(
      "INSERT INTO google_group_membership_snapshots VALUES (?,'Ctest',?,?, '')",
    )
      .bind(actor.principal.id, Date.now(), Date.now())
      .run();
  await env.DB.prepare(
    "INSERT INTO google_group_memberships VALUES ('reader','groups/team')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO document_grants VALUES ('group-grant',?,'google_group','groups/team','viewer','owner')",
  )
    .bind(doc.id)
    .run();
  expect(await (await privateList(reader, { q: "needle" })).json()).toMatchObject({
    items: [{ id: doc.id }],
  });
  expect(await (await privateList(other, { q: "needle" })).json()).toEqual({
    items: [],
  });
  // A cached actor/DO must not retain group access after the DB changes.
  await env.DB.prepare("UPDATE google_groups SET customer_id='Cother'").run();
  expect(await (await privateList(reader, { q: "needle" })).json()).toEqual({
    items: [],
  });
  await env.DB.prepare(
    "UPDATE google_group_membership_snapshots SET customer_id='Cother' WHERE user_id='reader'",
  ).run();
  const stale = await privateList(reader, { q: "needle" });
  expect(stale.status).toBe(503);
  expect(await stale.json()).toMatchObject({
    error: { code: "group_membership_unavailable" },
  });
});

it("returns resource failures as 500 instead of hiding search", async () => {
  const { env, user, privateList } = await fixture();
  const actor = await user("reader");
  await env.DB.prepare("DROP TABLE sessions").run();
  const response = await privateList(actor);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: { code: "internal", message: "Request failed" },
  });
});
