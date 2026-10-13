import { Hono } from "hono";
import type { AppEnv } from "../env";
import { realtimeStub } from "../services/state";
export const stateRoutes = new Hono<AppEnv>();
stateRoutes.on(["GET", "PATCH"], "/v1/documents/:id/kv", (c) =>
  realtimeStub(c.env, c.req.param("id")).fetch(c.req.raw),
);
stateRoutes.get("/v1/documents/:id/kv/events", (c) =>
  realtimeStub(c.env, c.req.param("id")).fetch(c.req.raw),
);
stateRoutes.post("/v1/documents/:id/cursor", (c) =>
  realtimeStub(c.env, c.req.param("id")).fetch(c.req.raw),
);
stateRoutes.post("/v1/documents/:id/presence", (c) =>
  realtimeStub(c.env, c.req.param("id")).fetch(c.req.raw),
);
