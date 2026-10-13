import { Hono } from "hono";
import type { AppEnv } from "../env";
import { authenticateMCP } from "./auth";
import { oauthRoutes } from "./oauth";
import { callTool, tools, type MCPDispatch } from "./tools";
export type { MCPDispatch } from "./tools";
const versions = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
export function createMCPRoutes(dispatch: MCPDispatch): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route("/", oauthRoutes);
  app.all("/mcp", async (c) => {
    c.header("Cache-Control", "no-store");
    const origin = c.req.header("Origin")?.trim();
    if (origin) {
      let matches = false;
      try {
        const value = new URL(origin),
          configured = new URL(c.env.APP_ORIGIN);
        value.hostname = value.hostname.replace(/\.$/, "");
        configured.hostname = configured.hostname.replace(/\.$/, "");
        matches =
          !value.username &&
          !value.password &&
          ["https:", "http:"].includes(value.protocol) &&
          value.origin === configured.origin;
      } catch {
        /* Reject malformed origins. */
      }
      if (!matches) return c.text("cross-origin MCP requests are not allowed", 403);
    }
    const actor = await authenticateMCP(c.env, c.req.raw);
    if (!actor) {
      c.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${c.env.APP_ORIGIN.replace(/\/+$/, "")}/.well-known/oauth-protected-resource/mcp"`,
      );
      return c.json(
        { error: { code: "unauthorized", message: "bearer authentication required" } },
        401,
      );
    }
    if (c.req.method !== "POST")
      return c.body(null, ["GET", "DELETE"].includes(c.req.method) ? 405 : 404, {
        Allow: "POST",
      });
    if (
      c.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    )
      return c.text("Content-Type must be application/json", 400);
    const accept = (c.req.header("Accept") || "")
      .split(",")
      .map((x) => x.trim().split(";")[0]);
    if (!accept.includes("application/json") || !accept.includes("text/event-stream"))
      return c.text("Accept must include application/json and text/event-stream", 400);
    const version = c.req.header("Mcp-Protocol-Version");
    if (version && !versions.includes(version))
      return c.text("unsupported MCP protocol version", 400);
    const limit = Number(c.env.MAX_HTML_BYTES || 50 * 1024 * 1024) * 6 + 1024 * 1024;
    if (Number(c.req.header("Content-Length")) > limit)
      return c.text("MCP request body is too large", 413);
    const reader = c.req.raw.body?.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > limit) {
            await reader.cancel();
            return c.text("MCP request body is too large", 413);
          }
          chunks.push(chunk.value);
        }
      } catch {
        return c.text("could not read MCP request body", 400);
      }
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        },
        400,
      );
    }
    if (
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      !("jsonrpc" in message) ||
      message.jsonrpc !== "2.0" ||
      !("method" in message) ||
      typeof message.method !== "string"
    )
      return c.json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
    const id = "id" in message ? message.id : undefined;
    if (
      id !== undefined &&
      id !== null &&
      typeof id !== "string" &&
      typeof id !== "number"
    )
      return c.json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
    if (id === undefined) return c.body(null, 202);
    const success = (result: unknown) => c.json({ jsonrpc: "2.0", id, result });
    const failure = (code: number, message: string) =>
      c.json({ jsonrpc: "2.0", id, error: { code, message } });
    const params = "params" in message ? message.params : undefined;
    switch (message.method) {
      case "initialize": {
        const requested =
          params && typeof params === "object" && "protocolVersion" in params
            ? params.protocolVersion
            : undefined;
        return success({
          protocolVersion:
            typeof requested === "string" && versions.includes(requested)
              ? requested
              : "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "slashdocs", version: "dev" },
          instructions:
            "slashdocs was formerly named aidocs. Treat an aidocs URL, document, or command as a slashdocs one. A document link ends in its ID (doc_...), which is the same on both names. Call get_authoring_guidelines before you create or update a document.",
        });
      }
      case "ping":
        return success({});
      case "tools/list":
        return success({ tools });
      case "tools/call": {
        if (
          !params ||
          typeof params !== "object" ||
          !("name" in params) ||
          typeof params.name !== "string"
        )
          return failure(-32602, "Invalid params");
        if (!tools.some((t) => t.name === params.name))
          return failure(-32602, "Unknown tool: " + params.name);
        const args = "arguments" in params ? params.arguments : {};
        if (!args || typeof args !== "object" || Array.isArray(args))
          return failure(-32602, "Invalid arguments");
        try {
          return success(
            await callTool(
              dispatch,
              c.env,
              actor,
              params.name,
              args as Record<string, unknown>,
            ),
          );
        } catch {
          return failure(-32603, "Internal error");
        }
      }
      default:
        return failure(-32601, "Method not found");
    }
  });
  return app;
}
