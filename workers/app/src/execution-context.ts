import type { Context } from "hono";
import type { AppEnv } from "./env";

// In-process Hono callers may omit the Worker execution context.
export function optionalExecutionContext(
  c: Context<AppEnv>,
): Context<AppEnv>["executionCtx"] | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}
