import type { UserPrincipal } from "../../shared/contracts";
export interface Env {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  ASSETS: Pick<Fetcher, "fetch">;
  APP_ORIGIN: string;
  RENDER_ORIGIN: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ALLOWED_EMAILS?: string;
  ALLOWED_DOMAINS?: string;
  SESSION_SECRET: string;
  RENDER_PRIVATE_KEY: string;
  RENDER_PUBLIC_KEY: string;
  DEFAULT_DOC_PERMISSION?: string;
  MAX_HTML_BYTES?: string;
  BRIDGE_JS?: string;
  DEPLOYMENT?: string;
  ORG_NAME?: string;
}
export interface Actor {
  principal: UserPrincipal;
  credentialKind: "session" | "cli";
  credentialId?: string;
}
export type AppEnv = { Bindings: Env; Variables: { actor: Actor } };
export type Role = "viewer" | "commenter" | "editor" | "owner";
