import { mkdtemp, rm, writeFile, chmod, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstance, saveInstance } from "../scripts/instance";
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function config(appOrigin: string, renderOrigin: string) {
  directory = await mkdtemp(join(tmpdir(), "slashdocs-origin-test-"));
  const path = join(directory, "instance.json");
  await writeFile(
    path,
    JSON.stringify({
      accountId: "a".repeat(32),
      appOrigin,
      renderOrigin,
      allowedDomains: ["example.com"],
    }),
  );
  return path;
}
describe("instance origins", () => {
  it("canonicalizes trailing slashes to exact origins", async () => {
    const { instance } = await loadInstance(
      await config("https://app.example.com/", "https://render.example.com/"),
    );
    expect(instance.appOrigin).toBe("https://app.example.com");
    expect(instance.renderOrigin).toBe("https://render.example.com");
  });
  it.each([
    "https://app.example.com/path",
    "https://app.example.com/?x=1",
    "https://:secret@app.example.com/",
  ])("rejects non-origin input %s", async (origin) => {
    await expect(
      loadInstance(await config(origin, "https://render.example.com")),
    ).rejects.toThrow("without paths or credentials");
  });
});

it("restricts an existing instance file before saving generated secrets", async () => {
  const path = await config("https://app.example.com", "https://render.example.com");
  await chmod(path, 0o644);
  const { instance } = await loadInstance(path);
  instance.sessionSecret = "fixture-secret";
  await saveInstance(path, instance);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("restricts existing generated configuration and secret files on reconfiguration", async () => {
  const path = await config("https://app.example.com", "https://render.example.com");
  const { instance } = await loadInstance(path);
  await saveInstance(path, {
    ...instance,
    databaseId: "fixture-db",
    sessionSecret: "fixture-secret",
    renderPrivateKey: "fixture-private-key",
    renderPublicKey: "fixture-public-key",
  });
  if (!directory) throw new Error("Fixture directory missing");
  const outputs = ["wrangler.app.json", "wrangler.render.json", "app-secrets.json"];
  for (const name of outputs) {
    const file = join(directory, name);
    await writeFile(file, "{}");
    await chmod(file, 0o644);
  }
  const configured = spawnSync("bun", ["workers/scripts/configure.ts", path], {
    encoding: "utf8",
  });
  expect(configured.status, configured.stderr).toBe(0);
  for (const name of outputs)
    expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
});
