import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

// Same bounded, per-process window as the Go server. Presence has its own
// instance so heartbeats cannot consume the notification/link budget.
export function activityRateLimit(now = Date.now): MiddlewareHandler<AppEnv> {
  const windows = new Map<string, { start: number; count: number }>();
  return async (c, next) => {
    const actor = c.get("actor").principal,
      key = `${actor.type}:${actor.id}`,
      at = now();
    let window = windows.get(key);
    if (!window || at - window.start >= 60000) window = { start: at, count: 0 };
    if (windows.size >= 10000)
      for (const [id, value] of windows)
        if (at - value.start >= 60000) windows.delete(id);
    if (window.count >= 60 || (!windows.has(key) && windows.size >= 10000)) {
      c.header("Retry-After", "60");
      return c.json(
        {
          error: {
            code: "rate_limited",
            message: "Too many requests. Try again in a minute.",
          },
        },
        429,
      );
    }
    window.count++;
    windows.set(key, window);
    await next();
  };
}
