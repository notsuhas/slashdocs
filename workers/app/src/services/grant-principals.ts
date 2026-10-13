import { z } from "zod";
import type { Env } from "../env";
import type { Principal } from "../../../shared/contracts";
import { ApiError } from "../../../shared/errors";
import { principalFromIdentity, type IdentityRow } from "./principals";
import { googleGroupsEnabled, lookupGoogleGroup, upsertGoogleGroup } from "./groups";
export const grantPrincipalSchema = z.object({
  type: z.enum(["user", "service_account", "google_group", "anyone"]),
  id: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
});
export const grantInputSchema = z.object({
  role: z.enum(["viewer", "commenter", "editor"]),
  address: z.string().optional(),
  principal: grantPrincipalSchema.optional(),
});
export async function canonicalGrantPrincipal(
  env: Env,
  type: Principal["type"],
  id: string,
): Promise<Principal> {
  if (type === "anyone") return { type, id: "" };
  if (type === "google_group") {
    const group = await env.DB.prepare(
      "SELECT id,email,name FROM google_groups WHERE id=?",
    )
      .bind(id)
      .first<{ id: string; email: string; name: string }>();
    return { type, id, ...(group ? { email: group.email, name: group.name } : {}) };
  }
  const row = await env.DB.prepare(
    "SELECT id,provider,email,name,picture_url FROM users WHERE id=? AND (provider='service_account')=?",
  )
    .bind(id, type === "service_account" ? 1 : 0)
    .first<IdentityRow>();
  if (!row) throw new ApiError(404, "not_found", "Principal not found");
  return principalFromIdentity(row);
}
export async function resolveGrantPrincipal(
  env: Env,
  input: Pick<z.infer<typeof grantInputSchema>, "address" | "principal">,
): Promise<Principal> {
  let type = input.principal?.type ?? "user";
  if (type === "anyone") return { type, id: "" };
  if (type === "google_group") {
    if (!googleGroupsEnabled(env))
      throw new ApiError(400, "bad_request", "Google Group sharing is disabled");
    if (!input.principal?.email?.trim())
      throw new ApiError(400, "bad_request", "Select a verified Google Group result");
    const group = await lookupGoogleGroup(env, input.principal.email);
    await upsertGoogleGroup(env, group, Date.now()).run();
    return { type, id: group.id, email: group.email, name: group.name };
  }
  let email = input.principal?.email;
  let name = input.principal?.name;
  let id = input.principal?.id;
  if (input.address) {
    const parts = input.address.split("@");
    if (parts.length !== 2 || !parts[0] || !parts[1])
      throw new ApiError(
        400,
        "bad_request",
        "That doesn't look like an email or bot address.",
      );
    type = parts[1].endsWith(".bot") ? "service_account" : "user";
    id = undefined;
    if (type === "service_account") name = input.address;
    else email = input.address;
  }
  if (type === "user" && !id && email) {
    // Resolve only the configured human provider, matching Go's UserByEmail.
    const provider =
      env.SLASHDOCS_OIDC_ISSUER_URL &&
      env.SLASHDOCS_OIDC_ISSUER_URL !== "https://accounts.google.com"
        ? "oidc"
        : "google";
    const row = await env.DB.prepare(
      "SELECT id,provider,email,name,picture_url FROM users WHERE lower(email)=lower(?) AND provider=? ORDER BY created_at,id LIMIT 1",
    )
      .bind(email, provider)
      .first<IdentityRow>();
    if (!row)
      throw new ApiError(
        400,
        "bad_request",
        "No slashdocs user exists for that email. Ask them to sign in once, then try again.",
      );
    return principalFromIdentity(row);
  }
  if (type === "service_account" && !id && name) {
    const row = await env.DB.prepare(
      "SELECT u.id,u.provider,u.name FROM service_accounts sa JOIN users u ON u.id=sa.id WHERE sa.name=?",
    )
      .bind(name)
      .first<IdentityRow>();
    if (!row) throw new ApiError(404, "not_found", "Principal not found");
    return principalFromIdentity(row);
  }
  if (!id)
    throw new ApiError(
      400,
      "bad_request",
      "principal id, user email, or service account name is required",
    );
  return canonicalGrantPrincipal(env, type, id);
}
