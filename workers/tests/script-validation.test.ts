import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInstance, validateLoginConfiguration } from "../scripts/instance";

const repository = process.cwd();
const cleanup: string[] = [];
afterEach(async () => {
  for (const directory of cleanup.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(directory: string, extra = {}) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "instance.json");
  await writeFile(
    path,
    JSON.stringify({
      accountId: "a".repeat(32),
      appOrigin: "https://app.example.com",
      renderOrigin: "https://render.example.com",
      allowedDomains: ["example.com"],
      databaseId: "fixture-db",
      sessionSecret: "fixture-session",
      renderPrivateKey: "fixture-private",
      renderPublicKey: "fixture-public",
      ...extra,
    }),
  );
  return path;
}
async function temporary(parent = tmpdir()) {
  const directory = await mkdtemp(join(parent, "slashdocs-script-test-"));
  cleanup.push(directory);
  return await realpath(directory);
}

describe("private instance paths", () => {
  it("rejects an in-checkout directory starting with two dots", async () => {
    const directory = await temporary(repository);
    await expect(
      loadInstance(await fixture(join(directory, "..private"))),
    ).rejects.toThrow("outside the repository");
  });
  it("rejects a top-level two-dot directory", async () => {
    const directory = await mkdtemp(join(repository, "..private-script-test-"));
    cleanup.push(directory);
    await expect(loadInstance(await fixture(directory))).rejects.toThrow(
      "outside the repository",
    );
  });
  it("rejects an external symlink to an in-checkout two-dot directory", async () => {
    const inside = await mkdtemp(join(repository, "..private-script-test-"));
    cleanup.push(inside);
    const path = await fixture(inside);
    const outside = await temporary();
    const link = join(outside, "instance.json");
    await symlink(path, link);
    await expect(loadInstance(link)).rejects.toThrow("outside the repository");
  });
  it("accepts an actual parent path and resolves an in-checkout symlink outside", async () => {
    const outside = await temporary();
    const path = await fixture(outside);
    expect((await loadInstance(path)).path).toBe(await realpath(path));
    const inside = await temporary(repository);
    const link = join(inside, "instance.json");
    await symlink(path, link);
    expect((await loadInstance(link)).directory).toBe(
      (await loadInstance(path)).directory,
    );
  });
});

const optional = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SLASHDOCS_OIDC_CLIENT_ID",
  "SLASHDOCS_OIDC_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_GROUPS_SERVICE_ACCOUNT_JSON",
  "SLASHDOCS_SLACK_BOT_TOKEN",
];
describe("complete deployment secrets", () => {
  it.each([
    { googleClientId: "fixture-google", googleClientSecret: "fixture-google-secret" },
    {
      oidcIssuer: "https://issuer.example.com",
      oidcClientId: "fixture-oidc",
      oidcClientSecret: "fixture-oidc-secret",
    },
  ])("includes explicit resets for absent optional credentials", async (provider) => {
    const directory = await temporary();
    const path = await fixture(directory, provider);
    const configured = spawnSync("bun", ["workers/scripts/configure.ts", path], {
      encoding: "utf8",
    });
    expect(configured.status, configured.stderr).toBe(0);
    const secrets = JSON.parse(
      await readFile(join(directory, "app-secrets.json"), "utf8"),
    );
    expect(Object.keys(secrets).sort()).toEqual(
      [...optional, "SESSION_SECRET", "RENDER_PRIVATE_KEY"].sort(),
    );
    expect(secrets.SESSION_SECRET).toBe("fixture-session");
    expect(secrets.RENDER_PRIVATE_KEY).toBe("fixture-private");
    expect(secrets.GITHUB_CLIENT_ID).toBe("");
    expect(secrets.GOOGLE_GROUPS_SERVICE_ACCOUNT_JSON).toBe("");
    if ("googleClientId" in provider) {
      expect(secrets.GOOGLE_CLIENT_ID).toBe(provider.googleClientId);
      expect(secrets.SLASHDOCS_OIDC_CLIENT_ID).toBe("");
    } else {
      expect(secrets.SLASHDOCS_OIDC_CLIENT_ID).toBe(provider.oidcClientId);
      expect(secrets.GOOGLE_CLIENT_ID).toBe("");
    }
  });
  it("still rejects mixed providers", () => {
    expect(() =>
      validateLoginConfiguration({
        googleClientId: "fixture-google",
        googleClientSecret: "fixture-secret",
        oidcIssuer: "https://issuer.example.com",
        oidcClientId: "fixture-oidc",
        oidcClientSecret: "fixture-secret",
      }),
    ).toThrow("one complete");
  });
});

it("uploads app secrets with code and stops on upload failure", async () => {
  const directory = await temporary();
  const path = await fixture(directory, {
    googleClientId: "fixture-google",
    googleClientSecret: "fixture-google-secret",
  });
  const executable = join(directory, "bun");
  const log = join(directory, "commands.jsonl");
  await writeFile(
    executable,
    `#!${process.execPath}\n` +
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SCRIPT_TEST_LOG, JSON.stringify(args) + "\\n");
process.exit(args.includes("deploy") && args.includes(process.env.SCRIPT_TEST_APP) ? 1 : 0);
`,
    { mode: 0o700 },
  );
  const bun = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim();
  const deployed = spawnSync(bun, ["workers/scripts/deploy.ts", path], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      SCRIPT_TEST_LOG: log,
      SCRIPT_TEST_APP: join(directory, "wrangler.app.json"),
    },
  });
  expect(deployed.status).not.toBe(0);
  expect(deployed.stderr).toContain("Deployment command failed");
  const commands: unknown[] = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(commands).toEqual([
    ["workers/scripts/provision.ts", await realpath(path)],
    ["workers/scripts/configure.ts", await realpath(path)],
    ["run", "build:cloudflare"],
    [
      "x",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "slashdocs-db",
      "--remote",
      "--config",
      join(directory, "wrangler.app.json"),
    ],
    ["x", "wrangler", "deploy", "--config", join(directory, "wrangler.render.json")],
    [
      "x",
      "wrangler",
      "deploy",
      "--config",
      join(directory, "wrangler.app.json"),
      "--secrets-file",
      join(directory, "app-secrets.json"),
    ],
  ]);
});
