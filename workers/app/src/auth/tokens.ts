import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv } from "../env";
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function hashToken(value: string): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export function cookieName(c: Context<AppEnv>, suffix = "session"): string {
  return `${new URL(c.env.APP_ORIGIN).protocol === "https:" ? "__Host-" : ""}slashdocs_${suffix}`;
}
export function writeCookie(
  c: Context<AppEnv>,
  name: string,
  value: string,
  maxAge: number,
): void {
  setCookie(c, name, value, {
    path: "/",
    httpOnly: true,
    secure: new URL(c.env.APP_ORIGIN).protocol === "https:",
    sameSite: "Lax",
    maxAge,
  });
}
export function sessionToken(c: Context<AppEnv>): string | undefined {
  return getCookie(c, cookieName(c));
}
