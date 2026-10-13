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
