import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import type { Actor, Env } from "../env";
import { ApiError } from "../../../shared/errors";

export type GroupsEnv = Env;
export type VerifiedGroup = {
  id: string;
  customer_id: string;
  email: string;
  name: string;
};
const discussion = "cloudidentity.googleapis.com/groups.discussion_forum";
const security = "cloudidentity.googleapis.com/groups.security";
const scope = "https://www.googleapis.com/auth/cloud-identity.groups.readonly";
const resourceName = z.string().regex(/^groups\/[^/\s\\]+$/);
const rawGroup = z.object({
  name: resourceName,
  parent: z.string(),
  displayName: z.string().default(""),
  groupKey: z.object({ id: z.string() }),
  labels: z.record(z.string(), z.string()),
});
const relation = z.object({
  group: z.string(),
  displayName: z.string().default(""),
  groupKey: z.object({ id: z.string() }),
  labels: z.record(z.string(), z.string()),
});
class DirectoryError extends Error {
  constructor(readonly code: string) {
    super("Google Group directory is temporarily unavailable");
  }
}
export function googleGroupsEnabled(env: GroupsEnv): boolean {
  return (
    ["true", "1"].includes(env.GOOGLE_GROUPS_ENABLED ?? "") &&
    /^C[a-zA-Z0-9]+$/.test(env.GOOGLE_GROUPS_CUSTOMER_ID ?? "") &&
    !!(env.GOOGLE_GROUPS_SERVICE_ACCOUNT_JSON || env.GOOGLE_GROUPS_ACCESS_TOKEN)
  );
}
export const directoryUnavailable = () =>
  new ApiError(
    503,
    "dependency_unavailable",
    "Google Group directory is temporarily unavailable",
  );
const tokens = new WeakMap<Env, { token: string; expires: number }>();
async function request(
  env: GroupsEnv,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await (env.GOOGLE_GROUPS_FETCHER
      ? env.GOOGLE_GROUPS_FETCHER.fetch(url, { ...init, signal: controller.signal })
      : fetch(url, { ...init, signal: controller.signal }));
    if (!response.ok)
      throw new DirectoryError(
        response.status === 404
          ? "not_found"
          : response.status === 429
            ? "quota"
            : response.status === 401 || response.status === 403
              ? "permission_denied"
              : "unavailable",
      );
    const reader = response.body?.getReader();
    if (!reader) throw new DirectoryError("invalid_response");
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new DirectoryError("invalid_response");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof DirectoryError) throw error;
    throw new DirectoryError(
      controller.signal.aborted
        ? "timeout"
        : error instanceof SyntaxError
          ? "invalid_response"
          : "unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}
async function accessToken(env: GroupsEnv): Promise<string> {
  if (env.GOOGLE_GROUPS_ACCESS_TOKEN) return env.GOOGLE_GROUPS_ACCESS_TOKEN;
  const cached = tokens.get(env);
  if (cached && cached.expires > Date.now()) return cached.token;
  const credentials = z
    .object({
      client_email: z.string().email(),
      private_key: z.string(),
      private_key_id: z.string().optional(),
      subject: z.string().optional(),
    })
    .parse(JSON.parse(env.GOOGLE_GROUPS_SERVICE_ACCOUNT_JSON ?? "{}"));
  const key = await importPKCS8(credentials.private_key, "RS256");
  const assertion = await new SignJWT({
    scope,
    ...(credentials.subject ? { sub: credentials.subject } : {}),
  })
    .setProtectedHeader({
      alg: "RS256",
      typ: "JWT",
      ...(credentials.private_key_id ? { kid: credentials.private_key_id } : {}),
    })
    .setIssuer(credentials.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
  const result = z
    .object({ access_token: z.string().min(1), expires_in: z.number().positive() })
    .parse(
      await request(env, "https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      }),
    );
  tokens.set(env, {
    token: result.access_token,
    expires: Date.now() + Math.max(0, result.expires_in - 60) * 1000,
  });
  return result.access_token;
}
const escapeCEL = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
function managed(labels: Record<string, string>) {
  return discussion in labels || security in labels;
}
function mapGroup(env: GroupsEnv, raw: z.infer<typeof rawGroup>): VerifiedGroup {
  const email = raw.groupKey.id.trim().toLowerCase();
  if (
    raw.parent !== `customers/${env.GOOGLE_GROUPS_CUSTOMER_ID}` ||
    !managed(raw.labels) ||
    !email.includes("@")
  )
    throw new DirectoryError("invalid_group");
  return {
    id: raw.name,
    customer_id: env.GOOGLE_GROUPS_CUSTOMER_ID ?? "",
    email,
    name: raw.displayName,
  };
}
async function getJSON(env: GroupsEnv, path: string, params?: URLSearchParams) {
  return request(
    env,
    `https://cloudidentity.googleapis.com/v1${path}${params ? `?${params}` : ""}`,
    { headers: { Authorization: `Bearer ${await accessToken(env)}` } },
  );
}
const sortGroups = (groups: VerifiedGroup[]) =>
  groups.sort((a, b) => {
    const left = a.name.toLowerCase(),
      right = b.name.toLowerCase();
    return left < right
      ? -1
      : left > right
        ? 1
        : a.email < b.email
          ? -1
          : a.email > b.email
            ? 1
            : 0;
  });
export async function lookupGoogleGroup(
  env: GroupsEnv,
  email: string,
): Promise<VerifiedGroup> {
  email = email.trim().toLowerCase();
  if (!email.includes("@")) throw directoryUnavailable();
  try {
    const lookup = z
      .object({ name: resourceName })
      .parse(
        await getJSON(
          env,
          "/groups:lookup",
          new URLSearchParams({ "groupKey.id": email.trim().toLowerCase() }),
        ),
      );
    const raw = rawGroup.parse(await getJSON(env, `/${lookup.name}`));
    if (raw.name !== lookup.name) throw new DirectoryError("invalid_group");
    return mapGroup(env, raw);
  } catch (error) {
    if (error instanceof DirectoryError && error.code === "not_found")
      throw new ApiError(400, "bad_request", "Select a verified Google Group result");
    throw directoryUnavailable();
  }
}
export async function searchGoogleGroups(
  env: GroupsEnv,
  query: string,
): Promise<VerifiedGroup[]> {
  const params = new URLSearchParams({
    query: `parent == '${escapeCEL(`customers/${env.GOOGLE_GROUPS_CUSTOMER_ID}`)}' && ('${discussion}' in labels || '${security}' in labels) && (group_key.contains('${escapeCEL(query)}') || display_name.contains('${escapeCEL(query)}'))`,
    view: "BASIC",
    pageSize: "20",
  });
  const groups = new Map<string, VerifiedGroup>();
  const pages = new Set<string>();
  try {
    for (let page = 0; page < 100; page++) {
      const result = z
        .object({
          groups: z.array(z.unknown()).default([]),
          nextPageToken: z.string().default(""),
        })
        .parse(await getJSON(env, "/groups:search", params));
      for (const value of result.groups) {
        const parsed = rawGroup.safeParse(value);
        if (!parsed.success) continue;
        try {
          const group = mapGroup(env, parsed.data);
          groups.set(group.id, group);
        } catch {
          continue;
        }
        if (groups.size === 20) return sortGroups([...groups.values()]);
      }
      if (!result.nextPageToken) return sortGroups([...groups.values()]);
      if (pages.has(result.nextPageToken)) throw new DirectoryError("invalid_response");
      pages.add(result.nextPageToken);
      params.set("pageToken", result.nextPageToken);
    }
    throw new DirectoryError("limit");
  } catch {
    throw directoryUnavailable();
  }
}
export async function transitiveGoogleGroups(
  env: GroupsEnv,
  email: string,
): Promise<VerifiedGroup[]> {
  email = email.trim().toLowerCase();
  if (!email.includes("@")) throw new DirectoryError("invalid_member");
  const params = new URLSearchParams({
    query: `member_key_id == '${escapeCEL(email.trim().toLowerCase())}' && ('${discussion}' in labels || '${security}' in labels) && parent == '${escapeCEL(`customers/${env.GOOGLE_GROUPS_CUSTOMER_ID}`)}'`,
    pageSize: "1000",
  });
  const groups = new Map<string, VerifiedGroup>();
  const pages = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const result = z
      .object({
        memberships: z.array(z.unknown()).default([]),
        nextPageToken: z.string().default(""),
      })
      .parse(
        await getJSON(env, "/groups/-/memberships:searchTransitiveGroups", params),
      );
    for (const value of result.memberships) {
      const parsed = relation.safeParse(value);
      if (!parsed.success) continue;
      const raw = parsed.data;
      if (
        !resourceName.safeParse(raw.group).success ||
        !managed(raw.labels) ||
        !raw.groupKey.id.trim()
      )
        continue;
      groups.set(raw.group, {
        id: raw.group,
        customer_id: env.GOOGLE_GROUPS_CUSTOMER_ID ?? "",
        email: raw.groupKey.id.trim().toLowerCase(),
        name: raw.displayName,
      });
      if (groups.size > 10000) throw new DirectoryError("limit");
    }
    if (!result.nextPageToken) return sortGroups([...groups.values()]);
    if (pages.has(result.nextPageToken)) throw new DirectoryError("invalid_response");
    pages.add(result.nextPageToken);
    params.set("pageToken", result.nextPageToken);
  }
  throw new DirectoryError("limit");
}
export function upsertGoogleGroup(env: Env, group: VerifiedGroup, now: number) {
  return env.DB.prepare(
    "INSERT INTO google_groups(id,customer_id,email,name,last_verified_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id,email=excluded.email,name=excluded.name,last_verified_at=excluded.last_verified_at",
  ).bind(group.id, group.customer_id, group.email, group.name, now);
}
export const membershipUnavailable = () =>
  new ApiError(
    503,
    "group_membership_unavailable",
    "Google Group membership could not be refreshed; try again shortly",
  );
export async function requireResolvedGroupsForAggregate(env: Env, actor: Actor) {
  if (await groupMembershipUnavailable(env, actor)) throw membershipUnavailable();
}
const flights = new WeakMap<Env, Map<string, Promise<void>>>();
export async function refreshActorGroups(env: GroupsEnv, actor: Actor): Promise<Actor> {
  if (actor.principal.type !== "user") return actor;
  if (!googleGroupsEnabled(env)) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM google_group_memberships WHERE user_id=?").bind(
        actor.principal.id,
      ),
      env.DB.prepare(
        "DELETE FROM google_group_membership_snapshots WHERE user_id=?",
      ).bind(actor.principal.id),
    ]);
    return actor;
  }
  const now = Date.now();
  const id = actor.principal.id;
  const snapshot = await env.DB.prepare(
    "SELECT customer_id,last_success_at,last_attempt_at,last_error_code FROM google_group_membership_snapshots WHERE user_id=?",
  )
    .bind(id)
    .first<{
      customer_id: string;
      last_success_at: number;
      last_attempt_at: number;
      last_error_code: string;
    }>();
  if (
    snapshot &&
    snapshot.customer_id === env.GOOGLE_GROUPS_CUSTOMER_ID &&
    snapshot.last_success_at > 0 &&
    snapshot.last_success_at <= now &&
    now - snapshot.last_success_at < 60000
  )
    return actor;
  if (snapshot && snapshot.customer_id !== env.GOOGLE_GROUPS_CUSTOMER_ID) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM google_group_memberships WHERE user_id=?").bind(id),
      env.DB.prepare(
        "DELETE FROM google_group_membership_snapshots WHERE user_id=?",
      ).bind(id),
    ]);
  }
  if (
    snapshot &&
    snapshot.customer_id === env.GOOGLE_GROUPS_CUSTOMER_ID &&
    snapshot.last_error_code &&
    snapshot.last_attempt_at > snapshot.last_success_at &&
    snapshot.last_attempt_at <= now &&
    now - snapshot.last_attempt_at < 5000
  )
    return actor;
  let pending = flights.get(env);
  if (!pending) {
    pending = new Map();
    flights.set(env, pending);
  }
  let flight = pending.get(id);
  if (!flight) {
    flight = (async () => {
      try {
        // Use the stored identity, never an internal caller's supplied email.
        const user = await env.DB.prepare(
          "SELECT email FROM users WHERE id=? AND provider!='service_account'",
        )
          .bind(id)
          .first<{ email: string }>();
        if (!user) throw new DirectoryError("invalid_member");
        const groups = await transitiveGoogleGroups(env, user.email);
        const synced = Date.now();
        await env.DB.batch([
          ...groups.map((group) => upsertGoogleGroup(env, group, synced)),
          env.DB.prepare("DELETE FROM google_group_memberships WHERE user_id=?").bind(
            id,
          ),
          ...groups.map((group) =>
            env.DB.prepare(
              "INSERT INTO google_group_memberships(user_id,group_id) VALUES (?,?)",
            ).bind(id, group.id),
          ),
          env.DB.prepare(
            "INSERT INTO google_group_membership_snapshots(user_id,customer_id,last_success_at,last_attempt_at,last_error_code) VALUES (?,?,?,?,'') ON CONFLICT(user_id) DO UPDATE SET customer_id=excluded.customer_id,last_success_at=excluded.last_success_at,last_attempt_at=excluded.last_attempt_at,last_error_code=''",
          ).bind(id, env.GOOGLE_GROUPS_CUSTOMER_ID ?? "", synced, synced),
        ]);
      } catch (error) {
        await env.DB.prepare(
          "INSERT INTO google_group_membership_snapshots(user_id,customer_id,last_attempt_at,last_error_code) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET customer_id=excluded.customer_id,last_attempt_at=excluded.last_attempt_at,last_error_code=excluded.last_error_code",
        )
          .bind(
            id,
            env.GOOGLE_GROUPS_CUSTOMER_ID ?? "",
            Date.now(),
            error instanceof DirectoryError ? error.code : "unavailable",
          )
          .run();
      }
    })().finally(() => pending.delete(id));
    pending.set(id, flight);
  }
  await flight;
  return actor;
}
export async function groupMembershipUnavailable(
  env: GroupsEnv,
  actor: Actor,
): Promise<boolean> {
  if (actor.principal.type !== "user" || !googleGroupsEnabled(env)) return false;
  const snapshot = await env.DB.prepare(
    "SELECT customer_id,last_success_at FROM google_group_membership_snapshots WHERE user_id=?",
  )
    .bind(actor.principal.id)
    .first<{ customer_id: string; last_success_at: number }>();
  const now = Date.now();
  return (
    !snapshot ||
    snapshot.customer_id !== env.GOOGLE_GROUPS_CUSTOMER_ID ||
    snapshot.last_success_at <= 0 ||
    snapshot.last_success_at > now ||
    now - snapshot.last_success_at >= 60000
  );
}
