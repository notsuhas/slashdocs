import type { Actor } from "../env";
// Only server-created MCP tool requests enter this map. HTTP headers never do.
const actors = new WeakMap<Request, Actor>();
export function internalActor(request: Request): Actor | undefined {
  return actors.get(request);
}
export async function withInternalActor<T>(
  request: Request,
  actor: Actor,
  dispatch: () => Promise<T>,
): Promise<T> {
  actors.set(request, actor);
  try {
    return await dispatch();
  } finally {
    actors.delete(request);
  }
}
