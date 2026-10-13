import type { UserPrincipal, Principal } from "../../shared/contracts";
export type ServiceAccountPrincipal = Omit<Principal, "type"> & {
  type: "service_account";
};
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
  ADMIN_USERS?: string;
  RENDER_PRIVATE_KEY: string;
  RENDER_PUBLIC_KEY: string;
  DEFAULT_DOC_PERMISSION?: string;
  MAX_HTML_BYTES?: string;
  BRIDGE_JS?: string;
  DEPLOYMENT?: string;
  ORG_NAME?: string;
  FEATURED_SECTIONS?: string;
  LABELS_ENABLED?: string;
  GOOGLE_GROUPS_ENABLED?: string;
  GOOGLE_GROUPS_CUSTOMER_ID?: string;
  GOOGLE_GROUPS_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_GROUPS_ACCESS_TOKEN?: string;
  GOOGLE_GROUPS_FETCHER?: Pick<Fetcher, "fetch">;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_FETCHER?: Pick<Fetcher, "fetch">;
  DOCUMENT_REALTIME?: DurableObjectNamespace;
  DOCUMENT_SEARCH?: DurableObjectNamespace;
  NOTIFICATION_DELIVERY?: DurableObjectNamespace;
  SLASHDOCS_SLACK_BOT_TOKEN?: string;
  OIDC_ISSUER_URL?: string;
  OIDC_INTERNAL_ISSUER_URL?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_PROVIDER_NAME?: string;
  SLASHDOCS_OIDC_ISSUER_URL?: string;
  SLASHDOCS_OIDC_INTERNAL_ISSUER_URL?: string;
  SLASHDOCS_OIDC_CLIENT_ID?: string;
  SLASHDOCS_OIDC_CLIENT_SECRET?: string;
  SLASHDOCS_OIDC_PROVIDER_NAME?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
}
export interface Actor {
  principal: UserPrincipal | ServiceAccountPrincipal;
  credentialKind: "session" | "cli" | "service_account" | "mcp";
  credentialId?: string;
}
export type AppEnv = {
  Bindings: Env;
  Variables: { actor: Actor };
};
export type Role = "viewer" | "commenter" | "editor" | "owner";
