import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../auth/middleware";
import { hashToken, nowSeconds, randomToken } from "../auth/tokens";
import { resource } from "./auth";
const bytes = (s: string) => new TextEncoder().encode(s).length;
async function limitedBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("Content-Length")) > 65536) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0,
    result = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        return null;
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } catch {
    return null;
  }
}
const pkce = (s: string) => /^[A-Za-z0-9._~-]{43,128}$/.test(s);
const error = (
  c: Context<AppEnv>,
  code: string,
  message: string,
  status: 400 | 403 | 415 = 400,
) => c.json({ error: code, error_description: message }, status);
const escapeHTML = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ||
      ch,
  );
function loopback(host: string) {
  return host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}
export function validRedirect(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.hash || !raw.includes(":")) return false;
    if (u.protocol === "https:") return !!u.host;
    if (u.protocol === "http:")
      return u.hostname === "localhost" || loopback(u.hostname);
    return (
      ![
        "javascript:",
        "data:",
        "file:",
        "blob:",
        "about:",
        "vbscript:",
        "filesystem:",
        "chrome:",
        "chrome-extension:",
      ].includes(u.protocol) && raw.slice(u.protocol.length).startsWith("/")
    );
  } catch {
    return false;
  }
}
export function redirectMatches(registered: string[], raw: string): boolean {
  if (registered.includes(raw)) return true;
  try {
    const req = new URL(raw);
    if (!loopback(req.hostname)) return false;
    return registered.some((v) => {
      const reg = new URL(v);
      return (
        loopback(reg.hostname) &&
        reg.protocol === req.protocol &&
        reg.hostname === req.hostname &&
        reg.pathname === req.pathname &&
        reg.search === req.search &&
        !req.hash &&
        !req.username &&
        !req.password
      );
    });
  } catch {
    return false;
  }
}
export const oauthRoutes = new Hono<AppEnv>();
oauthRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
for (const path of [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
])
  oauthRoutes.get(path, (c) =>
    c.json({
      resource: resource(c.env),
      authorization_servers: [c.env.APP_ORIGIN.replace(/\/+$/, "")],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    }),
  );
for (const path of [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
])
  oauthRoutes.get(path, (c) => {
    const origin = c.env.APP_ORIGIN.replace(/\/+$/, "");
    return c.json({
      issuer: origin,
      authorization_endpoint: origin + "/oauth/authorize",
      token_endpoint: origin + "/oauth/token",
      registration_endpoint: origin + "/oauth/register",
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp"],
    });
  });
oauthRoutes.post("/oauth/register", async (c) => {
  if (
    c.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    return c.json(
      {
        error: {
          code: "unsupported_media_type",
          message: "content-type must be application/json",
        },
      },
      415,
    );
  const text = await limitedBody(c.req.raw);
  if (text === null) return error(c, "invalid_client_metadata", "request too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return error(c, "invalid_client_metadata", "invalid client registration");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return error(c, "invalid_client_metadata", "invalid client registration");
  const inValue = value as Record<string, unknown>;
  const name =
    inValue.client_name == null
      ? "MCP client"
      : typeof inValue.client_name === "string"
        ? inValue.client_name.trim() || "MCP client"
        : "";
  const redirects = inValue.redirect_uris;
  if (
    !name ||
    bytes(name) > 128 ||
    !Array.isArray(redirects) ||
    redirects.length < 1 ||
    redirects.length > 10 ||
    !redirects.every(
      (s): s is string => typeof s === "string" && bytes(s) <= 1024 && validRedirect(s),
    )
  )
    return error(c, "invalid_client_metadata", "invalid name or redirect_uris");
  if (
    inValue.token_endpoint_auth_method != null &&
    inValue.token_endpoint_auth_method !== "" &&
    inValue.token_endpoint_auth_method !== "none"
  )
    return error(c, "invalid_client_metadata", "only public clients are supported");
  const grants = inValue.grant_types;
  const responses = inValue.response_types;
  if (
    grants != null &&
    (!Array.isArray(grants) ||
      (grants.length > 0 &&
        (!grants.includes("authorization_code") ||
          grants.some((g) => g !== "authorization_code" && g !== "refresh_token"))))
  )
    return error(
      c,
      "invalid_client_metadata",
      "the authorization_code grant is required",
    );
  if (
    responses != null &&
    (!Array.isArray(responses) ||
      (responses.length > 0 && (responses.length !== 1 || responses[0] !== "code")))
  )
    return error(c, "invalid_client_metadata", "only code is supported");
  const encode = (value: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(value)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  const registrationJSON = JSON.stringify({ name, redirect_uris: redirects }).replace(
    /[<>&]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  const signedPayload = encode(
    JSON.stringify({
      sub: encode(registrationJSON),
      aud: "mcp-client-registration",
      exp: nowSeconds() + 365 * 86400,
    }),
  );
  if ("slashdocs_mcp_client_v1.".length + signedPayload.length + 1 + 43 > 2048)
    return error(
      c,
      "invalid_client_metadata",
      "client metadata produces an oversized client_id",
    );
  const id = "slashdocs_mcp_client_" + randomToken();
  await c.env.DB.prepare("INSERT INTO mcp_clients VALUES (?,?,?,?)")
    .bind(id, name, JSON.stringify(redirects), nowSeconds() + 365 * 86400)
    .run();
  return c.json(
    {
      client_id: id,
      client_id_issued_at: nowSeconds(),
      client_secret_expires_at: 0,
      client_name: name,
      redirect_uris: redirects,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    201,
  );
});
oauthRoutes.use("/oauth/authorize", requireAuth);
oauthRoutes.on(["GET", "POST"], "/oauth/authorize", async (c) => {
  const actor = c.get("actor");
  if (actor.principal.type !== "user")
    return error(
      c,
      "access_denied",
      "MCP browser authorization requires a user account",
      403,
    );
  const post = c.req.method === "POST";
  if (post && c.req.header("Origin") !== new URL(c.env.APP_ORIGIN).origin)
    return error(c, "access_denied", "invalid request origin", 403);
  const text = post ? await limitedBody(c.req.raw) : "";
  if (text === null) return error(c, "invalid_request", "request too large");
  const params = post ? new URLSearchParams(text) : new URL(c.req.url).searchParams;
  const fields = Object.fromEntries(
    [
      "client_id",
      "redirect_uri",
      "response_type",
      "code_challenge",
      "code_challenge_method",
      "resource",
      "scope",
      "state",
    ].map((k) => [k, params.get(k) || ""]),
  );
  const client = await c.env.DB.prepare(
    "SELECT name,redirect_uris FROM mcp_clients WHERE id=? AND expires_at>?",
  )
    .bind(fields.client_id, nowSeconds())
    .first<{ name: string; redirect_uris: string }>();
  if (
    !client ||
    !redirectMatches(JSON.parse(client.redirect_uris), fields.redirect_uri) ||
    fields.response_type !== "code" ||
    fields.code_challenge_method !== "S256" ||
    !pkce(fields.code_challenge) ||
    fields.resource !== resource(c.env) ||
    (fields.scope !== "" && fields.scope !== "mcp")
  )
    return error(
      c,
      "invalid_request",
      "invalid client, redirect, PKCE, resource, or scope",
    );
  fields.scope ||= "mcp";
  const frozen = JSON.stringify(fields);
  if (!post) {
    const nonce = randomToken();
    await c.env.DB.prepare("INSERT INTO mcp_consent VALUES (?,?,?,?)")
      .bind(await hashToken(nonce), actor.principal.id, frozen, nowSeconds() + 300)
      .run();
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "same-origin");
    return c.html(
      `<!doctype html><html lang="en"><title>Connect to slashdocs</title><body><h1>Connect ${escapeHTML(client.name)}?</h1><p>Access goes to ${escapeHTML(fields.redirect_uri)}. The client name is self-reported and is not verified.</p><p>This gives the client access to slashdocs as ${escapeHTML(actor.principal.email || actor.principal.name || actor.principal.id)}. It can read and change the same documents, comments, folders, sharing settings, and service accounts that you can.</p><form method="post" action="/oauth/authorize">${Object.entries(
        { ...fields, nonce },
      )
        .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHTML(v)}">`)
        .join(
          "",
        )}<button name="decision" value="deny">Cancel</button><button name="decision" value="approve">Connect</button></form></body></html>`,
    );
  }
  const consent = await c.env.DB.prepare(
    "DELETE FROM mcp_consent WHERE nonce_hash=? RETURNING user_id,request_json,expires_at",
  )
    .bind(await hashToken(params.get("nonce") || ""))
    .first<{ user_id: string; request_json: string; expires_at: number }>();
  if (
    !consent ||
    consent.user_id !== actor.principal.id ||
    consent.request_json !== frozen ||
    consent.expires_at <= nowSeconds()
  )
    return error(c, "access_denied", "invalid or expired consent nonce", 403);
  const redirect = new URL(fields.redirect_uri);
  if (fields.state) redirect.searchParams.set("state", fields.state);
  if (params.get("decision") !== "approve")
    redirect.searchParams.set("error", "access_denied");
  else {
    const code = randomToken();
    await c.env.DB.prepare("INSERT INTO mcp_codes VALUES (?,?,?,?,?,?,?,?)")
      .bind(
        await hashToken(code),
        actor.principal.id,
        fields.client_id,
        fields.redirect_uri,
        fields.resource,
        fields.scope,
        fields.code_challenge,
        nowSeconds() + 300,
      )
      .run();
    redirect.searchParams.set("code", code);
  }
  return c.redirect(redirect.toString());
});
oauthRoutes.post("/oauth/token", async (c) => {
  if (
    !c.req
      .header("Content-Type")
      ?.toLowerCase()
      .startsWith("application/x-www-form-urlencoded")
  )
    return error(c, "invalid_request", "token requests must be form encoded", 415);
  const text = await limitedBody(c.req.raw);
  if (text === null) return error(c, "invalid_request", "request too large");
  const p = new URLSearchParams(text);
  if (p.get("grant_type") !== "authorization_code")
    return error(c, "unsupported_grant_type", "only authorization_code is supported");
  if (
    ["code", "code_verifier", "client_id", "redirect_uri", "resource"].some(
      (k) => !p.get(k),
    )
  )
    return error(
      c,
      "invalid_request",
      "code, code_verifier, client_id, redirect_uri, and resource are required",
    );
  const client = await c.env.DB.prepare(
    "SELECT id FROM mcp_clients WHERE id=? AND expires_at>?",
  )
    .bind(p.get("client_id"), nowSeconds())
    .first();
  if (!client) return error(c, "invalid_client", "unknown or expired client_id");
  const grant = await c.env.DB.prepare(
    "DELETE FROM mcp_codes WHERE code_hash=? RETURNING *",
  )
    .bind(await hashToken(p.get("code") || ""))
    .first<{
      user_id: string;
      client_id: string;
      redirect_uri: string;
      resource: string;
      scope: string;
      challenge: string;
      expires_at: number;
    }>();
  if (
    !grant ||
    grant.expires_at <= nowSeconds() ||
    grant.client_id !== p.get("client_id") ||
    grant.redirect_uri !== p.get("redirect_uri") ||
    grant.resource !== p.get("resource") ||
    grant.resource !== resource(c.env) ||
    !pkce(p.get("code_verifier") || "") ||
    grant.challenge !== (await hashToken(p.get("code_verifier") || ""))
  )
    return error(
      c,
      "invalid_grant",
      "authorization code is invalid, expired, or does not match the PKCE request",
    );
  const token = "slashdocs_mcp_" + randomToken();
  await c.env.DB.prepare("INSERT INTO mcp_tokens VALUES (?,?,?,?,?)")
    .bind(
      await hashToken(token),
      grant.user_id,
      grant.resource,
      grant.scope,
      nowSeconds() + 3600,
    )
    .run();
  c.header("Pragma", "no-cache");
  return c.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: 3600,
    scope: grant.scope,
  });
});
