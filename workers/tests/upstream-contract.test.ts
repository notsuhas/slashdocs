import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { app } from "../app/src/index";

it("registers every authenticated upstream HTTP endpoint", async () => {
  const source = await readFile("api/internal/server/server.go", "utf8");
  const expected = [
    ...source.matchAll(/authed\.(GET|POST|PUT|PATCH|DELETE)\("([^"]+)"/g),
  ].map((match) => `${match[1]} /v1${match[2]}`);
  expect(expected.length).toBeGreaterThan(60);
  const registered = new Set(
    app.routes.map((route) => `${route.method} ${route.path}`),
  );
  expect(expected.filter((route) => !registered.has(route))).toEqual([]);
});
