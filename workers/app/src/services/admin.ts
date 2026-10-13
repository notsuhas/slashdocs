import type { Env } from "../env";
import type { Principal } from "../../../shared/contracts";
export function isAdmin(env: Env, user: Principal): boolean {
  return (
    user.type === "user" &&
    !!user.email &&
    (env.ADMIN_USERS ?? "")
      .split(",")
      .some((email) => email.trim().toLowerCase() === user.email?.toLowerCase())
  );
}

export async function pruneAdminObservations(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_activity WHERE day<?").bind(cutoff),
    env.DB.prepare("UPDATE admin_metadata SET last_cleanup_day=? WHERE id=1").bind(
      new Date().toISOString().slice(0, 10),
    ),
  ]);
}
