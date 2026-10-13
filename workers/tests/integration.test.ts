import { afterEach, describe, it, expect } from "vitest";
import { app } from "../app/src/index";
import { createTestEnv, seedUser } from "./runtime";
import { createMCPRuntime } from "./mcp-runtime";
import { hashToken } from "../app/src/auth/tokens";
import { createDocument } from "../app/src/services/documents";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
describe("integrated app boundaries", () => {
  it("serves public login assets and rejects private API access", async () => {
    const fixture = await createTestEnv();
    cleanups.push(fixture.dispose);
    fixture.env.ASSETS = {
      fetch: async () =>
        new Response("<!doctype html><p>Login</p>", {
          headers: { "Content-Type": "text/html" },
        }),
    };
    const page = await app.request("/login", {}, fixture.env);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const api = await app.request("/v1/documents", {}, fixture.env);
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ error: { code: "unauthorized" } });
  });
  it("hydrates bridge state without exposing private source or credentials", async () => {
    const fixture = await createMCPRuntime();
    const request = (path: string, init: RequestInit = {}) =>
      fixture.fetch(`https://app.example.com${path}`, init);
    cleanups.push(fixture.dispose);
    const user = await seedUser(fixture.env);
    const token = "slashdocs_cli_fixturevalidtoken";
    await fixture.env.DB.prepare(
      "INSERT INTO cli_credentials(id,token_hash,user_id,name,created_at) VALUES(?,?,?,?,?)",
    )
      .bind(
        "cred_fixture",
        await hashToken(token),
        user.id,
        "Fixture",
        new Date().toISOString(),
      )
      .run();
    const doc = await createDocument(
      fixture.env,
      { principal: user, credentialKind: "cli" },
      "Fixture",
      new TextEncoder().encode("<script>globalThis.privateSource=true</script>"),
      "private",
    );
    const headers = { Authorization: `Bearer ${token}` };
    const snapshot = await request(`/v1/documents/${doc.id}/kv`, { headers });
    expect(await snapshot.json()).toEqual({ revision: 0, items: {} });
    const source = await request(
      `/v1/documents/${doc.id}/versions/${doc.current_version_id}/html`,
      { headers },
    );
    expect(source.status).toBe(200);
    expect(source.headers.get("content-disposition")).toContain("attachment");
    expect(source.headers.get("content-security-policy")).toContain(
      "sandbox; default-src 'none'",
    );
    const updated = await request(`/v1/documents/${doc.id}/kv`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ set: { key: "value" } }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ revision: 1 });
    const persisted = await request(`/v1/documents/${doc.id}/kv`, { headers });
    expect(await persisted.json()).toEqual({ revision: 1, items: { key: "value" } });
    const noAuth = await request(`/v1/documents/${doc.id}/kv`);
    expect(noAuth.status).toBe(401);
  });
});
