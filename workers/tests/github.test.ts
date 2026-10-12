import { afterEach, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../app/src/env";
import { ApiError } from "../shared/errors";
import { githubRoutes } from "../app/src/routes/github";
import { createTestEnv, seedUser } from "./runtime";
import { createDocument } from "../app/src/services/documents";
import {
  authorsCanRead,
  openGitHubToken,
  sealGitHubToken,
} from "../app/src/services/github";
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
async function fixture() {
  const runtime = await createTestEnv();
  disposers.push(runtime.dispose);
  const owner = await seedUser(runtime.env, "owner", "owner@example.com");
  const viewer = await seedUser(runtime.env, "viewer", "viewer@example.com");
  const client = new Hono<AppEnv>();
  client.use("*", async (c, next) => {
    c.set("actor", {
      principal: c.req.header("X-Actor") === "viewer" ? viewer : owner,
      credentialKind: "session",
    });
    await next();
  });
  client.route("/", githubRoutes);
  client.onError((error) =>
    Response.json(
      { error: { code: error instanceof ApiError ? error.code : "internal" } },
      { status: error instanceof ApiError ? error.status : 500 },
    ),
  );
  return { ...runtime, owner, viewer, client };
}
it("seals GitHub tokens and rejects wrong keys and tampering", async () => {
  const { env } = await fixture();
  const sealed = await sealGitHubToken(env, "test-github-token");
  expect(new TextDecoder().decode(sealed)).not.toContain("test-github-token");
  expect(await openGitHubToken(env, sealed.buffer)).toBe("test-github-token");
  sealed[15] ^= 1;
  await expect(openGitHubToken(env, sealed.buffer)).rejects.toThrow();
  const fresh = await sealGitHubToken(env, "token");
  await expect(
    openGitHubToken({ ...env, SESSION_SECRET: "different-secret" }, fresh.buffer),
  ).rejects.toThrow();
});
it("binds and consumes OAuth state, stores ciphertext and invalidates cache on disconnect", async () => {
  const { env, client } = await fixture();
  env.GITHUB_CLIENT_ID = "example-client";
  env.GITHUB_CLIENT_SECRET = "example-secret";
  env.GITHUB_FETCHER = {
    fetch: async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return Response.json(
        url.includes("/access_token")
          ? { access_token: "test-github-token" }
          : { id: 123, login: "example", avatar_url: "https://example.com/avatar" },
      );
    },
  };
  const start = await client.request(
    "/v1/integrations/github/start?redirect=/app/profile",
    {},
    env,
  );
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state");
  expect(new URL(start.headers.get("Location") ?? "").searchParams.get("scope")).toBe(
    "repo read:user",
  );
  const callback = `/v1/integrations/github/callback?state=${state}&code=example`;
  expect((await client.request(callback, {}, env)).status).toBe(302);
  expect((await client.request(callback, {}, env)).status).toBe(400);
  const status = await client.request("/v1/integrations/github", {}, env);
  expect(await status.json()).toMatchObject({
    connected: true,
    configured: true,
    login: "example",
  });
  await env.DB.prepare(
    "INSERT INTO github_repo_access VALUES('owner','org','repo',1,?)",
  )
    .bind(new Date().toISOString())
    .run();
  expect(
    (await client.request("/v1/integrations/github", { method: "DELETE" }, env)).status,
  ).toBe(204);
  expect(await env.DB.prepare("SELECT * FROM github_repo_access").all()).toMatchObject({
    results: [],
  });
  const another = await client.request("/v1/integrations/github/start", {}, env);
  const otherState = new URL(another.headers.get("Location") ?? "").searchParams.get(
    "state",
  );
  expect(
    (
      await client.request(
        `/v1/integrations/github/callback?state=${otherState}&code=x`,
        { headers: { "X-Actor": "viewer" } },
        env,
      )
    ).status,
  ).toBe(400);
});
it("checks every author before using viewer GitHub access and caches only definitive answers", async () => {
  const { env, owner, viewer } = await fixture();
  const doc = await createDocument(
    env,
    { principal: owner, credentialKind: "session" },
    "Private source",
    new TextEncoder().encode("<p>Test</p>"),
    "viewer",
  );
  const actor = { principal: viewer, credentialKind: "session" as const };
  await expect(authorsCanRead(env, actor, doc.id, "org", "repo")).rejects.toMatchObject(
    { code: "github_author_access" },
  );
  const sealed = await sealGitHubToken(env, "author-token");
  const at = new Date(Date.now() - 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO github_connections VALUES('owner',1,'owner','',?,?)",
  )
    .bind(sealed, at)
    .run();
  let count = 0;
  let status = 200;
  env.GITHUB_FETCHER = {
    fetch: async () => {
      count++;
      return new Response(null, { status });
    },
  };
  await authorsCanRead(env, actor, doc.id, "org", "repo");
  await authorsCanRead(env, actor, doc.id, "org", "repo");
  expect(count).toBe(1);
  await env.DB.prepare("DELETE FROM github_repo_access").run();
  status = 429;
  await expect(authorsCanRead(env, actor, doc.id, "org", "repo")).rejects.toMatchObject(
    { code: "github_unavailable" },
  );
  expect(
    (await env.DB.prepare("SELECT * FROM github_repo_access").all()).results,
  ).toEqual([]);
  status = 404;
  await expect(authorsCanRead(env, actor, doc.id, "org", "repo")).rejects.toMatchObject(
    { code: "github_author_access" },
  );
});
