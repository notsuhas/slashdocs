import type { Actor, Env } from "../env";
import { listDocuments } from "./documents";

type SearchEnv = Env & { DOCUMENT_SEARCH?: DurableObjectNamespace };

export async function documentListResponse(
  env: SearchEnv,
  actor: Actor,
  q: string,
  tz = "UTC",
  label = "",
): Promise<Response> {
  if (!env.DOCUMENT_SEARCH) {
    // Standalone domain/route fixtures have no namespace. Deployment configs
    // must always bind DocumentSearch so production never takes this CPU path.
    return Response.json({ items: await listDocuments(env, actor, q, tz, label) });
  }
  const id = env.DOCUMENT_SEARCH.idFromName(
    `actor:${actor.principal.type}:${actor.principal.id}`,
  );
  return env.DOCUMENT_SEARCH.get(id).fetch("https://search.internal/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor, q, tz, label }),
  });
}
