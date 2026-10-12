import type { Env } from "../app/src/env";
export default {
  async fetch(request: Request, env: Env & { SOURCE_BACKFILL_TOKEN: string }) {
    if (
      !env.SOURCE_BACKFILL_TOKEN ||
      request.method !== "POST" ||
      request.headers.get("Authorization") !== `Bearer ${env.SOURCE_BACKFILL_TOKEN}`
    )
      return new Response(null, { status: 404 });
    const after = new URL(request.url).searchParams.get("after") ?? "";
    if (!/^[A-Za-z0-9_-]{0,128}$/.test(after))
      return new Response(null, { status: 400 });
    if (!env.DOCUMENT_SEARCH) return new Response(null, { status: 503 });
    return env.DOCUMENT_SEARCH.get(env.DOCUMENT_SEARCH.idFromName("maintenance")).fetch(
      "https://search.internal/index",
      { method: "POST", body: JSON.stringify({ after }) },
    );
  },
};
