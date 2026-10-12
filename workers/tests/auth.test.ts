import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { authRoutes } from "../app/src/routes/auth";
import { configRoutes } from "../app/src/routes/config";
import { hashToken, nowSeconds } from "../app/src/auth/tokens";
import { ApiError } from "../shared/errors";
import { createTestEnv, seedUser } from "./runtime";
import type { AppEnv } from "../app/src/env";
let runtime: Awaited<ReturnType<typeof createTestEnv>>;
const app = new Hono<AppEnv>();
app.route("/", authRoutes).route("/", configRoutes);
app.onError((error, c) =>
  c.json(
    { error: { code: error instanceof ApiError ? error.code : "internal" } },
    (error instanceof ApiError ? error.status : 500) as 400,
  ),
);
const request = (path: string, init?: RequestInit) =>
  app.request(`https://app.example.com${path}`, init, runtime.env);
async function cliCode(code: string, verifier: string) {
  await runtime.env.DB.prepare(
    "INSERT INTO cli_codes (code_hash,user_id,code_challenge,expires_at) VALUES (?,?,?,?)",
  )
    .bind(
      await hashToken(code),
      "usr_test",
      await hashToken(verifier),
      nowSeconds() + 120,
    )
    .run();
}
async function exchange(code: string, verifier: string) {
  return request("/v1/auth/cli/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, name: "test" }),
  });
}
beforeEach(async () => {
  runtime = await createTestEnv();
  await seedUser(runtime.env);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await runtime?.dispose();
});
describe("authentication with D1", () => {
  it("prevents caching authentication and config responses", async () => {
    expect((await request("/v1/me")).headers.get("Cache-Control")).toBe("no-store");
    expect((await request("/v1/config")).headers.get("Cache-Control")).toBe("no-store");
  });
  it("supports host-only local HTTP cookies and refuses unconfigured login policy", async () => {
    runtime.env.APP_ORIGIN = "http://localhost:8787";
    runtime.env.GOOGLE_CLIENT_ID = "test-client";
    runtime.env.GOOGLE_CLIENT_SECRET = "test-only-secret";
    const start = await request("/v1/auth/google/start");
    expect(start.status).toBe(302);
    expect(start.headers.get("Set-Cookie")).toContain("slashdocs_oauth_state_");
    expect(start.headers.get("Set-Cookie")).not.toContain("__Host-");
    expect(start.headers.get("Set-Cookie")).not.toContain("Secure");
    expect(start.headers.get("Set-Cookie")).not.toContain("Domain=");
    runtime.env.ALLOWED_DOMAINS = "";
    runtime.env.ALLOWED_EMAILS = "";
    expect((await request("/v1/auth/google/start")).status).toBe(503);
  });

  it("exchanges PKCE once and revokes the stored hashed bearer credential", async () => {
    const verifier = "a".repeat(43);
    await cliCode("one-time", verifier);
    const result = await exchange("one-time", verifier);
    expect(result.status).toBe(200);
    const credential = (await result.json()) as { token: string; id: string };
    const stored = await runtime.env.DB.prepare(
      "SELECT token_hash FROM cli_credentials",
    ).first<{ token_hash: string }>();
    expect(stored!.token_hash).toBe(await hashToken(credential.token));
    expect(stored!.token_hash).not.toBe(credential.token);
    expect((await exchange("one-time", verifier)).status).toBe(401);
    const headers = { Authorization: `Bearer ${credential.token}` };
    expect((await request("/v1/me", { headers })).status).toBe(200);
    expect(
      (
        await request(`/v1/auth/cli/credentials/${credential.id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
    ).toBe(204);
    expect((await request("/v1/me", { headers })).status).toBe(401);
  });
  it("consumes a code on a failed PKCE attempt", async () => {
    await cliCode("one-time", "a".repeat(43));
    expect((await exchange("one-time", "b".repeat(43))).status).toBe(401);
    expect((await exchange("one-time", "a".repeat(43))).status).toBe(401);
  });
  it("expires authorization codes", async () => {
    await runtime.env.DB.prepare("INSERT INTO cli_codes VALUES (?,?,?,?)")
      .bind(
        await hashToken("expired"),
        "usr_test",
        await hashToken("a".repeat(43)),
        nowSeconds() - 1,
      )
      .run();
    expect((await exchange("expired", "a".repeat(43))).status).toBe(401);
  });
  it("checks cookie Origin and rejects invalid bearer instead of falling back to a valid cookie", async () => {
    await runtime.env.DB.prepare("INSERT INTO sessions VALUES (?,?,?)")
      .bind(await hashToken("session"), "usr_test", nowSeconds() + 600)
      .run();
    const cookie = "__Host-slashdocs_session=session";
    expect((await request("/v1/me", { headers: { Cookie: cookie } })).status).toBe(200);
    expect(
      (
        await request("/v1/me", {
          headers: { Cookie: cookie, Authorization: "Bearer invalid" },
        })
      ).status,
    ).toBe(401);
    for (const origin of [undefined, "https://evil.example.com"]) {
      expect(
        (
          await request("/v1/auth/logout", {
            method: "POST",
            headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await request("/v1/auth/logout", {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://app.example.com" },
        })
      ).status,
    ).toBe(204);
    expect((await request("/v1/me", { headers: { Cookie: cookie } })).status).toBe(401);
  });
  it("rejects foreign browser Origin even with valid bearer", async () => {
    await cliCode("code", "a".repeat(43));
    const credential = (await (await exchange("code", "a".repeat(43))).json()) as {
      token: string;
      id: string;
    };
    expect(
      (
        await request(`/v1/auth/cli/credentials/${credential.id}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${credential.token}`,
            Origin: "https://evil.example.com",
          },
        })
      ).status,
    ).toBe(403);
  });
  it("binds OAuth state to its originating cookie and refuses replay", async () => {
    runtime.env.GOOGLE_CLIENT_ID = "test-client";
    runtime.env.GOOGLE_CLIENT_SECRET = "test-only-secret";
    const start = await request("/v1/auth/google/start?redirect=%2Fdocuments");
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const cookie = start.headers.get("Set-Cookie")!.split(";")[0];
    expect(start.headers.get("Set-Cookie")).toContain("__Host-");
    expect(start.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(start.headers.get("Set-Cookie")).toContain("Secure");
    expect(
      (await request(`/v1/auth/google/callback?state=${state}&code=code`)).status,
    ).toBe(400);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    expect(
      (
        await request(`/v1/auth/google/callback?state=${state}&code=code`, {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(`/v1/auth/google/callback?state=${state}&code=code`, {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(400);
  });
  it("verifies Google signed identity, audience, nonce, verified email and account policy", async () => {
    runtime.env.GOOGLE_CLIENT_ID = "test-client";
    runtime.env.GOOGLE_CLIENT_SECRET = "test-only-secret";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: "test-key",
      alg: "RS256",
      use: "sig",
    };
    let currentToken = "";
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      if (String(input).includes("/certs")) return Response.json({ keys: [jwk] });
      return Response.json({ id_token: currentToken });
    });
    async function login(
      claims: Record<string, unknown>,
      audience = "test-client",
      path = "/v1/auth/google/start",
    ) {
      const start = await request(path);
      const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
      const cookie = start.headers.get("Set-Cookie")!.split(";")[0];
      currentToken = await new SignJWT({
        email: "person@example.com",
        email_verified: true,
        nonce: state,
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setSubject("test-subject")
        .setIssuer("https://accounts.google.com")
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return request(`/v1/auth/google/callback?state=${state}&code=code`, {
        headers: { Cookie: cookie },
      });
    }
    expect((await login({ email_verified: false })).status).toBe(401);
    expect((await login({ email: "person@sub.example.com" })).status).toBe(403);
    expect((await login({ nonce: "wrong" })).status).toBe(401);
    expect((await login({}, "wrong-client")).status).toBe(401);
    const success = await login({});
    expect(success.status).toBe(302);
    const cookie = success.headers
      .get("Set-Cookie")!
      .split(", ")
      .find((value) => value.startsWith("__Host-slashdocs_session="))!
      .split(";")[0];
    const me = await request("/v1/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(
      "person@example.com",
    );
    const verifier = "a".repeat(43);
    const params = new URLSearchParams({
      mode: "cli",
      state: "correlation-state-123456",
      cli_redirect: "http://127.0.0.1:4321/callback",
      code_challenge: await hashToken(verifier),
    });
    const cliLogin = await login({}, "test-client", `/v1/auth/google/start?${params}`);
    expect(cliLogin.status).toBe(302);
    const location = new URL(cliLogin.headers.get("Location")!);
    expect(location.origin).toBe("http://127.0.0.1:4321");
    expect(location.searchParams.get("state")).toBe("correlation-state-123456");
    expect((await exchange(location.searchParams.get("code")!, verifier)).status).toBe(
      200,
    );
  });
  it("searches users with literal SQL LIKE metacharacters", async () => {
    await runtime.env.DB.prepare("INSERT INTO sessions VALUES (?,?,?)")
      .bind(await hashToken("session"), "usr_test", nowSeconds() + 600)
      .run();
    const result = await request("/v1/users?q=%25%25", {
      headers: { Cookie: "__Host-slashdocs_session=session" },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ items: [] });
  });
  it("reports supported discovery and disabled foundation capabilities", async () => {
    expect(await (await request("/.well-known/slashdocs.json")).json()).toEqual({
      name: "slashdocs",
      api_version: "v1",
      auth: { modes: ["web", "cli"] },
    });
    const config = (await (await request("/v1/config")).json()) as {
      capabilities: { folders: boolean; refresh: string };
    };
    expect(config.capabilities.folders).toBe(false);
    expect(config.capabilities.refresh).toBe("polling");
  });
});
