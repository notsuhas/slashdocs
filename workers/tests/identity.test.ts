import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { z } from "zod";
import { authRoutes } from "../app/src/routes/auth";
import { serviceAccountRoutes } from "../app/src/routes/service-accounts";
import { requireAuth, revalidateActor } from "../app/src/auth/middleware";
import { oidcSettings, identityKeys } from "../app/src/auth/oidc";
import { hashToken } from "../app/src/auth/tokens";
import { withInternalActor } from "../app/src/auth/internal-actor";
import { ApiError } from "../shared/errors";
import { createTestEnv, seedUser } from "./runtime";
import type { AppEnv } from "../app/src/env";
let runtime: Awaited<ReturnType<typeof createTestEnv>>;
const app = new Hono<AppEnv>();
app.route("/", authRoutes);
const secured = new Hono<AppEnv>();
secured.use("*", requireAuth).route("/", serviceAccountRoutes);
app.route("/", secured);
app.onError((error, c) =>
  c.json(
    { error: { code: error instanceof ApiError ? error.code : "bad_request" } },
    (error instanceof ApiError ? error.status : 400) as 400,
  ),
);
const req = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization"))
    headers.set("Authorization", "Bearer slashdocs_cli_owner");
  return app.request(
    `https://app.example.com${path}`,
    { ...init, headers },
    runtime.env,
  );
};
const json = (method: string, body: unknown, token?: string) => ({
  method,
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});
const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.object({ id: z.string(), token: z.string() }),
});
beforeEach(async () => {
  runtime = await createTestEnv();
  await seedUser(runtime.env, "usr_owner", "owner@example.com");
  await seedUser(runtime.env, "usr_target", "target@example.com");
  for (const name of ["owner", "target"])
    await runtime.env.DB.prepare(
      "INSERT INTO cli_credentials(id,token_hash,user_id,name,created_at) VALUES (?,?,?,?,?)",
    )
      .bind(
        `cli_${name}`,
        await hashToken(`slashdocs_cli_${name}`),
        `usr_${name}`,
        name,
        new Date().toISOString(),
      )
      .run();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await runtime.dispose();
});
async function oidcFixture(authMethods?: string[], postOnly = false) {
  Object.assign(runtime.env, {
    SLASHDOCS_OIDC_ISSUER_URL: "https://login.example.com",
    SLASHDOCS_OIDC_CLIENT_ID: "oidc-client",
    SLASHDOCS_OIDC_CLIENT_SECRET: "test-secret",
  });
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const key = { ...(await exportJWK(publicKey)), kid: "fixture", alg: "RS256" };
  const tokens = new Map<string, string>();
  const exchanges: { authorization: string | null; body: URLSearchParams }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("openid-configuration"))
      return Response.json({
        issuer: "https://login.example.com",
        authorization_endpoint: "https://login.example.com/authorize",
        token_endpoint: "https://login.example.com/token",
        jwks_uri: "https://login.example.com/keys",
        token_endpoint_auth_methods_supported: authMethods,
      });
    if (request.url.endsWith("/keys")) return Response.json({ keys: [key] });
    const body = new URLSearchParams(await request.text());
    exchanges.push({ authorization: request.headers.get("Authorization"), body });
    if (postOnly && request.headers.has("Authorization"))
      return Response.json({ error: "invalid_client" });
    if (
      authMethods?.includes("client_secret_basic") &&
      (request.headers.get("Authorization") !==
        `Basic ${btoa("oidc-client:test-secret")}` ||
        body.has("client_secret"))
    )
      return Response.json({ error: "invalid_client" }, { status: 401 });
    return Response.json({ id_token: tokens.get(body.get("code") || "") });
  });
  async function sign(
    code: string,
    state: string,
    claims: Record<string, unknown> = {},
  ) {
    tokens.set(
      code,
      await new SignJWT({
        sub: code,
        email: "login@example.com",
        nonce: state,
        iss: "https://login.example.com",
        aud: "oidc-client",
        exp: Math.floor(Date.now() / 1000) + 300,
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .sign(privateKey),
    );
  }
  async function login(code: string, query = "") {
    const start = await req(`/v1/auth/oidc/start${query}`);
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    await sign(code, state);
    return {
      start,
      state,
      callback: () =>
        req(`/v1/auth/oidc/callback?state=${encodeURIComponent(state)}&code=${code}`, {
          headers: { Cookie: start.headers.get("Set-Cookie")?.split(";")[0] || "" },
        }),
    };
  }
  return { sign, login, exchanges };
}
function wrapBatch(batch: D1Database["batch"]) {
  const db = runtime.env.DB;
  runtime.env.DB = {
    prepare: db.prepare.bind(db),
    batch,
    exec: db.exec.bind(db),
    dump: db.dump.bind(db),
    withSession: db.withSession.bind(db),
  };
}
function pauseWrites(before: (query: string) => Promise<void>) {
  const db = runtime.env.DB;
  const originals = new WeakMap<
    D1PreparedStatement,
    { statement: D1PreparedStatement; query: string }
  >();
  wrapBatch(async (statements) => {
    for (const statement of statements) {
      const entry = originals.get(statement);
      if (entry) await before(entry.query);
    }
    return db.batch(
      statements.map((statement) => originals.get(statement)?.statement || statement),
    );
  });
  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => {
    const wrapped: D1PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values), query),
      first: statement.first.bind(statement),
      all: statement.all.bind(statement),
      raw: statement.raw.bind(statement),
      run: async <T>() => {
        await before(query);
        return statement.run<T>();
      },
    };
    originals.set(wrapped, { statement, query });
    return wrapped;
  };
  runtime.env.DB.prepare = (query) => wrap(db.prepare(query), query);
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("identity and service accounts on D1", () => {
  it("keeps configured OIDC callback for the retained Google CLI alias", async () => {
    const fixture = await oidcFixture(["client_secret_post"]);
    for (const alias of ["google", "oidc"]) {
      const start = await req(
        `/v1/auth/${alias}/start?mode=cli&cli_redirect=http://localhost:1234/callback&code_challenge=test`,
      );
      const location = new URL(start.headers.get("Location")!);
      expect(location.searchParams.get("redirect_uri")).toBe(
        "https://app.example.com/v1/auth/oidc/callback",
      );
      const state = location.searchParams.get("state")!;
      await fixture.sign(alias, state);
      const callback = await req(
        `/v1/auth/${alias}/callback?state=${encodeURIComponent(state)}&code=${alias}`,
      );
      expect(callback.status).toBe(302);
      expect(fixture.exchanges.at(-1)?.body.get("redirect_uri")).toBe(
        "https://app.example.com/v1/auth/oidc/callback",
      );
    }
  });
  it("keeps configured Google callback for both authentication aliases", async () => {
    runtime.env.GOOGLE_CLIENT_ID = "fixture-client";
    runtime.env.GOOGLE_CLIENT_SECRET = "fixture-secret";
    for (const alias of ["google", "oidc"]) {
      const start = await req(`/v1/auth/${alias}/start`);
      expect(start.status).toBe(302);
      expect(
        new URL(start.headers.get("Location")!).searchParams.get("redirect_uri"),
      ).toBe("https://app.example.com/v1/auth/google/callback");
    }
  });
  it("creates bot identities, stores only key hashes, disables and revokes bearer access", async () => {
    const response = await req(
      "/v1/service-accounts",
      json("POST", { label: "assistant", domain: "test.bot" }),
    );
    expect(response.status).toBe(201);
    const sa = accountSchema.parse(await response.json());
    expect(sa.name).toBe("assistant@test.bot");
    const key = await runtime.env.DB.prepare(
      "SELECT token_hash FROM service_account_keys WHERE id=?",
    )
      .bind(sa.key.id)
      .first<{ token_hash: string }>();
    expect(key?.token_hash).toBe(await hashToken(sa.key.token));
    const me = await req("/v1/me", {
      headers: { Authorization: `Bearer ${sa.key.token}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      principal: { type: "service_account", id: sa.id },
    });
    expect(
      (
        await req(
          "/v1/service-accounts",
          json("POST", { label: "another" }, sa.key.token),
        )
      ).status,
    ).toBe(403);
    expect(
      (await req(`/v1/service-accounts/${sa.id}`, json("PATCH", { disabled: true })))
        .status,
    ).toBe(200);
    expect(
      (await req("/v1/me", { headers: { Authorization: `Bearer ${sa.key.token}` } }))
        .status,
    ).toBe(401);
    await req(`/v1/service-accounts/${sa.id}`, json("PATCH", { disabled: false }));
    expect(
      (await req("/v1/me", { headers: { Authorization: `Bearer ${sa.key.token}` } }))
        .status,
    ).toBe(200);
    await req(`/v1/service-accounts/${sa.id}/keys/${sa.key.id}`, { method: "DELETE" });
    expect(
      (await req("/v1/me", { headers: { Authorization: `Bearer ${sa.key.token}` } }))
        .status,
    ).toBe(401);
    expect(await (await req(`/v1/service-accounts/${sa.id}/keys`)).json()).toEqual({
      items: [],
    });
  });
  it("enforces owner-only management, transfer recipient and terminal states", async () => {
    const sa = accountSchema.parse(
      await (
        await req("/v1/service-accounts", json("POST", { label: "assistant" }))
      ).json(),
    );
    expect(
      (
        await req(
          `/v1/service-accounts/${sa.id}`,
          json("PATCH", { disabled: true }, "slashdocs_cli_target"),
        )
      ).status,
    ).toBe(403);
    const transfer = z
      .object({ id: z.string(), to_user_id: z.string() })
      .parse(
        await (
          await req(
            `/v1/service-accounts/${sa.id}/transfer`,
            json("POST", { to_user_email: "target@example.com" }),
          )
        ).json(),
      );
    expect(transfer.to_user_id).toBe("usr_target");
    expect(
      (
        await req(`/v1/service-accounts/transfers/${transfer.id}/accept`, {
          method: "POST",
        })
      ).status,
    ).toBe(403);
    const accepted = await req(
      `/v1/service-accounts/transfers/${transfer.id}/accept`,
      json("POST", {}, "slashdocs_cli_target"),
    );
    expect(accepted.status).toBe(200);
    expect(
      (
        await req(
          `/v1/service-accounts/transfers/${transfer.id}/accept`,
          json("POST", {}, "slashdocs_cli_target"),
        )
      ).status,
    ).toBe(409);
    expect(
      (await req(`/v1/service-accounts/${sa.id}`, json("PATCH", { name: "renamed" })))
        .status,
    ).toBe(403);
    expect(
      (
        await req(
          `/v1/service-accounts/${sa.id}`,
          json("PATCH", { name: "renamed" }, "slashdocs_cli_target"),
        )
      ).status,
    ).toBe(200);
  });
  it("supports optional key body, rejects duplicate/invalid addresses and hides bot backing rows", async () => {
    const sa = accountSchema.parse(
      await (
        await req(
          "/v1/service-accounts",
          json("POST", { label: "assistant", domain: "test.bot" }),
        )
      ).json(),
    );
    expect(
      (await req(`/v1/service-accounts/${sa.id}/keys`, { method: "POST" })).status,
    ).toBe(201);
    expect(
      (
        await req(
          "/v1/service-accounts",
          json("POST", { label: "assistant", domain: "test.bot" }),
        )
      ).status,
    ).toBe(409);
    expect(
      (await req("/v1/service-accounts", json("POST", { label: "Bad Name" }))).status,
    ).toBe(400);
    expect(await (await req("/v1/users?q=assistant")).json()).toEqual({ items: [] });
  });
  it("supports generic split-horizon OIDC with signed claims and distinct issuer namespaces", async () => {
    Object.assign(runtime.env, {
      SLASHDOCS_OIDC_ISSUER_URL: "https://login.example.com",
      SLASHDOCS_OIDC_INTERNAL_ISSUER_URL: "http://oidc.internal",
      SLASHDOCS_OIDC_CLIENT_ID: "oidc-client",
      SLASHDOCS_OIDC_CLIENT_SECRET: "test-secret",
    });
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const key = {
      ...(await exportJWK(publicKey)),
      kid: "oidc",
      alg: "RS256",
      use: "sig",
    };
    let token = "";
    const visited: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      visited.push(url);
      if (url.endsWith("openid-configuration"))
        return Response.json({
          issuer: "https://login.example.com",
          authorization_endpoint: "http://oidc.internal/authorize",
          token_endpoint: "https://login.example.com/token",
          jwks_uri: "https://login.example.com/keys",
        });
      if (url.endsWith("/keys")) return Response.json({ keys: [key] });
      return Response.json({ id_token: token });
    });
    const start = await req("/v1/auth/oidc/start");
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("Location")!);
    expect(location.origin).toBe("https://login.example.com");
    token = await new SignJWT({
      email: "owner@example.com",
      nonce: location.searchParams.get("state"),
    })
      .setSubject("same-subject")
      .setProtectedHeader({ alg: "RS256", kid: "oidc" })
      .setIssuer("https://login.example.com")
      .setAudience("oidc-client")
      .setExpirationTime("5m")
      .sign(privateKey);
    const callback = await req(
      `/v1/auth/oidc/callback?state=${location.searchParams.get("state")}&code=code`,
      { headers: { Cookie: start.headers.get("Set-Cookie")!.split(";")[0] } },
    );
    expect(callback.status).toBe(302);
    expect(visited).toContain("http://oidc.internal/token");
    expect(visited).toContain("http://oidc.internal/keys");
    expect(await identityKeys("https://login.example.com", "same-subject")).not.toEqual(
      await identityKeys("https://other.example.com", "same-subject"),
    );
    runtime.env.GOOGLE_CLIENT_ID = "mixed";
    expect(() => oidcSettings(runtime.env)).toThrow("one complete");
  });
  it("conditionally claims a placeholder during concurrent signed same-email logins", async () => {
    const fixture = await oidcFixture();
    await runtime.env.DB.prepare(
      "INSERT INTO users(id,provider,provider_subject,email,name,created_at) VALUES ('usr_invited','placeholder','usr_invited','login@example.com','Invited','now')",
    ).run();
    const first = await fixture.login("subject-one");
    const second = await fixture.login("subject-two");
    const ready = deferred(),
      release = deferred();
    const batch = runtime.env.DB.batch.bind(runtime.env.DB);
    let arrivals = 0;
    const pausedBatch: typeof batch = async (statements) => {
      if (++arrivals === 2) ready.resolve();
      await release.promise;
      return batch(statements);
    };
    wrapBatch(pausedBatch);
    const callbacks = [first.callback(), second.callback()];
    await ready.promise;
    release.resolve();
    expect((await Promise.all(callbacks)).map((response) => response.status)).toEqual([
      302, 302,
    ]);
    const users = await runtime.env.DB.prepare(
      "SELECT id,provider_subject FROM users WHERE email='login@example.com'",
    ).all<{ id: string; provider_subject: string }>();
    expect(users.results).toHaveLength(2);
    expect(new Set(users.results.map((user) => user.provider_subject)).size).toBe(2);
    expect(users.results.some((user) => user.id === "usr_invited")).toBe(true);
    const sessions = await runtime.env.DB.prepare("SELECT user_id FROM sessions").all<{
      user_id: string;
    }>();
    expect(new Set(sessions.results.map((session) => session.user_id)).size).toBe(2);
  });
  it("does not let a delayed duplicate acceptance overwrite an onward transfer", async () => {
    const sa = accountSchema.parse(
      await (await req("/v1/service-accounts", json("POST", { label: "race" }))).json(),
    );
    const transferSchema = z.object({ id: z.string() });
    const transfer = transferSchema.parse(
      await (
        await req(
          `/v1/service-accounts/${sa.id}/transfer`,
          json("POST", { to_user_email: "target@example.com" }),
        )
      ).json(),
    );
    const ready = deferred(),
      release = deferred();
    const batch = runtime.env.DB.batch.bind(runtime.env.DB);
    let firstAttempt = true;
    wrapBatch(async (statements) => {
      if (firstAttempt) {
        firstAttempt = false;
        ready.resolve();
        await release.promise;
      }
      return batch(statements);
    });
    const accept = () =>
      req(
        `/v1/service-accounts/transfers/${transfer.id}/accept`,
        json("POST", {}, "slashdocs_cli_target"),
      );
    const delayed = accept();
    await ready.promise;
    expect((await accept()).status).toBe(200);
    const onward = transferSchema.parse(
      await (
        await req(
          `/v1/service-accounts/${sa.id}/transfer`,
          json("POST", { to_user_email: "owner@example.com" }, "slashdocs_cli_target"),
        )
      ).json(),
    );
    expect(
      (
        await req(`/v1/service-accounts/transfers/${onward.id}/accept`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    release.resolve();
    expect((await delayed).status).toBe(409);
    expect(
      await runtime.env.DB.prepare(
        "SELECT owner_user_id FROM service_accounts WHERE id=?",
      )
        .bind(sa.id)
        .first(),
    ).toEqual({ owner_user_id: "usr_owner" });
  });
  it("supports Basic-only providers and generated or caller-selected CLI state without browser binding", async () => {
    const fixture = await oidcFixture(["client_secret_basic"]);
    for (const suppliedState of ["", "caller-state"]) {
      const verifier = "v".repeat(43);
      const login = await fixture.login(
        `cli-${suppliedState || "generated"}`,
        `?mode=cli&cli_redirect=${encodeURIComponent("http://127.0.0.1:8765/callback")}&code_challenge=${await hashToken(verifier)}${suppliedState ? `&state=${suppliedState}` : ""}`,
      );
      expect(login.start.headers.get("Set-Cookie")).toBeNull();
      if (suppliedState) expect(login.state).toBe(suppliedState);
      else expect(login.state).not.toBe("");
      const callback = await login.callback();
      expect(callback.status).toBe(302);
      const redirect = new URL(callback.headers.get("Location")!);
      expect(redirect.searchParams.get("state")).toBe(login.state);
      expect(
        (
          await req(
            "/v1/auth/cli/exchange",
            json("POST", {
              code: redirect.searchParams.get("code"),
              code_verifier: verifier,
            }),
          )
        ).status,
      ).toBe(200);
      expect((await login.callback()).status).toBe(400);
    }
    expect(fixture.exchanges).toHaveLength(2);
    expect(fixture.exchanges.every((request) => request.authorization !== null)).toBe(
      true,
    );
  });
  it("keeps web state server-generated and rejects callbacks without the browser binding", async () => {
    const fixture = await oidcFixture();
    const login = await fixture.login("web", "?state=attacker-chosen");
    expect(login.state).not.toBe("attacker-chosen");
    expect(
      (await req(`/v1/auth/oidc/callback?state=${login.state}&code=web`)).status,
    ).toBe(400);
    expect((await login.callback()).status).toBe(302);
  });
  it.each([
    { iss: "https://wrong.example.com" },
    { aud: "other-client" },
    { exp: 1 },
    { sub: "" },
    { email: "" },
    { email_verified: false },
    { nonce: "wrong" },
  ])("rejects invalid signed OIDC claims %j", async (claims) => {
    const fixture = await oidcFixture();
    const login = await fixture.login("invalid");
    await fixture.sign("invalid", login.state, claims);
    expect((await login.callback()).status).toBe(401);
    expect(
      await runtime.env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first(),
    ).toEqual({ count: 0 });
  });
  it("rejects forged human credentials for bot rows and key writes by other owners or bots", async () => {
    const sa = accountSchema.parse(
      await (
        await req("/v1/service-accounts", json("POST", { label: "forged" }))
      ).json(),
    );
    await runtime.env.DB.prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)",
    )
      .bind(
        await hashToken("forged-session"),
        sa.id,
        Math.floor(Date.now() / 1000) + 300,
      )
      .run();
    await runtime.env.DB.prepare(
      "INSERT INTO cli_credentials(id,token_hash,user_id,name,created_at) VALUES ('cli_forged',?,?,'forged','now')",
    )
      .bind(await hashToken("slashdocs_cli_forged"), sa.id)
      .run();
    const forgedSession = await app.request(
      "https://app.example.com/v1/me",
      { headers: { Cookie: "__Host-slashdocs_session=forged-session" } },
      runtime.env,
    );
    expect(forgedSession.status).toBe(401);
    expect(
      (
        await req("/v1/me", {
          headers: { Authorization: "Bearer slashdocs_cli_forged" },
        })
      ).status,
    ).toBe(401);
    for (const token of ["slashdocs_cli_target", sa.key.token]) {
      expect(
        (await req(`/v1/service-accounts/${sa.id}/keys`, json("POST", {}, token)))
          .status,
      ).toBe(403);
      expect(
        (
          await req(`/v1/service-accounts/${sa.id}/keys/${sa.key.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (await req("/v1/me", { headers: { Authorization: `Bearer ${sa.key.token}` } }))
        .status,
    ).toBe(200);
  });
  it("preserves distinct signed subjects that differ only in whitespace", async () => {
    const fixture = await oidcFixture();
    for (const sub of ["alice", " alice "]) {
      const login = await fixture.login(sub.trim() + sub.length);
      await fixture.sign(sub.trim() + sub.length, login.state, { sub });
      expect((await login.callback()).status).toBe(302);
    }
    const rows = await runtime.env.DB.prepare(
      "SELECT id FROM users WHERE email='login@example.com'",
    ).all<{ id: string }>();
    expect(rows.results).toHaveLength(2);
    expect(new Set(rows.results.map((row) => row.id)).size).toBe(2);
  });
  it("rejects an old pending invitation after ownership has moved onward", async () => {
    const sa = accountSchema.parse(
      await (
        await req("/v1/service-accounts", json("POST", { label: "stale" }))
      ).json(),
    );
    const transferSchema = z.object({ id: z.string() });
    const make = async (to: string, token = "slashdocs_cli_owner") =>
      transferSchema.parse(
        await (
          await req(
            `/v1/service-accounts/${sa.id}/transfer`,
            json("POST", { to_user_email: to }, token),
          )
        ).json(),
      );
    const old = await make("target@example.com");
    const accepted = await make("target@example.com");
    const accept = (id: string, token: string) =>
      req(`/v1/service-accounts/transfers/${id}/accept`, json("POST", {}, token));
    expect((await accept(accepted.id, "slashdocs_cli_target")).status).toBe(200);
    // While B owns it, A's old pending offer no longer authorizes a change.
    expect((await accept(old.id, "slashdocs_cli_target")).status).toBe(409);
    const onward = await make("owner@example.com", "slashdocs_cli_target");
    expect((await accept(onward.id, "slashdocs_cli_owner")).status).toBe(200);
    expect((await accept(old.id, "slashdocs_cli_target")).status).toBe(409);
  });
  it.each(["create-key", "revoke-key", "patch", "offer"])(
    "rejects former-owner %s paused across an accepted transfer",
    async (operation) => {
      const sa = accountSchema.parse(
        await (
          await req("/v1/service-accounts", json("POST", { label: "key-race" }))
        ).json(),
      );
      const transfer = z
        .object({ id: z.string() })
        .parse(
          await (
            await req(
              `/v1/service-accounts/${sa.id}/transfer`,
              json("POST", { to_user_email: "target@example.com" }),
            )
          ).json(),
        );
      const ready = deferred(),
        release = deferred();
      const prefix =
        operation === "create-key"
          ? "INSERT INTO service_account_keys"
          : operation === "revoke-key"
            ? "UPDATE service_account_keys SET revoked_at"
            : operation === "patch"
              ? "UPDATE service_accounts SET name"
              : "INSERT INTO ownership_transfers";
      pauseWrites(async (query) => {
        if (query.startsWith(prefix)) {
          ready.resolve();
          await release.promise;
        }
      });
      const delayed =
        operation === "create-key"
          ? req(`/v1/service-accounts/${sa.id}/keys`, json("POST", {}))
          : operation === "revoke-key"
            ? req(`/v1/service-accounts/${sa.id}/keys/${sa.key.id}`, {
                method: "DELETE",
              })
            : operation === "patch"
              ? req(
                  `/v1/service-accounts/${sa.id}`,
                  json("PATCH", { name: "unauthorized rename", disabled: true }),
                )
              : req(
                  `/v1/service-accounts/${sa.id}/transfer`,
                  json("POST", { to_user_email: "owner@example.com" }),
                );
      await ready.promise;
      expect(
        (
          await req(
            `/v1/service-accounts/transfers/${transfer.id}/accept`,
            json("POST", {}, "slashdocs_cli_target"),
          )
        ).status,
      ).toBe(200);
      release.resolve();
      expect((await delayed).status).toBe(403);
      expect(
        (await req("/v1/me", { headers: { Authorization: `Bearer ${sa.key.token}` } }))
          .status,
      ).toBe(200);
      expect(
        await runtime.env.DB.prepare(
          "SELECT COUNT(*) AS count FROM service_account_keys WHERE service_account_id=?",
        )
          .bind(sa.id)
          .first(),
      ).toEqual({ count: 1 });
    },
  );
  it("revalidates exact sessions after expiry or logout and permits only server-mapped internal actors", async () => {
    const user = {
      type: "user",
      id: "usr_owner",
      email: "owner@example.com",
      name: "Owner",
      picture_url: "",
    } satisfies AppEnv["Variables"]["actor"]["principal"];
    const tokenHash = await hashToken("exact-session");
    const actor = {
      principal: user,
      credentialKind: "session",
      credentialId: tokenHash,
    } satisfies AppEnv["Variables"]["actor"];
    await runtime.env.DB.prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)",
    )
      .bind(tokenHash, user.id, Math.floor(Date.now() / 1000) + 300)
      .run();
    expect(await revalidateActor(runtime.env, actor)).toBe(true);
    await runtime.env.DB.prepare("UPDATE sessions SET expires_at=1 WHERE token_hash=?")
      .bind(tokenHash)
      .run();
    expect(await revalidateActor(runtime.env, actor)).toBe(false);
    await runtime.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(tokenHash)
      .run();
    expect(await revalidateActor(runtime.env, actor)).toBe(false);
    expect(
      await revalidateActor(runtime.env, {
        principal: user,
        credentialKind: "session",
      }),
    ).toBe(false);
    const request = new Request("https://app.example.com/v1/me", {
      headers: {
        Authorization: "Bearer slashdocs_mcp_fake",
        "X-Internal-Actor": "usr_owner",
      },
    });
    expect((await app.fetch(request, runtime.env)).status).toBe(401);
    expect(
      (
        await withInternalActor(
          request,
          { principal: user, credentialKind: "mcp" },
          async () => app.fetch(request, runtime.env),
        )
      ).status,
    ).toBe(200);
    expect((await app.fetch(request, runtime.env)).status).toBe(401);
  });
  it("auto-detects body authentication when unadvertised Basic is rejected", async () => {
    const fixture = await oidcFixture(undefined, true);
    const login = await fixture.login("auto-post");
    expect((await login.callback()).status).toBe(302);
    expect(fixture.exchanges).toHaveLength(2);
    expect(fixture.exchanges[0].authorization).toBe(
      `Basic ${btoa("oidc-client:test-secret")}`,
    );
    expect(fixture.exchanges[1].authorization).toBeNull();
    expect(fixture.exchanges[1].body.get("client_secret")).toBe("test-secret");
  });
  it("rejects CLI authorization codes whose user is a bot backing row", async () => {
    const sa = accountSchema.parse(
      await (
        await req("/v1/service-accounts", json("POST", { label: "bot-code" }))
      ).json(),
    );
    const verifier = "v".repeat(43);
    await runtime.env.DB.prepare(
      "INSERT INTO cli_codes(code_hash,user_id,code_challenge,expires_at) VALUES (?,?,?,?)",
    )
      .bind(
        await hashToken("forged-code"),
        sa.id,
        await hashToken(verifier),
        Math.floor(Date.now() / 1000) + 300,
      )
      .run();
    expect(
      (
        await req(
          "/v1/auth/cli/exchange",
          json("POST", { code: "forged-code", code_verifier: verifier }),
        )
      ).status,
    ).toBe(401);
    expect(
      await runtime.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM cli_credentials WHERE user_id=?",
      )
        .bind(sa.id)
        .first(),
    ).toEqual({ count: 0 });
  });
  it("matches Go CLI redirect and nonempty verifier validation", async () => {
    const fixture = await oidcFixture();
    for (const redirect of [
      "http://localhost/custom-return",
      "http://127.0.0.1:8765/custom-return?existing=yes",
    ]) {
      const verifier = "short verifier";
      const login = await fixture.login(
        "cli-compatible",
        `?mode=cli&cli_redirect=${encodeURIComponent(redirect)}&code_challenge=${await hashToken(verifier)}`,
      );
      const response = await login.callback();
      expect(response.status).toBe(302);
      const callback = new URL(response.headers.get("Location")!);
      expect(callback.pathname).toBe(new URL(redirect).pathname);
      expect(
        (
          await req(
            "/v1/auth/cli/exchange",
            json("POST", {
              code: callback.searchParams.get("code"),
              code_verifier: verifier,
            }),
          )
        ).status,
      ).toBe(200);
    }
    for (const redirect of [
      "https://localhost/callback",
      "http://[::1]:8765/callback",
      "http://remote.example.com/callback",
    ])
      expect(
        (
          await req(
            `/v1/auth/oidc/start?mode=cli&cli_redirect=${encodeURIComponent(redirect)}&code_challenge=nonempty`,
          )
        ).status,
      ).toBe(400);
    expect(
      (
        await req(
          "/v1/auth/cli/exchange",
          json("POST", { code: "", code_verifier: "v" }),
        )
      ).status,
    ).toBe(400);
  });
  it("targets the authenticated recipient when first login races with invitation creation", async () => {
    const fixture = await oidcFixture();
    const sa = accountSchema.parse(
      await (
        await req("/v1/service-accounts", json("POST", { label: "recipient-race" }))
      ).json(),
    );
    const ready = deferred(),
      release = deferred();
    let paused = false;
    pauseWrites(async (query) => {
      if (
        !paused &&
        query.startsWith("INSERT INTO users") &&
        query.includes("'placeholder'")
      ) {
        paused = true;
        ready.resolve();
        await release.promise;
      }
    });
    const invitation = req(
      `/v1/service-accounts/${sa.id}/transfer`,
      json("POST", { to_user_email: "login@example.com" }),
    );
    await ready.promise;
    const login = await fixture.login("recipient");
    const callback = await login.callback();
    expect(callback.status).toBe(302);
    release.resolve();
    const response = await invitation;
    expect(response.status).toBe(201);
    const transfer = z
      .object({ id: z.string(), to_user_id: z.string() })
      .parse(await response.json());
    const keys = await identityKeys("https://login.example.com", "recipient");
    expect(transfer.to_user_id).toBe(keys.id);
    expect(
      await runtime.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM users WHERE email='login@example.com'",
      ).first(),
    ).toEqual({ count: 1 });
    const cookie = callback.headers
      .get("Set-Cookie")!
      .split(", ")
      .find((value) => value.startsWith("__Host-slashdocs_session="))!
      .split(";")[0];
    expect(
      (
        await app.request(
          `https://app.example.com/v1/service-accounts/transfers/${transfer.id}/accept`,
          {
            method: "POST",
            headers: { Cookie: cookie, Origin: "https://app.example.com" },
          },
          runtime.env,
        )
      ).status,
    ).toBe(200);
  });
  it("claims a recipient placeholder created after login starts but before its identity batch", async () => {
    const fixture = await oidcFixture();
    const sa = accountSchema.parse(
      await (
        await req(
          "/v1/service-accounts",
          json("POST", { label: "reverse-recipient-race" }),
        )
      ).json(),
    );
    const login = await fixture.login("reverse-recipient");
    const ready = deferred(),
      release = deferred();
    const db = runtime.env.DB;
    let paused = false;
    wrapBatch(async (statements) => {
      if (!paused) {
        paused = true;
        ready.resolve();
        await release.promise;
      }
      return db.batch(statements);
    });
    const callbackPromise = login.callback();
    await ready.promise;
    const response = await req(
      `/v1/service-accounts/${sa.id}/transfer`,
      json("POST", { to_user_email: "login@example.com" }),
    );
    expect(response.status).toBe(201);
    const transfer = z
      .object({ id: z.string(), to_user_id: z.string() })
      .parse(await response.json());
    release.resolve();
    const callback = await callbackPromise;
    expect(callback.status).toBe(302);
    expect(
      await runtime.env.DB.prepare(
        "SELECT id,provider FROM users WHERE email='login@example.com'",
      ).all(),
    ).toMatchObject({ results: [{ id: transfer.to_user_id, provider: "oidc" }] });
    const cookie = callback.headers
      .get("Set-Cookie")!
      .split(", ")
      .find((value) => value.startsWith("__Host-slashdocs_session="))!
      .split(";")[0];
    expect(
      (
        await app.request(
          `https://app.example.com/v1/service-accounts/transfers/${transfer.id}/accept`,
          {
            method: "POST",
            headers: { Cookie: cookie, Origin: "https://app.example.com" },
          },
          runtime.env,
        )
      ).status,
    ).toBe(200);
  });
});
