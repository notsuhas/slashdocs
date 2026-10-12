import { Hono } from "hono";
import { expect, it } from "vitest";
import type { AppEnv } from "../app/src/env";
import { activityRateLimit } from "../app/src/auth/activity-limit";
it("shares the activity budget, isolates presence and renews the window", async () => {
  let now = 0;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      principal: { type: "user", id: c.req.header("X-Actor") ?? "one" },
      credentialKind: "session",
    });
    await next();
  });
  const activity = activityRateLimit(() => now);
  app.use("/activity/*", activity);
  app.use(
    "/presence",
    activityRateLimit(() => now),
  );
  app.get("*", (c) => c.text("ok"));
  for (let i = 0; i < 60; i++)
    expect((await app.request(`/activity/${i % 2}`)).status).toBe(200);
  const denied = await app.request("/activity/a");
  expect(denied.status).toBe(429);
  expect(denied.headers.get("Retry-After")).toBe("60");
  expect((await app.request("/presence")).status).toBe(200);
  expect(
    (await app.request("/activity/a", { headers: { "X-Actor": "two" } })).status,
  ).toBe(200);
  now = 60000;
  expect((await app.request("/activity/a")).status).toBe(200);
});
