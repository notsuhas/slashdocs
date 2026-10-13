import { z } from "zod";
import type { Actor, Env } from "../env";
import { ApiError } from "../../../shared/errors";
import { lookupPrincipal } from "./principals";
const encoder = new TextEncoder();
export function githubConfigured(env: Env) {
  return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}
export async function githubFetch(env: Env, url: string, init: RequestInit = {}) {
  const request = new Request(url, {
    ...init,
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  return env.GITHUB_FETCHER ? env.GITHUB_FETCHER.fetch(request) : fetch(request);
}
export async function readGitHubBody(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ApiError(
        413,
        "github_file_too_large",
        "GitHub response exceeds the size limit",
      );
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export async function githubJSON(
  env: Env,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await githubFetch(env, url, init);
  if (!response.ok)
    throw new ApiError(502, "github_unavailable", "GitHub request failed");
  try {
    return JSON.parse(
      new TextDecoder().decode(await readGitHubBody(response, 1048576)),
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "github_unavailable", "Invalid GitHub response");
  }
}
async function tokenKey(env: Env) {
  const key = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode("aidocs/github-token/v1\0" + env.SESSION_SECRET),
  );
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function sealGitHubToken(
  env: Env,
  token: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      await tokenKey(env),
      encoder.encode(token),
    ),
  );
  const sealed = new Uint8Array(nonce.length + ciphertext.length);
  sealed.set(nonce);
  sealed.set(ciphertext, 12);
  return sealed;
}
export async function openGitHubToken(env: Env, value: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(value);
  if (bytes.length < 28)
    throw new ApiError(500, "internal", "Invalid token ciphertext");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      await tokenKey(env),
      bytes.slice(12),
    ),
  );
}
export interface GitHubConnection {
  user_id: string;
  github_user_id: number;
  login: string;
  avatar_url: string;
  access_token_ciphertext: ArrayBuffer;
  updated_at: string;
}
export async function githubConnection(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM github_connections WHERE user_id=?")
    .bind(id)
    .first<GitHubConnection>();
}
export async function githubTokenFor(env: Env, actor: Actor) {
  const connection = await githubConnection(env, actor.principal.id);
  if (!connection)
    throw new ApiError(
      428,
      "github_not_connected",
      "Connect GitHub before loading repository content",
    );
  return openGitHubToken(env, connection.access_token_ciphertext);
}
export function githubHeaders(token: string, accept = "application/vnd.github+json") {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "SlashDocs",
  };
}
const flights = new WeakMap<Env, Map<string, Promise<boolean>>>();
export async function authorsCanRead(
  env: Env,
  actor: Actor,
  docID: string,
  owner: string,
  repo: string,
) {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT v.created_by_user_id AS author_id,CASE WHEN u.provider='service_account' THEN sa.owner_user_id ELSE u.id END AS user_id,g.access_token_ciphertext,g.updated_at,a.can_read FROM versions v JOIN users u ON u.id=v.created_by_user_id LEFT JOIN service_accounts sa ON sa.id=u.id LEFT JOIN github_connections g ON g.user_id=CASE WHEN u.provider='service_account' THEN sa.owner_user_id ELSE u.id END LEFT JOIN github_repo_access a ON a.user_id=g.user_id AND a.owner=? AND a.repo=? AND a.checked_at>g.updated_at AND a.checked_at>? WHERE v.document_id=?`,
  )
    .bind(owner, repo, new Date(Date.now() - 14400000).toISOString(), docID)
    .all<{
      author_id: string;
      user_id: string | null;
      access_token_ciphertext: ArrayBuffer | null;
      updated_at: string | null;
      can_read: number | null;
    }>();
  for (const row of rows.results) {
    if (actor.principal.type === "user" && row.user_id === actor.principal.id) continue;
    let allowed = row.can_read === null ? undefined : !!row.can_read;
    if (allowed === undefined && row.user_id && row.access_token_ciphertext) {
      let pending = flights.get(env);
      if (!pending) {
        pending = new Map();
        flights.set(env, pending);
      }
      const key = `${row.user_id}\0${owner}/${repo}`;
      let promise = pending.get(key);
      if (!promise) {
        promise = (async () => {
          const token = await openGitHubToken(env, row.access_token_ciphertext!);
          const response = await githubFetch(
            env,
            `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
            { headers: githubHeaders(token) },
          );
          await response.body?.cancel();
          if (![200, 401, 404].includes(response.status))
            throw new ApiError(502, "github_unavailable", "GitHub request failed");
          const canRead = response.status === 200;
          await env.DB.prepare(
            "INSERT INTO github_repo_access(user_id,owner,repo,can_read,checked_at) SELECT user_id,?,?,?,? FROM github_connections WHERE user_id=? AND updated_at=? ON CONFLICT(user_id,owner,repo) DO UPDATE SET can_read=excluded.can_read,checked_at=excluded.checked_at",
          )
            .bind(
              owner,
              repo,
              Number(canRead),
              new Date().toISOString(),
              row.user_id,
              row.updated_at,
            )
            .run();
          return canRead;
        })().finally(() => pending.delete(key));
        pending.set(key, promise);
      }
      allowed = await promise;
    }
    if (!allowed)
      throw new ApiError(
        403,
        "github_author_access",
        "An author of this document cannot read this GitHub repository",
        { author: await lookupPrincipal(env, row.author_id) },
      );
  }
}
export const githubProfile = z.object({
  id: z.number().int(),
  login: z.string(),
  avatar_url: z.string(),
});
