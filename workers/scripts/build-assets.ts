import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const out = "workers/dist/app";
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp("frontend/dist", out, { recursive: true });
const index = await readFile(`${out}/index.html`, "utf8");
await writeFile(
  `${out}/index.html`,
  index.replace(
    /<script>\s*window\.__SLASHDOCS_PUBLIC_URL__\s*=[\s\S]*?<\/script>/,
    "",
  ),
);
await mkdir(`${out}/skills/slashdocs`, { recursive: true });
await cp("skills/slashdocs/SKILL.md", `${out}/skills/slashdocs/SKILL.md`);
await mkdir(`${out}/api-docs`, { recursive: true });
const docsBuild = spawnSync(
  "go",
  ["run", "./workers/scripts/export-api-docs", `${out}/api-docs`],
  { stdio: "inherit" },
);
if (docsBuild.status !== 0) throw new Error("API documentation asset export failed");
await cp("api/internal/server/docs/swagger.json", `${out}/openapi.json`);
await writeFile(
  `${out}/api-docs/index.html`,
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SlashDocs API</title><link rel="stylesheet" href="/api-docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/api-docs/swagger-ui-bundle.js"></script><script src="/api-docs/swagger-ui-standalone-preset.js"></script><script src="/api-docs/initializer.js"></script></body></html>`,
);
await writeFile(
  `${out}/api-docs/initializer.js`,
  `window.ui=SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',deepLinking:true,presets:[SwaggerUIBundle.presets.apis,SwaggerUIStandalonePreset],plugins:[SwaggerUIBundle.plugins.DownloadUrl],layout:'StandaloneLayout'});\n`,
);
const upstream = await readFile("api/internal/server/downloads.go", "utf8");
const match = /const installScriptTemplate = `([\s\S]*?)`\s*$/.exec(upstream);
if (!match) throw new Error("Could not extract upstream CLI installer");
await writeFile(
  "workers/shared/install.generated.ts",
  `// Generated from upstream installer.\nexport const INSTALL_SCRIPT = ${JSON.stringify(match[1])};\n`,
);
const assets = [];
for (const os of ["darwin", "linux"])
  for (const arch of ["arm64", "amd64"]) {
    const directory = `${out}/cli/${os}`;
    await mkdir(directory, { recursive: true });
    const target = `${directory}/${arch}`;
    const built = spawnSync(
      "go",
      ["build", "-trimpath", "-ldflags=-s -w", "-o", target, "./cli"],
      {
        env: { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: "0" },
        stdio: "inherit",
      },
    );
    if (built.status !== 0) throw new Error(`CLI build failed for ${os}/${arch}`);
    const bytes = await readFile(target);
    if (bytes.length > 25 * 1024 * 1024)
      throw new Error("CLI binary exceeds Worker static asset limit");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assets.push({ os, arch, url: `/cli/${os}/${arch}`, sha256, size: bytes.length });
    await writeFile(`${target}.sha256`, `${sha256}  slashdocs\n`);
  }
const commit = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).stdout.trim();
await writeFile(
  `${out}/version.json`,
  JSON.stringify({
    version: "0.1.0-cloudflare",
    commit,
    install: "/install.sh",
    assets,
  }) + "\n",
);
await writeFile(
  `${out}/_headers`,
  "/cli/*\n  Content-Type: application/octet-stream\n  X-Content-Type-Options: nosniff\n/skills/*\n  Content-Type: text/plain; charset=utf-8\n",
);
