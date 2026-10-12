import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
const built = await build({
  entryPoints: ["frontend/bridge/bridge.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  tsconfigRaw: { compilerOptions: { alwaysStrict: false } },
  minify: true,
  write: false,
});
const file = built.outputFiles?.[0];
if (!file) throw new Error("Bridge build produced no JavaScript");
await mkdir("workers/shared", { recursive: true });
await writeFile(
  "workers/shared/bridge.generated.ts",
  `// Generated from frontend/bridge.\nexport const BRIDGE_JS = ${JSON.stringify(file.text)};\n`,
);

const installerSource = await (
  await import("node:fs/promises")
).readFile("api/internal/server/downloads.go", "utf8");
const installerMatch = /const installScriptTemplate = `([\s\S]*?)`\s*$/.exec(
  installerSource,
);
if (!installerMatch) throw new Error("Upstream installer template is missing");
await writeFile(
  "workers/shared/install.generated.ts",
  `// Generated from upstream installer.\nexport const INSTALL_SCRIPT = ${JSON.stringify(installerMatch[1])};\n`,
);
