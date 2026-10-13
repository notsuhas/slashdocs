import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { Env } from "../env";
import { ApiError } from "../../../shared/errors";
export const GOOGLE_ISSUER = "https://accounts.google.com";
export type OIDCSettings = {
  issuer: string;
  internalIssuer: string;
  clientId: string;
  clientSecret: string;
  providerName: string;
};
export function oidcSettings(env: Env): OIDCSettings {
  const googleId = env.GOOGLE_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID || "";
  const googleSecret = env.GOOGLE_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  const issuer = env.SLASHDOCS_OIDC_ISSUER_URL || "";
  const internalIssuer = env.SLASHDOCS_OIDC_INTERNAL_ISSUER_URL || "";
  const clientId = env.SLASHDOCS_OIDC_CLIENT_ID || "";
  const clientSecret = env.SLASHDOCS_OIDC_CLIENT_SECRET || "";
  const generic = !!(issuer || internalIssuer || clientId || clientSecret);
  if (
    (generic && (googleId || googleSecret)) ||
    (generic ? !issuer || !clientId || !clientSecret : !googleId || !googleSecret)
  )
    throw new ApiError(
      503,
      "unavailable",
      "Configure one complete OIDC login provider",
    );
  return {
    issuer: generic ? issuer : GOOGLE_ISSUER,
    internalIssuer,
    clientId: generic ? clientId : googleId,
    clientSecret: generic ? clientSecret : googleSecret,
    providerName: env.SLASHDOCS_OIDC_PROVIDER_NAME || (generic ? "SSO" : "Google"),
  };
}
export function rebaseURL(value: string, from: string, to: string): string {
  from = from.replace(/\/$/, "");
  to = to.replace(/\/$/, "");
  return value === from || value.startsWith(`${from}/`)
    ? to + value.slice(from.length)
    : value;
}
const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
});
export async function oidcProvider(env: Env) {
  const settings = oidcSettings(env);
  if (settings.issuer === GOOGLE_ISSUER && !settings.internalIssuer)
    return {
      ...settings,
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      jwksURI: "https://www.googleapis.com/oauth2/v3/certs",
      algorithms: ["RS256"],
      authMethods: ["client_secret_post"],
    };
  const base = settings.internalIssuer || settings.issuer;
  const response = await fetch(
    `${base.replace(/\/$/, "")}/.well-known/openid-configuration`,
  );
  if (!response.ok) throw new ApiError(503, "unavailable", "OIDC discovery failed");
  const metadata = metadataSchema.parse(await response.json());
  if (metadata.issuer !== settings.issuer)
    throw new ApiError(503, "unavailable", "OIDC discovery issuer mismatch");
  return {
    ...settings,
    authorizationEndpoint: rebaseURL(
      metadata.authorization_endpoint,
      base,
      settings.issuer,
    ),
    tokenEndpoint: rebaseURL(metadata.token_endpoint, settings.issuer, base),
    jwksURI: rebaseURL(metadata.jwks_uri, settings.issuer, base),
    authMethods: metadata.token_endpoint_auth_methods_supported,
    algorithms: metadata.id_token_signing_alg_values_supported?.filter(
      (value) => value !== "none" && !value.startsWith("HS"),
    ) || ["RS256"],
  };
}
const identitySchema = z.object({
  sub: z.string().refine((value) => value.trim().length > 0),
  email: z.string().trim().min(1),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
  nonce: z.string().optional(),
});
export async function exchangeIdentity(
  provider: Awaited<ReturnType<typeof oidcProvider>>,
  code: string,
  redirectURI: string,
  nonce: string,
) {
  try {
    const methods = provider.authMethods;
    // Go oauth2 tries Basic first and retries in parameters when discovery
    // does not specify an authentication method.
    const basic = !methods || methods.includes("client_secret_basic");
    if (methods && !basic && !methods.includes("client_secret_post"))
      throw new Error("unsupported token endpoint authentication method");
    const exchange = (useBasic: boolean) => {
      const body = new URLSearchParams({
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectURI,
      });
      const headers = new Headers();
      if (useBasic) {
        const encode = (value: string) =>
          new URLSearchParams({ v: value }).toString().slice(2);
        headers.set(
          "Authorization",
          `Basic ${btoa(`${encode(provider.clientId)}:${encode(provider.clientSecret)}`)}`,
        );
      } else {
        body.set("client_id", provider.clientId);
        body.set("client_secret", provider.clientSecret);
      }
      return fetch(provider.tokenEndpoint, { method: "POST", headers, body });
    };
    const tokenSchema = z.object({ id_token: z.string().min(1) });
    let response = await exchange(basic);
    let token = tokenSchema.safeParse(await response.json().catch(() => null));
    if ((!response.ok || !token.success) && !methods) {
      response = await exchange(false);
      token = tokenSchema.safeParse(await response.json().catch(() => null));
    }
    if (!response.ok || !token.success) throw new Error("token exchange failed");
    const verified = await jwtVerify(
      token.data.id_token,
      createRemoteJWKSet(new URL(provider.jwksURI)),
      {
        issuer:
          provider.issuer === GOOGLE_ISSUER
            ? [GOOGLE_ISSUER, "accounts.google.com"]
            : provider.issuer,
        audience: provider.clientId,
        requiredClaims: ["exp"],
        algorithms: provider.algorithms,
      },
    );
    const identity = identitySchema.parse(verified.payload);
    if (identity.email_verified === false || identity.nonce !== nonce)
      throw new Error("invalid identity claims");
    return identity;
  } catch {
    throw new ApiError(401, "unauthorized", "OIDC login failed");
  }
}
export async function identityKeys(issuer: string, subject: string) {
  if (issuer === GOOGLE_ISSUER)
    return { id: `usr_google_${subject}`, provider: "google", subject };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`aidocs-oidc-subject-v1\0${issuer}\0${subject}`),
  );
  const namespace = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return {
    id: `usr_oidc_${namespace}`,
    provider: "oidc",
    subject: `oidc_sha256_${namespace}`,
  };
}
