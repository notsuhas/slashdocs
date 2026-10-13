import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError } from "../../../shared/errors";
import { randomToken, hashToken, nowSeconds } from "../auth/tokens";
import { safeRedirect } from "../auth/policy";
import { requireDocument } from "../services/permissions";
import {
  authorsCanRead,
  githubConfigured,
  githubConnection,
  githubFetch,
  githubHeaders,
  githubJSON,
  githubProfile,
  githubTokenFor,
  readGitHubBody,
  sealGitHubToken,
} from "../services/github";
export const githubRoutes = new Hono<AppEnv>();
// Only OAuth/status/disconnect require a human; raw reads use each caller's own connection.
githubRoutes.use("/v1/integrations/github*", async (c, next) => {
  if (c.get("actor").principal.type !== "user")
    throw new ApiError(403, "forbidden", "GitHub can only be connected by a user");
  await next();
});
githubRoutes.get("/v1/integrations/github", async (c) => {
  const connection = await githubConnection(c.env, c.get("actor").principal.id);
  return c.json(
    connection
      ? {
          connected: true,
          configured: githubConfigured(c.env),
          login: connection.login,
          avatar_url: connection.avatar_url,
          updated_at: connection.updated_at,
        }
      : { connected: false, configured: githubConfigured(c.env) },
  );
});
githubRoutes.get("/v1/integrations/github/start", async (c) => {
  if (!githubConfigured(c.env))
    throw new ApiError(503, "github_not_configured", "GitHub OAuth is not configured");
  const redirect = c.req.query("redirect") ?? "/app/profile";
  if (!safeRedirect(redirect))
    throw new ApiError(400, "bad_request", "invalid redirect");
  const state = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO github_oauth_states(state_hash,user_id,redirect,expires_at) VALUES(?,?,?,?)",
  )
    .bind(
      await hashToken(state),
      c.get("actor").principal.id,
      redirect,
      nowSeconds() + 600,
    )
    .run();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID ?? "",
    redirect_uri:
      c.env.APP_ORIGIN.replace(/\/$/, "") + "/v1/integrations/github/callback",
    scope: "repo read:user",
    state,
  }).toString();
  return c.redirect(url.toString(), 302);
});
githubRoutes.get("/v1/integrations/github/callback", async (c) => {
  if (!githubConfigured(c.env)) throw new ApiError(404, "not_found", "Not found");
  const state = await c.env.DB.prepare(
    "DELETE FROM github_oauth_states WHERE state_hash=? AND expires_at>? RETURNING user_id,redirect",
  )
    .bind(await hashToken(c.req.query("state") ?? ""), nowSeconds())
    .first<{ user_id: string; redirect: string }>();
  if (!state || state.user_id !== c.get("actor").principal.id)
    throw new ApiError(400, "bad_request", "invalid oauth state");
  let token: string;
  try {
    const response = await githubJSON(
      c.env,
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: c.env.GITHUB_CLIENT_ID ?? "",
          client_secret: c.env.GITHUB_CLIENT_SECRET ?? "",
          code: c.req.query("code") ?? "",
          redirect_uri:
            c.env.APP_ORIGIN.replace(/\/$/, "") + "/v1/integrations/github/callback",
        }),
      },
    );
    token = z.object({ access_token: z.string().min(1) }).parse(response).access_token;
  } catch {
    throw new ApiError(502, "github_oauth_failed", "GitHub authorization failed");
  }
  let profile: z.infer<typeof githubProfile>;
  try {
    profile = githubProfile.parse(
      await githubJSON(c.env, "https://api.github.com/user", {
        headers: githubHeaders(token),
      }),
    );
  } catch {
    throw new ApiError(
      502,
      "github_profile_failed",
      "Could not read the GitHub profile",
    );
  }
  const sealed = await sealGitHubToken(c.env, token);
  await c.env.DB.prepare(
    "INSERT INTO github_connections(user_id,github_user_id,login,avatar_url,access_token_ciphertext,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET github_user_id=excluded.github_user_id,login=excluded.login,avatar_url=excluded.avatar_url,access_token_ciphertext=excluded.access_token_ciphertext,updated_at=excluded.updated_at",
  )
    .bind(
      state.user_id,
      profile.id,
      profile.login,
      profile.avatar_url,
      sealed,
      new Date().toISOString(),
    )
    .run();
  return c.redirect(state.redirect, 302);
});
githubRoutes.delete("/v1/integrations/github", async (c) => {
  await c.env.DB.prepare("DELETE FROM github_connections WHERE user_id=?")
    .bind(c.get("actor").principal.id)
    .run();
  return c.body(null, 204);
});
const rawInput = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  path: z.string().min(1),
  ref: z.string().min(1),
});
githubRoutes.post("/v1/documents/:id/github/raw", async (c) => {
  const actor = c.get("actor"),
    docID = c.req.param("id");
  await requireDocument(c.env, actor, docID, "viewer");
  const input = rawInput.parse(await c.req.json());
  if (
    input.owner.includes("/") ||
    input.repo.includes("/") ||
    input.path.startsWith("/") ||
    input.path.includes("..")
  )
    throw new ApiError(400, "bad_request", "invalid repository path");
  const token = await githubTokenFor(c.env, actor);
  await authorsCanRead(
    c.env,
    actor,
    docID,
    input.owner.toLowerCase(),
    input.repo.toLowerCase(),
  );
  const path = input.path.split("/").map(encodeURIComponent).join("/");
  let response: Response;
  try {
    response = await githubFetch(
      c.env,
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${path}?ref=${encodeURIComponent(input.ref)}`,
      { headers: githubHeaders(token, "application/vnd.github.raw+json") },
    );
  } catch {
    throw new ApiError(502, "github_unavailable", "GitHub request failed");
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return new Response(
      JSON.stringify({
        error: { code: "github_error", message: "GitHub could not return that file" },
      }),
      { status: response.status, headers: { "Content-Type": "application/json" } },
    );
  }
  const content = new TextDecoder().decode(
    await readGitHubBody(response, 50 * 1024 * 1024),
  );
  return c.json({
    ...input,
    content,
    content_type: response.headers.get("Content-Type") ?? "",
    etag: response.headers.get("ETag") ?? "",
  });
});
