function serve(options: {
  hostname: string;
  port: number;
  fetch: (
    request: Request,
  ) => Response | RuntimeResponse | Promise<Response | RuntimeResponse>;
}) {
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (value) headers.set(name, value.join(", "));
      }
      const request = new Request(
        `http://${options.hostname}:${options.port}${req.url}`,
        { method: req.method, headers, ...(body.length ? { body } : {}) },
      );
      const response = await options.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      const reader = response.body?.getReader();
      res.on("close", () => {
        void reader?.cancel().catch(() => {});
      });
      if (reader)
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (!res.write(Buffer.from(next.value)))
            await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      res.end();
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Fixture server failed");
      res.writeHead(500);
      res.end("Fixture server failed");
    }
  });
  server.listen(options.port, options.hostname);
}
function runCLI(
  args: string[],
  options: { stdout: string; stderr: string; env: NodeJS.ProcessEnv },
) {
  const child = spawn(args[0], args.slice(1), {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return {
    exited: new Promise<number>((resolve) => {
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 1));
    }),
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}
// Explicitly enabled, loopback-only fixture server; never deploy this script.
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join, sep } from "node:path";
import { seedUser } from "../tests/runtime";
import { createMCPRuntime } from "../tests/mcp-runtime";
import type { Response as RuntimeResponse } from "miniflare";
import { hashToken } from "../app/src/auth/tokens";
if (process.env.SLASHDOCS_LOCAL_SMOKE !== "1")
  throw new Error("Set SLASHDOCS_LOCAL_SMOKE=1 to run isolated loopback fixtures.");
const assetRoot = resolve("workers/dist/app");
const fixture = await createMCPRuntime(
  {
    APP_ORIGIN: "http://localhost:8890",
    RENDER_ORIGIN: "http://127.0.0.1:8891",
  },
  {
    render: true,
    assets: async (request: { url: string }) => {
      const url = new URL(request.url);
      let target = resolve(assetRoot, "." + decodeURIComponent(url.pathname));
      if (target !== assetRoot && !target.startsWith(assetRoot + sep))
        return new Response("Not found", { status: 404 });
      if (
        !(await stat(target).then(
          (s) => s.isFile(),
          () => false,
        ))
      )
        target = join(assetRoot, "index.html");
      return new Response(await readFile(target), {
        headers: {
          "Content-Type": target.endsWith(".html")
            ? "text/html"
            : target.endsWith(".js")
              ? "text/javascript"
              : target.endsWith(".css")
                ? "text/css"
                : "application/octet-stream",
        },
      });
    },
  },
);
const renderWorker = await fixture.mf.getWorker("render");
const user = await seedUser(fixture.env, "usr_smokefixture", "owner@example.com");
const cliToken = "slashdocs_cli_" + crypto.randomUUID().replaceAll("-", "");
const session = crypto.randomUUID() + crypto.randomUUID();
await fixture.env.DB.prepare(
  "INSERT INTO cli_credentials(id,token_hash,user_id,name,created_at) VALUES(?,?,?,?,?)",
)
  .bind(
    "cred_smoke",
    await hashToken(cliToken),
    user.id,
    "Local smoke",
    new Date().toISOString(),
  )
  .run();
await fixture.env.DB.prepare(
  "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
)
  .bind(await hashToken(session), user.id, Math.floor(Date.now() / 1000) + 3600)
  .run();
serve({
  hostname: "localhost",
  port: 8890,
  fetch: async (request) =>
    new URL(request.url).pathname === "/__smoke__/login"
      ? new Response(null, {
          status: 302,
          headers: {
            Location: "/app/documents",
            "Set-Cookie": `slashdocs_session=${session}; HttpOnly; SameSite=Lax; Path=/`,
          },
        })
      : fixture.fetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          ...(["GET", "HEAD"].includes(request.method)
            ? {}
            : { body: await request.arrayBuffer() }),
        }),
});
serve({
  hostname: "127.0.0.1",
  port: 8891,
  fetch: async (request) =>
    renderWorker.fetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      ...(["GET", "HEAD"].includes(request.method)
        ? {}
        : { body: await request.arrayBuffer() }),
    }),
});
const tmp = await mkdtemp(join(tmpdir(), "slashdocs-cli-smoke-"));
const html = join(tmp, "report.html");
await writeFile(
  html,
  "<!doctype html><html><body><h1>Review fixture</h1><p>Four satellites fix a position and clock error.</p></body></html>",
);
// Child CLI networking must not block Bun's server event loop.
const cli = runCLI(
  [
    "go",
    "run",
    "./cli",
    "--server",
    fixture.env.APP_ORIGIN,
    "--token",
    cliToken,
    "--json",
    "docs",
    "create",
    html,
    "--title",
    "Cloudflare smoke report",
  ],
  {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SLASHDOCS_NO_UPDATE: "1",
      XDG_CONFIG_HOME: join(tmp, "config"),
    },
  },
);
const code = await cli.exited;
if (code !== 0) {
  console.error(await new Response(cli.stderr).text());
  throw new Error("CLI create failed");
}
const result = JSON.parse(await new Response(cli.stdout).text());
const id = result.id;
if (typeof id !== "string") throw new Error("CLI create response lacked document ID");
const pull = runCLI(
  [
    "go",
    "run",
    "./cli",
    "--server",
    fixture.env.APP_ORIGIN,
    "--token",
    cliToken,
    "docs",
    "pull",
    id,
    "--out",
    join(tmp, "pulled.html"),
  ],
  {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SLASHDOCS_NO_UPDATE: "1",
      XDG_CONFIG_HOME: join(tmp, "config"),
    },
  },
);
if ((await pull.exited) !== 0) {
  console.error(await new Response(pull.stderr).text());
  throw new Error("CLI pull failed");
}
await writeFile(
  html,
  "<!doctype html><html><body><h1>Review fixture</h1><p>Four satellites solve your position and receiver clock error.</p></body></html>",
);
const push = runCLI(
  [
    "go",
    "run",
    "./cli",
    "--server",
    fixture.env.APP_ORIGIN,
    "--token",
    cliToken,
    "--json",
    "docs",
    "push",
    id,
    html,
    "--summary",
    "Clarify clock error",
  ],
  {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SLASHDOCS_NO_UPDATE: "1",
      XDG_CONFIG_HOME: join(tmp, "config"),
    },
  },
);
if ((await push.exited) !== 0) {
  console.error(await new Response(push.stderr).text());
  throw new Error("CLI push failed");
}
console.info("Unmodified Go CLI create, pull and push succeeded.");
console.info(
  `Browser fixture: http://localhost:8890/__smoke__/login ; document /app/d/${id}`,
);
process.on("SIGINT", () => {
  void fixture.dispose().finally(() => process.exit(0));
});
