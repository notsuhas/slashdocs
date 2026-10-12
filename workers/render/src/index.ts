import { verifyRenderCapability } from "../../shared/render-capability";
import type { RenderEnv } from "./env";
import { renderWrapperHTML } from "./wrapper";

function headers(appOrigin?: string): Headers {
  const result = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  result.set(
    "Content-Security-Policy",
    `frame-ancestors ${appOrigin || "'none'"}; object-src 'none'`,
  );
  return result;
}

export default {
  async fetch(request: Request, env: RenderEnv): Promise<Response> {
    const url = new URL(request.url);
    let app: URL;
    try {
      app = new URL(env.APP_ORIGIN);
      if (
        !["https:", "http:"].includes(app.protocol) ||
        app.origin !== env.APP_ORIGIN ||
        app.hostname.replace(/\.$/, "") === url.hostname.replace(/\.$/, "")
      )
        throw new Error("unsafe origin");
    } catch {
      return new Response("Render origin must be isolated", {
        status: 500,
        headers: headers(),
      });
    }
    const responseHeaders = headers(app.origin);
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", {
        status: 405,
        headers: responseHeaders,
      });
    const path = /^\/(v|print)\/(doc_[a-z2-7]+)\/(ver_[a-z2-7]+)$/.exec(url.pathname);
    if (!path)
      return new Response("Not found", { status: 404, headers: responseHeaders });
    const audience = path[1] === "print" ? "print" : "render";
    const token = url.searchParams.get("token");
    if (!token)
      return new Response("Render capability required", {
        status: 403,
        headers: responseHeaders,
      });
    let capability;
    try {
      capability = await verifyRenderCapability(env.RENDER_PUBLIC_KEY, token, audience);
      if (capability.document_id !== path[2] || capability.version_id !== path[3])
        throw new Error("scope mismatch");
    } catch (error) {
      console.warn("render_capability_rejected", {
        reason: error instanceof Error ? error.name : "UnknownError",
      });
      return new Response("Invalid render capability", {
        status: 403,
        headers: responseHeaders,
      });
    }
    const object = await env.DOCUMENTS.get(capability.object_key);
    if (!object)
      return new Response("Not found", { status: 404, headers: responseHeaders });
    const html = renderWrapperHTML(
      await object.text(),
      app.origin,
      audience === "print",
    );
    return new Response(request.method === "HEAD" ? null : html, {
      headers: responseHeaders,
    });
  },
};
