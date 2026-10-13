import inventory from "./tools.json";
import pages from "./guidelines.json";
import type { Actor, Env } from "../env";
export type MCPDispatch = (
  env: Env,
  actor: Actor,
  request: Request,
) => Promise<Response>;
export const tools = inventory;
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
};
export const textResult = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});
const jsonResult = (value: unknown, isError = false): ToolResult => ({
  ...textResult(JSON.stringify(value), isError),
  structuredContent: value,
});
export async function responseResult(
  response: Response,
  plain = false,
): Promise<ToolResult> {
  const body = await response.text();
  if (!body && response.ok) return jsonResult({ ok: true });
  if (
    response.ok &&
    (plain || !response.headers.get("Content-Type")?.includes("application/json"))
  )
    return textResult(body);
  try {
    const value: unknown = JSON.parse(body);
    if (value !== null || response.ok) return jsonResult(value, !response.ok);
  } catch (error) {
    if (response.ok)
      return textResult(
        "could not decode server response: " +
          (error instanceof Error ? error.message : "invalid JSON"),
        true,
      );
  }
  return textResult(
    `HTTP ${response.status}: ${body.trim() || response.statusText}`,
    true,
  );
}
function guidelines(section: string): ToolResult {
  const normalize = (s: string) =>
    s.toLowerCase().trim().replaceAll("_", "-").split(/\s+/).join(" ");
  const path = normalize(section);
  const index =
    "slashdocs document authoring guidelines\n\nFetch a section for details by calling get_authoring_guidelines with its path:\n" +
    pages
      .map(
        (p) =>
          `  section=${JSON.stringify(p.Path.join(" ")).padEnd(22)} ${p.Summary}\n`,
      )
      .join("") +
    '\nsection="all" returns every section at once.\n';
  if (!path) return textResult(index);
  if (path === "all")
    return textResult(index + pages.map((p) => "\n---\n\n" + p.Body).join(""));
  const page = pages.find(
    (p) =>
      p.Path.join(" ") === path ||
      p.Aliases?.some((a) => normalize(a.join(" ")) === path),
  );
  return page
    ? textResult(
        page.Body +
          '\nAny `slashdocs guidelines <path>` reference above is a section of this tool: call get_authoring_guidelines with section="<path>".\n',
      )
    : textResult(
        `unknown guidelines section ${JSON.stringify(section)}; available sections:\n${pages.map((p) => "  " + p.Path.join(" ")).join("\n")}\n  all`,
        true,
      );
}
export async function callTool(
  dispatch: MCPDispatch,
  env: Env,
  actor: Actor,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const definition = tools.find((t) => t.name === name);
  if (!definition) return textResult("Unknown tool: " + name, true);
  for (const key of definition.inputSchema.required || [])
    if (typeof args[key] !== "string")
      return textResult(
        key in args
          ? `argument "${key}" is not a string`
          : `required argument "${key}" not found`,
        true,
      );
  const str = (key: string, fallback = "") =>
    typeof args[key] === "string" ? args[key] : fallback;
  const boolean = (key: string) => {
    const value = args[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string")
      return ["1", "t", "T", "TRUE", "true", "True"].includes(value);
    return false;
  };
  const id = (key: string) => encodeURIComponent(str(key));
  const doc = "/v1/documents/" + id("document_id"),
    folder = "/v1/folders/" + id("folder_id"),
    sa = "/v1/service-accounts/" + id("service_account_id");
  const comment = doc + "/comments/" + id("comment_id");
  const send = (method: string, path: string, body?: unknown) =>
    dispatch(
      env,
      actor,
      new Request(new URL(path, env.APP_ORIGIN), {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
    );
  const call = async (method: string, path: string, body?: unknown) =>
    responseResult(await send(method, path, body));
  const query = (path: string, fields: Record<string, string>) => {
    const q = new URLSearchParams(Object.entries(fields).filter(([, v]) => v !== ""));
    return path + (q.size ? "?" + q.toString() : "");
  };
  const multipart = async (path: string, fields: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set("file", new File([str("html")], "document.html", { type: "text/html" }));
    return dispatch(
      env,
      actor,
      new Request(new URL(path, env.APP_ORIGIN), { method: "POST", body: form }),
    );
  };
  const grant = () => {
    const address = str("address"),
      everyone = boolean("everyone");
    if ((address === "") === !everyone) return null;
    return {
      role: str("role", "viewer"),
      ...(everyone ? { principal: { type: "anyone" } } : { address }),
    };
  };
  switch (name) {
    case "whoami":
      return call("GET", "/v1/me");
    case "get_server_config":
      return call("GET", "/v1/config");
    case "get_authoring_guidelines":
      return guidelines(str("section"));
    case "list_documents":
      return call("GET", query("/v1/documents", { q: str("query") }));
    case "get_document":
      return call("GET", doc);
    case "create_document": {
      const response = await multipart("/v1/documents", { title: str("title") });
      if (response.status !== 201) return responseResult(response);
      const value: unknown = await response.json();
      if (
        value &&
        typeof value === "object" &&
        "default_grant" in value &&
        value.default_grant &&
        typeof value.default_grant === "object"
      ) {
        const g = value.default_grant;
        const role = "role" in g ? g.role : "viewer";
        const verb =
          role === "editor"
            ? "read, comment and edit it"
            : role === "commenter"
              ? "read and comment on it"
              : "read it";
        const revoke = `To make it private, call revoke_document_grant with grant_id ${"grant_id" in g ? g.grant_id : ""} on document ${"id" in value ? value.id : ""}.`;
        return jsonResult({
          ...value,
          warning:
            env.DEPLOYMENT === "public"
              ? `This document is shared by default: anyone with the link can ${verb}. Make sure your user knows it is publicly accessible. ${revoke}`
              : `This document is shared org-wide by default: anyone at ${env.ORG_NAME || "your org"} can ${verb}. Make sure your user knows this document is shared org-wide. ${revoke}`,
        });
      }
      return jsonResult(value);
    }
    case "rename_document":
      return call("PATCH", doc, { title: str("title") });
    case "delete_document":
      return call("DELETE", doc);
    case "move_document": {
      const dest = str("folder_id"),
        root = boolean("to_root");
      if ((dest === "") === !root)
        return textResult("pass exactly one of folder_id or to_root=true", true);
      if (dest)
        return call("POST", folder + "/documents", { document_id: str("document_id") });
      const response = await send("GET", doc);
      if (!response.ok) return responseResult(response);
      const metadata: unknown = await response.json();
      if (
        !metadata ||
        typeof metadata !== "object" ||
        !("parent_folder_id" in metadata) ||
        typeof metadata.parent_folder_id !== "string" ||
        !metadata.parent_folder_id
      )
        return textResult("document is already at the workspace root", true);
      return call(
        "DELETE",
        "/v1/folders/" +
          encodeURIComponent(metadata.parent_folder_id) +
          "/documents/" +
          id("document_id"),
      );
    }
    case "list_document_versions":
      return call("GET", doc + "/versions");
    case "get_document_version":
      return call("GET", doc + "/versions/" + id("version_id"));
    case "get_document_html": {
      let version = str("version_id");
      if (!version) {
        const response = await send("GET", doc);
        if (!response.ok) return responseResult(response);
        const meta: unknown = await response.json();
        if (
          !meta ||
          typeof meta !== "object" ||
          !("current_version_id" in meta) ||
          typeof meta.current_version_id !== "string" ||
          !meta.current_version_id
        )
          return textResult(
            "document response did not include current_version_id",
            true,
          );
        version = meta.current_version_id;
      }
      return responseResult(
        await send("GET", doc + "/versions/" + encodeURIComponent(version) + "/html"),
        true,
      );
    }
    case "update_document":
      return responseResult(
        await multipart(doc + "/versions", {
          base_version_id: str("base_version_id"),
          change_summary: str("change_summary"),
        }),
      );
    case "list_comments":
      return call(
        "GET",
        query(doc + "/comments", {
          status: str("status"),
          version_id: str("version_id"),
        }),
      );
    case "create_comment":
      return call("POST", doc + "/comments", {
        version_id: str("version_id"),
        body: str("body"),
        anchor: { quote: str("quote"), prefix: str("prefix"), suffix: str("suffix") },
      });
    case "reply_comment":
      return call("POST", comment + "/replies", { body: str("body") });
    case "update_comment": {
      const payload = {
        ...(str("body") ? { body: str("body") } : {}),
        ...(str("status") ? { status: str("status") } : {}),
      };
      return Object.keys(payload).length
        ? call("PATCH", comment, payload)
        : textResult("pass body and/or status", true);
    }
    case "delete_comment":
      return call("DELETE", comment);
    case "resolve_comment":
    case "reopen_comment":
      return call("PATCH", comment, {
        status: name === "resolve_comment" ? "resolved" : "open",
      });
    case "react_comment":
    case "unreact_comment":
      return call(
        name === "react_comment" ? "PUT" : "DELETE",
        comment + "/reactions/" + id("emoji"),
      );
    case "request_document_access":
      return call("POST", doc + "/access-requests", {});
    case "list_document_access":
      return call("GET", doc + "/access");
    case "share_document":
    case "share_folder": {
      const payload = grant();
      return payload
        ? call("POST", (name === "share_document" ? doc : folder) + "/grants", payload)
        : textResult("pass exactly one of address or everyone=true", true);
    }
    case "update_document_grant":
    case "update_folder_grant":
      return call(
        "PATCH",
        (name === "update_document_grant" ? doc : folder) + "/grants/" + id("grant_id"),
        { role: str("role") },
      );
    case "revoke_document_grant":
    case "revoke_folder_grant":
      return call(
        "DELETE",
        (name === "revoke_document_grant" ? doc : folder) + "/grants/" + id("grant_id"),
      );
    case "list_folders":
      return call(
        "GET",
        query("/v1/folders", { folder_id: str("folder_id"), path: str("path") }),
      );
    case "search_folders":
      return call("GET", query("/v1/folders", { q: str("query") }));
    case "get_folder":
      return call("GET", folder);
    case "create_folder":
      return call("POST", "/v1/folders", {
        title: str("title"),
        ...(str("parent_folder_id")
          ? { parent_folder_id: str("parent_folder_id") }
          : {}),
      });
    case "rename_folder":
      return call("PATCH", folder, { title: str("title") });
    case "move_folder":
      return call("PATCH", folder, { parent_folder_id: str("parent_folder_id") });
    case "delete_folder":
      return call("DELETE", folder);
    case "list_folder_access":
      return call("GET", folder + "/access");
    case "list_folder_documents":
      return call("GET", folder + "/documents");
    case "move_document_to_folder":
      return call("POST", folder + "/documents", { document_id: str("document_id") });
    case "move_document_to_root":
      return call("DELETE", folder + "/documents/" + id("document_id"));
    case "list_service_accounts":
      return call("GET", "/v1/service-accounts");
    case "update_service_account": {
      const payload = {
        ...(str("name") ? { name: str("name") } : {}),
        ...("disabled" in args ? { disabled: boolean("disabled") } : {}),
      };
      return Object.keys(payload).length
        ? call("PATCH", sa, payload)
        : textResult("pass name and/or disabled", true);
    }
    case "list_service_account_keys":
      return call("GET", sa + "/keys");
    case "revoke_service_account_key":
      return call("DELETE", sa + "/keys/" + id("key_id"));
    case "list_service_account_transfers":
      return call("GET", "/v1/service-accounts/transfers");
    case "create_service_account_transfer":
      return call("POST", sa + "/transfer", { to_user_email: str("to_user_email") });
    case "accept_service_account_transfer":
    case "decline_service_account_transfer":
      return call(
        "POST",
        "/v1/service-accounts/transfers/" +
          id("transfer_id") +
          "/" +
          (name === "accept_service_account_transfer" ? "accept" : "decline"),
        {},
      );
    default:
      return textResult("Unknown tool: " + name, true);
  }
}
