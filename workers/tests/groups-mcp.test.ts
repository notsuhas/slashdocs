import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import type { Env } from "../app/src/env";
import { loadMigrationStatements } from "../scripts/read-migrations";
import { seedUser } from "./runtime";
import { hashToken, nowSeconds } from "../app/src/auth/tokens";
let runtime: Miniflare | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});
it("refreshes the canonical MCP HTTP actor and rejects expired/revoked memberships", async () => {
  const bundled = await build({
    entryPoints: ["workers/app/src/index.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
    write: false,
  });
  runtime = new Miniflare({
    workers: [
      {
        name: "app",
        modules: true,
        script: bundled.outputFiles[0].text,
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { DB: "groups-mcp" },
        r2Buckets: { DOCUMENTS: "groups-mcp" },
        durableObjects: {
          DOCUMENT_REALTIME: { className: "DocumentRealtime", useSQLite: true },
        },
        serviceBindings: { ASSETS: "directory", GOOGLE_GROUPS_FETCHER: "directory" },
        bindings: {
          APP_ORIGIN: "https://app.example.com",
          RENDER_ORIGIN: "https://render.example.com",
          SESSION_SECRET: "groups-test-secret-only-32characters",
          RENDER_PRIVATE_KEY: "",
          RENDER_PUBLIC_KEY: "",
          GOOGLE_GROUPS_ENABLED: "true",
          GOOGLE_GROUPS_CUSTOMER_ID: "Ctest",
          GOOGLE_GROUPS_ACCESS_TOKEN: "test-secret",
          ALLOWED_DOMAINS: "example.com",
        },
      },
      {
        name: "directory",
        modules: true,
        compatibilityDate: "2026-07-30",
        script: `let revoked=false,calls=0;export default {async fetch(request){const url=new URL(request.url);if(url.pathname==='/__fixture'){revoked=true;return Response.json({calls});}calls++;return Response.json({memberships:revoked?[]:[{group:'groups/immutable',groupKey:{id:'team@example.com'},displayName:'Team',labels:{'cloudidentity.googleapis.com/groups.discussion_forum':''}}]});}}`,
      },
    ],
  });
  const env = await runtime.getBindings<Env>("app");
  for (const statement of await loadMigrationStatements())
    await env.DB.prepare(statement).run();
  await seedUser(env, "owner", "owner@example.com");
  await seedUser(env, "member", "member@example.com");
  await env.DB.prepare(
    "INSERT INTO documents(id,title,owner_user_id,updated_at) VALUES ('doc','Group private','owner',?)",
  )
    .bind(new Date().toISOString())
    .run();
  await env.DB.prepare(
    "INSERT INTO google_groups VALUES ('groups/immutable','Ctest','team@example.com','Team',?)",
  )
    .bind(Date.now())
    .run();
  await env.DB.prepare(
    "INSERT INTO document_grants VALUES ('group-grant','doc','google_group','groups/immutable','viewer','owner')",
  ).run();
  await env.DB.prepare("INSERT INTO mcp_tokens VALUES (?,?,?,?,?)")
    .bind(
      await hashToken("slashdocs_mcp_groupfixture"),
      "member",
      "https://app.example.com/mcp",
      "mcp",
      nowSeconds() + 3600,
    )
    .run();
  const worker = await runtime.getWorker("app");
  const call = async () => {
    const response = await worker.fetch("https://app.example.com/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer slashdocs_mcp_groupfixture",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_document", arguments: { document_id: "doc" } },
      }),
    });
    expect(response.status).toBe(200);
    return z
      .object({
        result: z.object({
          isError: z.boolean().optional(),
          content: z.array(z.object({ text: z.string() })),
        }),
      })
      .parse(await response.json());
  };
  const allowed = await call();
  expect(allowed.result.isError).not.toBe(true);
  expect(allowed.result.content[0].text).toContain("Group private");
  const snapshot = await env.DB.prepare(
    "SELECT last_success_at FROM google_group_membership_snapshots WHERE user_id='member'",
  ).first<{ last_success_at: number }>();
  expect(snapshot?.last_success_at).toBeGreaterThan(0);
  const directory = await runtime.getWorker("directory");
  const control = await directory.fetch("https://fixture.test/__fixture");
  expect(z.object({ calls: z.number() }).parse(await control.json()).calls).toBe(1);
  await env.DB.prepare(
    "UPDATE google_group_membership_snapshots SET last_success_at=? WHERE user_id='member'",
  )
    .bind(Date.now() - 61000)
    .run();
  const denied = await call();
  expect(denied.result.isError).toBe(true);
  expect(denied.result.content[0].text).toContain("viewer role required");
  expect(
    (
      await env.DB.prepare(
        "SELECT * FROM google_group_memberships WHERE user_id='member'",
      ).all()
    ).results,
  ).toHaveLength(0);
});
