import type { Env } from "../env";
export function emailAllowed(
  email: string,
  env: Pick<Env, "ALLOWED_EMAILS" | "ALLOWED_DOMAINS">,
): boolean {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) return false;
  const list = (value?: string) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  return (
    list(env.ALLOWED_EMAILS).includes(normalized) ||
    list(env.ALLOWED_DOMAINS).includes(normalized.split("@")[1])
  );
}
export function safeRedirect(value: string): boolean {
  return (
    value === "" ||
    (value.startsWith("/") &&
      !value.startsWith("//") &&
      !/[\\\x00-\x20\x7f]/.test(value))
  );
}
export function loopbackRedirectAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
      !!url.port &&
      !url.username &&
      !url.password &&
      url.pathname === "/callback" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
