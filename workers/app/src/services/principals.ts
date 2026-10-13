import type { Principal } from "../../../shared/contracts";
import type { Env } from "../env";
import { ApiError } from "../../../shared/errors";
export interface IdentityRow {
  id: string;
  provider?: string;
  email?: string | null;
  name?: string | null;
  picture_url?: string | null;
}
export function principalFromIdentity(row: IdentityRow): Principal {
  if (row.provider === "service_account")
    return { type: "service_account", id: row.id, name: row.name ?? "" };
  return {
    type: "user",
    id: row.id,
    ...(row.email ? { email: row.email } : {}),
    ...(row.name ? { name: row.name } : {}),
    ...(row.picture_url ? { picture_url: row.picture_url } : {}),
  };
}
export async function lookupPrincipal(env: Env, id: string): Promise<Principal> {
  const row = await env.DB.prepare(
    "SELECT id,provider,email,name,picture_url FROM users WHERE id=?",
  )
    .bind(id)
    .first<IdentityRow>();
  if (!row) throw new ApiError(404, "not_found", "Principal not found");
  return principalFromIdentity(row);
}
