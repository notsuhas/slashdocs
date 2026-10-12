import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../../../shared/errors";
import { googleGroupsEnabled, searchGoogleGroups } from "../services/groups";
export const googleGroupRoutes = new Hono<AppEnv>();
googleGroupRoutes.get("/v1/google-groups", async (c) => {
  if (!googleGroupsEnabled(c.env))
    throw new ApiError(404, "feature_disabled", "Google Group sharing is disabled");
  const query = (c.req.query("q") ?? "").trim();
  if ([...query].length < 2)
    throw new ApiError(400, "bad_request", "q must contain at least two characters");
  const groups = await searchGoogleGroups(c.env, query);
  return c.json({ items: groups.map(({ id, email, name }) => ({ id, email, name })) });
});
