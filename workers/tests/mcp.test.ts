import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { hashToken, nowSeconds } from "../app/src/auth/tokens";
import { tools } from "../app/src/mcp/tools";
import { redirectMatches, validRedirect } from "../app/src/mcp/oauth";
import { seedUser } from "./runtime";
import { createMCPRuntime } from "./mcp-runtime";
let runtime: Awaited<ReturnType<typeof createMCPRuntime>>;
const origin = "https://app.example.com",
  cli = "slashdocs_cli_mcpfixture",
  session = "mcp-session-fixture";
const resultSchema = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }),
});
const request = (path: string, init: RequestInit = {}) =>
  runtime.fetch(origin + path, init);
const auth = { Authorization: `Bearer ${cli}` };
const sessionHeaders = { Cookie: `__Host-slashdocs_session=${session}` };
const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const rpc = (method: string, params: unknown = {}, token = "slashdocs_mcp_fixture") =>
  request("/mcp", {
    ...json({ jsonrpc: "2.0", id: 1, method, params }),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
  });
async function tool(name: string, args: Record<string, unknown> = {}, token?: string) {
  const response = await rpc("tools/call", { name, arguments: args }, token);
  expect(response.status).toBe(200);
  const result = resultSchema.parse(await response.json()).result;
  return result;
}
async function value(name: string, args: Record<string, unknown> = {}, token?: string) {
  const result = await tool(name, args, token);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return JSON.parse(result.content[0].text);
}
beforeEach(async () => {
  runtime = await createMCPRuntime();
  await seedUser(runtime.env, "usr_mcp", "mcp@example.com");
  await seedUser(runtime.env, "usr_other", "other@example.com");
  await runtime.env.DB.prepare(
    "INSERT INTO cli_credentials(id,token_hash,user_id,name,created_at) VALUES (?,?,?,?,?)",
  )
    .bind(
      "cli_mcp",
      await hashToken(cli),
      "usr_mcp",
      "fixture",
      new Date().toISOString(),
    )
    .run();
  await runtime.env.DB.prepare(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)",
  )
    .bind(await hashToken(session), "usr_mcp", nowSeconds() + 3600)
    .run();
  await runtime.env.DB.prepare("INSERT INTO mcp_tokens VALUES (?,?,?,?,?)")
    .bind(
      await hashToken("slashdocs_mcp_fixture"),
      "usr_mcp",
      origin + "/mcp",
      "mcp",
      nowSeconds() + 3600,
    )
    .run();
});
afterEach(async () => {
  await runtime.dispose();
});
async function register(redirect = "https://client.example/callback") {
  const response = await request(
    "/oauth/register",
    json({
      client_name: "<script>client</script>",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
    }),
  );
  expect(response.status).toBe(201);
  return z.object({ client_id: z.string() }).parse(await response.json()).client_id;
}
async function consent(client: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    client_id: client,
    redirect_uri: "https://client.example/callback",
    response_type: "code",
    code_challenge: await hashToken("v".repeat(43)),
    code_challenge_method: "S256",
    resource: origin + "/mcp",
    state: "state-bound",
    ...extra,
  });
  const response = await request("/oauth/authorize?" + params, {
    headers: sessionHeaders,
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).not.toContain("<script>client</script>");
  expect(html).toContain("&lt;script&gt;client&lt;/script&gt;");
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1];
  expect(nonce).toBeTruthy();
  params.set("nonce", nonce || "");
  params.set("scope", "mcp");
  params.set("decision", "approve");
  return params;
}
async function approve(params: URLSearchParams, requestOrigin = origin) {
  return request("/oauth/authorize", {
    method: "POST",
    headers: {
      ...sessionHeaders,
      Origin: requestOrigin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
}
async function exchange(
  code: string,
  client: string,
  extra: Record<string, string> = {},
) {
  return request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: "v".repeat(43),
      client_id: client,
      redirect_uri: "https://client.example/callback",
      resource: origin + "/mcp",
      ...extra,
    }).toString(),
  });
}
describe("MCP OAuth with real D1", () => {
  it("starts browser login before MCP consent while API and POST requests stay unauthorized", async () => {
    const client = await register();
    const path =
      "/oauth/authorize?" +
      new URLSearchParams({
        client_id: client,
        redirect_uri: "https://client.example/callback",
        response_type: "code",
        code_challenge: await hashToken("v".repeat(43)),
        code_challenge_method: "S256",
        resource: origin + "/mcp",
        state: "resume-consent",
      });
    for (const cookie of [undefined, "__Host-slashdocs_session=expired"]) {
      const response = await request(path, {
        headers: { Accept: "text/html", ...(cookie ? { Cookie: cookie } : {}) },
      });
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location") || "", origin);
      expect(location.pathname).toBe("/v1/auth/google/start");
      expect(location.searchParams.get("mode")).toBe("web");
      expect(location.searchParams.get("redirect")).toBe(path);
      const login = await request(location.pathname + location.search);
      expect(login.status).toBe(302);
      const provider = new URL(login.headers.get("Location") || "");
      expect(provider.hostname).toBe("accounts.google.com");
      const stored = await runtime.env.DB.prepare(
        "SELECT mode,redirect FROM oauth_states WHERE state_hash=?",
      )
        .bind(await hashToken(provider.searchParams.get("state") || ""))
        .first<{ mode: string; redirect: string }>();
      expect(stored).toEqual({ mode: "web", redirect: path });
    }
    for (const accept of ["application/json", "text/html, application/json", "*/*"]) {
      const response = await request(path, { headers: { Accept: accept } });
      expect(response.status).toBe(401);
      expect(response.headers.get("Location")).toBeNull();
    }
    const post = await request("/oauth/authorize", {
      method: "POST",
      headers: { Accept: "text/html", Origin: origin },
    });
    expect(post.status).toBe(401);
    expect(post.headers.get("Location")).toBeNull();
    const authorized = await request(path, {
      headers: { ...sessionHeaders, Accept: "text/html" },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.text()).toContain('name="nonce"');
  });
  it("advertises authcode only, registers, consents, exchanges once, and separates REST credentials", async () => {
    const metadata = await request("/.well-known/oauth-authorization-server");
    expect(await metadata.json()).toMatchObject({
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
    });
    const client = await register();
    const params = await consent(client);
    const approval = await approve(params);
    expect(approval.status, await approval.clone().text()).toBe(302);
    const redirect = new URL(approval.headers.get("Location") || "");
    expect(redirect.searchParams.get("state")).toBe("state-bound");
    const code = redirect.searchParams.get("code") || "";
    const response = await exchange(code, client);
    expect(response.status).toBe(200);
    const payload = z
      .object({
        access_token: z.string(),
        scope: z.literal("mcp"),
        expires_in: z.literal(3600),
      })
      .parse(await response.json());
    expect(payload.access_token).toMatch(/^slashdocs_mcp_/);
    expect((await exchange(code, client)).status).toBe(400);
    expect((await rpc("ping", {}, payload.access_token)).status).toBe(200);
    expect(
      (
        await request("/v1/documents", {
          headers: { Authorization: `Bearer ${payload.access_token}` },
        })
      ).status,
    ).toBe(401);
    expect((await approve(params)).status).toBe(403);
    const row = await runtime.env.DB.prepare(
      "SELECT * FROM mcp_tokens WHERE token_hash=?",
    )
      .bind(await hashToken(payload.access_token))
      .first();
    expect(row).toMatchObject({
      user_id: "usr_mcp",
      resource: origin + "/mcp",
      scope: "mcp",
    });
  });
  it("rejects hostile redirects, origins, consent mutation and nonce replay without redirecting", async () => {
    for (const redirect of [
      "https://user:pass@client.example/cb",
      "https://client.example/cb#fragment",
      "http://remote.example/cb",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///tmp/cb",
    ]) {
      const response = await request(
        "/oauth/register",
        json({ redirect_uris: [redirect] }),
      );
      expect(response.status, redirect).toBe(400);
    }
    const client = await register();
    const params = await consent(client);
    expect((await approve(params, "https://evil.example")).status).toBe(403);
    const bad = new URLSearchParams(params);
    bad.set("redirect_uri", "https://evil.example/cb");
    const response = await approve(bad);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    const changed = new URLSearchParams(params);
    changed.set("state", "mutated");
    expect((await approve(changed)).status).toBe(403);
    expect((await approve(params)).status).toBe(403);
  });
  it("burns codes on mismatched PKCE, resource, client and redirect, and rejects expiry", async () => {
    const mutations: Record<string, string>[] = [
      { code_verifier: "x".repeat(43) },
      { resource: origin + "/wrong" },
      { redirect_uri: "https://client.example/other" },
      { client_id: await register() },
    ];
    for (const extra of mutations) {
      const client = await register();
      const response = await approve(await consent(client));
      const code =
        new URL(response.headers.get("Location") || "").searchParams.get("code") || "";
      expect((await exchange(code, client, extra)).status).toBe(400);
      expect((await exchange(code, client)).status).toBe(400);
    }
    const client = await register();
    const response = await approve(await consent(client));
    const code =
      new URL(response.headers.get("Location") || "").searchParams.get("code") || "";
    await runtime.env.DB.prepare("UPDATE mcp_codes SET expires_at=0").run();
    expect((await exchange(code, client)).status).toBe(400);
    expect(
      (
        await request("/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "grant_type=refresh_token",
        })
      ).status,
    ).toBe(400);
  });
  it("enforces metadata/body bounds, scope, consent user binding, and parallel code consumption", async () => {
    for (const metadata of [
      { client_name: "x".repeat(129), redirect_uris: ["https://client.example/cb"] },
      { redirect_uris: Array.from({ length: 11 }, () => "https://client.example/cb") },
      { redirect_uris: ["https://client.example/" + "x".repeat(1024)] },
      {
        redirect_uris: Array.from(
          { length: 4 },
          (_, i) => "https://client.example/" + i + "x".repeat(700),
        ),
      },
    ])
      expect((await request("/oauth/register", json(metadata))).status).toBe(400);
    expect(
      (
        await request("/oauth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: " ".repeat(65537),
        })
      ).status,
    ).toBe(400);
    const client = await register();
    const invalidAuthorization: Record<string, string>[] = [
      { scope: "cli" },
      { resource: origin + "/other" },
      { code_challenge_method: "plain" },
      { code_challenge: "short" },
      { response_type: "token" },
    ];
    for (const extra of invalidAuthorization) {
      const params = new URLSearchParams({
        client_id: client,
        redirect_uri: "https://client.example/callback",
        response_type: "code",
        code_challenge: await hashToken("v".repeat(43)),
        code_challenge_method: "S256",
        resource: origin + "/mcp",
        ...extra,
      });
      const response = await request("/oauth/authorize?" + params, {
        headers: sessionHeaders,
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("Location")).toBeNull();
    }
    const params = await consent(client);
    await runtime.env.DB.prepare("INSERT INTO sessions VALUES (?,?,?)")
      .bind(await hashToken("other-session"), "usr_other", nowSeconds() + 3600)
      .run();
    const stolen = await request("/oauth/authorize", {
      method: "POST",
      headers: {
        Cookie: "__Host-slashdocs_session=other-session",
        Origin: origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    expect(stolen.status).toBe(403);
    const approved = await approve(await consent(client));
    const code =
      new URL(approved.headers.get("Location") || "").searchParams.get("code") || "";
    const responses = await Promise.all([
      exchange(code, client),
      exchange(code, client),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    const cancelled = await consent(client);
    cancelled.set("decision", "deny");
    const deny = await approve(cancelled);
    expect(new URL(deny.headers.get("Location") || "").searchParams.get("error")).toBe(
      "access_denied",
    );
    expect(
      (
        await approve(
          new URLSearchParams({
            ...Object.fromEntries(await consent(client)),
            nonce: "bogus",
          }),
        )
      ).status,
    ).toBe(403);
  });
  it("permits loopback ephemeral ports and private-use schemes but exact HTTPS registration", () => {
    expect(validRedirect("cursor://callback/oauth")).toBe(true);
    expect(validRedirect("http://[::1]:3333/cb")).toBe(true);
    expect(
      redirectMatches(["http://127.0.0.1:1234/cb"], "http://127.0.0.1:5678/cb"),
    ).toBe(true);
    expect(
      redirectMatches(["http://localhost:1234/cb"], "http://localhost:5678/cb"),
    ).toBe(false);
    expect(
      redirectMatches(["https://client.example/cb"], "https://client.example:8443/cb"),
    ).toBe(false);
  });
});
describe("MCP transport", () => {
  it("lists the exact 49 upstream schemas and supports init, ping, notifications, and JSON-RPC errors", async () => {
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    });
    expect(await initialized.json()).toMatchObject({
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "slashdocs" },
        capabilities: { tools: { listChanged: false } },
      },
    });
    const listed = await rpc("tools/list");
    expect(await listed.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools } });
    expect(tools).toHaveLength(49);
    expect(await (await rpc("ping")).json()).toMatchObject({ result: {} });
    expect(await (await rpc("missing")).json()).toMatchObject({
      error: { code: -32601 },
    });
    expect(await (await rpc("tools/call", { name: "missing" })).json()).toMatchObject({
      error: { code: -32602 },
    });
    const notification = await request("/mcp", {
      ...json({ jsonrpc: "2.0", method: "notifications/initialized" }),
      headers: {
        Authorization: "Bearer slashdocs_mcp_fixture",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
    });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
  });
  it("bounds transport payloads and rejects malformed request and argument envelopes", async () => {
    await runtime.dispose();
    runtime = await createMCPRuntime({ MAX_HTML_BYTES: "1" });
    await seedUser(runtime.env, "usr_mcp", "mcp@example.com");
    await runtime.env.DB.prepare("INSERT INTO mcp_tokens VALUES (?,?,?,?,?)")
      .bind(
        await hashToken("slashdocs_mcp_fixture"),
        "usr_mcp",
        origin + "/mcp",
        "mcp",
        nowSeconds() + 3600,
      )
      .run();
    const headers = {
      Authorization: "Bearer slashdocs_mcp_fixture",
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    expect(
      (
        await request("/mcp", {
          method: "POST",
          headers,
          body: " ".repeat(1024 * 1024 + 7),
        })
      ).status,
    ).toBe(413);
    for (const body of [
      { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: { bad: true }, method: "ping" },
    ])
      expect(
        await (await request("/mcp", { ...json(body), headers })).json(),
      ).toMatchObject({ error: { code: -32600 } });
    expect(
      await (await rpc("tools/call", { name: "whoami", arguments: [] })).json(),
    ).toMatchObject({ error: { code: -32602 } });
    expect((await request("/mcp", { method: "GET", headers })).status).toBe(405);
    expect((await request("/mcp", { method: "PUT", headers })).status).toBe(404);
    expect(
      (
        await request("/mcp", {
          ...json({ jsonrpc: "2.0", id: 1, method: "ping" }),
          headers: { ...headers, Authorization: "bearer   slashdocs_mcp_fixture  " },
        })
      ).status,
    ).toBe(200);
  });
  it("rejects CLI, cookies, expired or wrongly scoped MCP tokens, transport origin and headers", async () => {
    expect((await rpc("ping", {}, cli)).status).toBe(401);
    const cookie = await request("/mcp", {
      ...json({ jsonrpc: "2.0", id: 1, method: "ping" }),
      headers: {
        ...sessionHeaders,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
    });
    expect(cookie.status).toBe(401);
    expect(cookie.headers.get("WWW-Authenticate")).toContain(
      "oauth-protected-resource/mcp",
    );
    for (const update of [
      "expires_at=0",
      "resource='https://other.example/mcp'",
      "scope='cli'",
    ]) {
      await runtime.env.DB.prepare(`UPDATE mcp_tokens SET ${update}`).run();
      expect((await rpc("ping")).status).toBe(401);
      await runtime.env.DB.prepare(
        "UPDATE mcp_tokens SET expires_at=?,resource=?,scope='mcp'",
      )
        .bind(nowSeconds() + 3600, origin + "/mcp")
        .run();
    }
    const badHeaders: Record<string, string>[] = [
      { Origin: "https://evil.example" },
      { Accept: "application/json" },
      { "Mcp-Protocol-Version": "1900-01-01" },
      { "Content-Type": "text/plain" },
    ];
    for (const headers of badHeaders) {
      const response = await request("/mcp", {
        ...json({ jsonrpc: "2.0", id: 1, method: "ping" }),
        headers: {
          Authorization: "Bearer slashdocs_mcp_fixture",
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...headers,
        },
      });
      expect(response.status).toBe(headers.Origin ? 403 : 400);
    }
    expect(
      (
        await request("/mcp", {
          ...json({ jsonrpc: "2.0", id: 1, method: "ping" }),
          headers: {
            Authorization: "Bearer slashdocs_mcp_fixture",
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            Origin: "https://APP.EXAMPLE.COM:443",
          },
        })
      ).status,
    ).toBe(200);
    const malformed = await request("/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer slashdocs_mcp_fixture",
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: "bad JSON",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: -32700 } });
  });
});
describe("49 tools delegated to canonical HTTP handlers", () => {
  it("runs document, version, comment, folder and grant tools with real D1 and R2", async () => {
    const seen = new Set<string>();
    const run = async (name: string, args: Record<string, unknown> = {}) => {
      seen.add(name);
      return value(name, args);
    };
    await run("whoami");
    await run("get_server_config");
    expect(
      (await tool("get_authoring_guidelines", { section: "core" })).content[0].text,
    ).toContain("ONE HTML file");
    seen.add("get_authoring_guidelines");
    const doc = z.object({ id: z.string(), current_version_id: z.string() }).parse(
      await run("create_document", {
        title: "MCP doc",
        html: "<!doctype html><p>Review this text</p>",
      }),
    );
    const d = { document_id: doc.id },
      v = { ...d, version_id: doc.current_version_id };
    await run("list_documents", { query: "MCP" });
    await run("get_document", d);
    await run("rename_document", { ...d, title: "Renamed" });
    await run("list_document_versions", d);
    await run("get_document_version", v);
    expect((await tool("get_document_html", d)).content[0].text).toContain(
      "Review this text",
    );
    seen.add("get_document_html");
    const comment = z.object({ id: z.string() }).parse(
      await run("create_comment", {
        ...v,
        body: "Check it",
        quote: "Review this text",
      }),
    );
    const c = { ...d, comment_id: comment.id };
    await run("list_comments", d);
    await run("reply_comment", { ...c, body: "Reply" });
    await run("update_comment", { ...c, body: "Updated" });
    await run("resolve_comment", c);
    await run("reopen_comment", c);
    await run("react_comment", { ...c, emoji: "+1" });
    await run("unreact_comment", { ...c, emoji: "+1" });
    await run("delete_comment", c);
    const grant = z
      .object({ id: z.string() })
      .parse(await run("share_document", { ...d, everyone: true }));
    await run("list_document_access", d);
    await run("update_document_grant", { ...d, grant_id: grant.id, role: "commenter" });
    await run("revoke_document_grant", { ...d, grant_id: grant.id });
    await run("update_document", {
      ...d,
      base_version_id: doc.current_version_id,
      html: "<!doctype html><p>Updated</p>",
      change_summary: "Update",
    });
    const conflict = await tool("update_document", {
      ...d,
      base_version_id: doc.current_version_id,
      html: "<p>Conflict</p>",
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.structuredContent).toMatchObject({
      error: { code: "version_conflict" },
    });
    const folder = z
      .object({ id: z.string() })
      .parse(await run("create_folder", { title: "MCP Folder" }));
    const f = { folder_id: folder.id };
    await run("list_folders");
    await run("search_folders", { query: "MCP" });
    await run("get_folder", f);
    await run("rename_folder", { ...f, title: "Renamed Folder" });
    await run("move_folder", f);
    await run("move_document_to_folder", { ...d, ...f });
    await run("list_folder_documents", f);
    await run("move_document_to_root", { ...d, ...f });
    await run("move_document", { ...d, ...f });
    await run("move_document", { ...d, to_root: true });
    const fg = z
      .object({ id: z.string() })
      .parse(await run("share_folder", { ...f, everyone: true }));
    await run("list_folder_access", f);
    await run("update_folder_grant", { ...f, grant_id: fg.id, role: "editor" });
    await run("revoke_folder_grant", { ...f, grant_id: fg.id });
    await run("delete_folder", f);
    await run("delete_document", d);
    expect([...seen].sort()).toEqual(
      tools
        .filter(
          (t) =>
            !t.name.includes("service_account") && t.name !== "request_document_access",
        )
        .map((t) => t.name)
        .sort(),
    );
  });
  it("runs service account tools, accepts native and legacy SA keys and rejects disabled/revoked keys", async () => {
    const response = await request("/v1/service-accounts", {
      ...json({ label: "mcpbot" }),
      headers: { ...auth, "Content-Type": "application/json" },
    });
    expect(response.status).toBe(201);
    const sa = z
      .object({ id: z.string(), key: z.object({ id: z.string(), token: z.string() }) })
      .parse(await response.json());
    const s = { service_account_id: sa.id };
    await value("list_service_accounts");
    await value("update_service_account", { ...s, name: "updated@mcp.bot" });
    await value("list_service_account_keys", s);
    expect((await rpc("ping", {}, sa.key.token)).status).toBe(200);
    expect(
      (
        await request("/oauth/authorize", {
          headers: { Authorization: `Bearer ${sa.key.token}` },
        })
      ).status,
    ).toBe(403);
    expect((await value("whoami", {}, sa.key.token)).principal.type).toBe(
      "service_account",
    );
    const transfer = z.object({ id: z.string() }).parse(
      await value("create_service_account_transfer", {
        ...s,
        to_user_email: "other@example.com",
      }),
    );
    await value("list_service_account_transfers");
    await runtime.env.DB.prepare("INSERT INTO mcp_tokens VALUES (?,?,?,?,?)")
      .bind(
        await hashToken("slashdocs_mcp_other"),
        "usr_other",
        origin + "/mcp",
        "mcp",
        nowSeconds() + 3600,
      )
      .run();
    await value(
      "decline_service_account_transfer",
      { transfer_id: transfer.id },
      "slashdocs_mcp_other",
    );
    const next = z.object({ id: z.string() }).parse(
      await value("create_service_account_transfer", {
        ...s,
        to_user_email: "other@example.com",
      }),
    );
    await value(
      "accept_service_account_transfer",
      { transfer_id: next.id },
      "slashdocs_mcp_other",
    );
    await value(
      "revoke_service_account_key",
      { ...s, key_id: sa.key.id },
      "slashdocs_mcp_other",
    );
    expect((await rpc("ping", {}, sa.key.token)).status).toBe(401);
    const legacy = "aidocs_sa_legacyfixture";
    await runtime.env.DB.prepare(
      "INSERT INTO service_account_keys(id,service_account_id,name,token_hash,created_at) VALUES (?,?,?,?,?)",
    )
      .bind(
        "sak_legacy",
        sa.id,
        "legacy",
        await hashToken(legacy),
        new Date().toISOString(),
      )
      .run();
    expect((await rpc("ping", {}, legacy)).status).toBe(200);
    await value(
      "update_service_account",
      { ...s, disabled: true },
      "slashdocs_mcp_other",
    );
    expect((await rpc("ping", {}, legacy)).status).toBe(401);
  });
  it("requests access as a different user and preserves tool-level validation errors", async () => {
    await runtime.dispose();
    runtime = await createMCPRuntime({
      SLASHDOCS_SLACK_BOT_TOKEN: "test-only-mcp-notification-token",
    });
    await seedUser(runtime.env, "usr_mcp", "mcp@example.com");
    await seedUser(runtime.env, "usr_other", "other@example.com");
    await runtime.env.DB.prepare("INSERT INTO mcp_tokens VALUES (?,?,?,?,?)")
      .bind(
        await hashToken("slashdocs_mcp_fixture"),
        "usr_mcp",
        origin + "/mcp",
        "mcp",
        nowSeconds() + 3600,
      )
      .run();
    const doc = z
      .object({ id: z.string() })
      .parse(
        await value("create_document", { title: "Private", html: "<p>Private</p>" }),
      );
    await runtime.env.DB.prepare("INSERT INTO mcp_tokens VALUES (?,?,?,?,?)")
      .bind(
        await hashToken("slashdocs_mcp_other"),
        "usr_other",
        origin + "/mcp",
        "mcp",
        nowSeconds() + 3600,
      )
      .run();
    await value(
      "request_document_access",
      { document_id: doc.id },
      "slashdocs_mcp_other",
    );
    await value(
      "request_document_access",
      { document_id: doc.id },
      "slashdocs_mcp_other",
    );
    expect(
      await runtime.env.DB.prepare(
        "SELECT document_id,requester_id FROM document_access_requests WHERE document_id=?",
      )
        .bind(doc.id)
        .first(),
    ).toMatchObject({ document_id: doc.id, requester_id: "usr_other" });
    expect(
      await runtime.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM document_access_request_notification_outbox WHERE document_id=? AND recipient_id=?",
      )
        .bind(doc.id, "usr_mcp")
        .first(),
    ).toMatchObject({ count: 1 });

    for (const [name, args] of [
      ["create_document", {}],
      ["share_document", { document_id: doc.id }],
      ["move_document", { document_id: doc.id }],
      ["update_comment", { document_id: doc.id, comment_id: "cmt_missing" }],
      ["update_service_account", { service_account_id: "sa_missing" }],
    ] as const) {
      expect((await tool(name, args)).isError).toBe(true);
    }
  });
});
