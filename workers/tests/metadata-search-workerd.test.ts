import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "../scripts/read-migrations";

it("benchmarks the capped high-frequency body in actual workerd document listing", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { createDocument, listDocuments } from './workers/app/src/services/documents';
        const actor = { principal: {type:'user',id:'usr_bench',email:'bench@example.com'}, credentialKind:'session' };
        export default { async fetch(request, env) {
          if (new URL(request.url).pathname === '/seed') {
            await env.DB.prepare("INSERT INTO users (id,provider,provider_subject,email,name,picture_url,created_at) VALUES ('usr_bench','google','bench','bench@example.com','Bench','','2026-10-13T00:00:00Z')").run();
            await createDocument(env, actor, 'Title', new TextEncoder().encode('needle '.repeat(37449)), 'private');
            return new Response('seeded');
          }
          if (new URL(request.url).pathname === '/ping') return new Response('pong');
          return Response.json(await listDocuments(env, actor, 'needle'));
        }};
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
  });
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
    r2Buckets: ["DOCUMENTS"],
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const statement of await loadMigrationStatements())
      await db.prepare(statement).run();
    expect((await mf.dispatchFetch("https://bench/seed")).status).toBe(200);
    const timings: number[] = [],
      baseline: number[] = [];
    // Measure from the host: workerd intentionally freezes JS time during CPU work.
    for (let i = 0; i < 6; i++) {
      let start = performance.now();
      await (await mf.dispatchFetch("https://bench/ping")).text();
      baseline.push(performance.now() - start);
      start = performance.now();
      const result = await (await mf.dispatchFetch("https://bench/search")).json();
      timings.push(performance.now() - start);
      expect(result).toMatchObject([
        { snippet: expect.stringContaining("\x02needle\x03") },
      ]);
    }
    console.info(
      JSON.stringify({
        benchmark: "workerd listDocuments, 262143-byte body, one document",
        coldMs: timings[0],
        warmMs: timings.slice(1),
        pingMs: baseline,
      }),
    );
    // Regression guard against the reviewed 9.3-second quadratic path. This is
    // elapsed time including D1/IPC, not proof of the production 10ms CPU budget.
    expect(Math.max(...timings)).toBeLessThan(2000);
  } finally {
    await mf.dispose();
  }
});
