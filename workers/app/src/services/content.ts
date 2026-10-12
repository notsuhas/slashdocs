import type { Env } from "../env";
import { ApiError } from "../../../shared/errors";
export function maxHTMLBytes(env: Env) {
  const max = Number(env.MAX_HTML_BYTES ?? 50 * 1024 * 1024);
  if (!Number.isSafeInteger(max) || max < 1)
    throw new ApiError(500, "configuration_error", "Invalid upload limit");
  return max;
}
export async function readUpload(env: Env, request: Request) {
  const max = maxHTMLBytes(env);
  const length = Number(request.headers.get("content-length"));
  if (length > max + 65536)
    throw new ApiError(413, "payload_too_large", "HTML file exceeds configured limit");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "bad_request", "Invalid document upload");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > max + 65536) {
      await reader.cancel();
      throw new ApiError(
        413,
        "payload_too_large",
        "HTML file exceeds configured limit",
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let form: FormData;
  try {
    form = await new Response(bytes, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    throw new ApiError(400, "bad_request", "Invalid document upload");
  }
  const file = form.get("file");
  if (!file || typeof file === "string")
    throw new ApiError(400, "bad_request", "file is required");
  if (file.size > max)
    throw new ApiError(413, "payload_too_large", "HTML file exceeds configured limit");
  return { form, bytes: new Uint8Array(await file.arrayBuffer()) };
}
export async function storeSource(env: Env, key: string, bytes: Uint8Array) {
  if (bytes.byteLength > maxHTMLBytes(env))
    throw new ApiError(413, "payload_too_large", "HTML file exceeds configured limit");
  const sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  await env.DB.prepare(
    "INSERT INTO orphan_objects (object_key,created_at) VALUES (?,?)",
  )
    .bind(key, new Date().toISOString())
    .run();
  try {
    await env.DOCUMENTS.put(key, bytes, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
  } catch {
    await discardSource(env, key);
    throw new ApiError(
      502,
      "blob_storage_failed",
      "Could not upload HTML to blob storage",
    );
  }
  return sha256;
}
export async function discardSource(env: Env, key: string) {
  try {
    await env.DOCUMENTS.delete(key);
    await env.DB.prepare("DELETE FROM orphan_objects WHERE object_key=?")
      .bind(key)
      .run();
  } catch {
    /* The durable queue retains the key for scheduled cleanup. */
  }
}
