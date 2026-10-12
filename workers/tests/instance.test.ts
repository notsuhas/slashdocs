import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstance } from "../scripts/instance";
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
