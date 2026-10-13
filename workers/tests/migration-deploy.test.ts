import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { splitSQLStatements } from "../shared/migrations";

const migrations = resolve("workers/app/migrations");
const execute = promisify(execFile);
const ledgerRows = (output: string) =>
  z
    .array(z.object({ results: z.array(z.object({ name: z.string() })) }))
    .parse(JSON.parse(output))
    .flatMap((result) => result.results.map((row) => row.name));
const names = (await readdir(migrations))
  .filter((name) => name.endsWith(".sql"))
  .sort();

describe("deployment migrations", () => {
  it("avoids bare CASE END boundaries in remote D1 trigger statements", async () => {
    // https://github.com/cloudflare/workers-sdk/issues/4727
    // Remote migrations send the entire file to D1 /query. Its splitter can
    // mistake CASE's END; for the trigger's END; even when local Wrangler works.
    const sql = await readFile(resolve(migrations, "0002_folders.sql"), "utf8");
    expect(sql).not.toMatch(/RAISE\(ABORT,'folder_(?:depth|cycle)_conflict'\) END;/);
  });

  it("executes every Wrangler-split statement from 0001 through 0010 in workerd", async () => {
    const mf = new Miniflare({ modules: true, script: "", d1Databases: ["DB"] });
    try {
      const db = await mf.getD1Database("DB");
      expect(names).toHaveLength(10);
      for (const name of names) {
        const sql = await readFile(resolve(migrations, name), "utf8");
        const statements = unstable_splitSqlQuery(sql);
        for (const statement of statements)
          expect(splitSQLStatements(statement), name).toHaveLength(1);
        // Strip comments and normalize terminators with the independent fixture
        // parser; this compares complete boundaries, not merely statement counts.
        expect(
          statements.flatMap(splitSQLStatements).map((s) => s.replace(/;$/, "")),
          name,
        ).toEqual(splitSQLStatements(sql).map((s) => s.replace(/;$/, "")));
        await db.batch(statements.map((statement) => db.prepare(statement)));
      }
    } finally {
      await mf.dispose();
    }
  });

  it.each(["empty", "foundation"])(
    "applies and reruns actual Wrangler migrations on an %s database",
    async (start) => {
      const directory = await mkdtemp(resolve(tmpdir(), "slashdocs-migration-"));
      const config = resolve(directory, "wrangler.json");
      const migrationDirectory = resolve(directory, "migrations");
      const wrangler = async (args: string[]) =>
        execute(
          process.execPath,
          [
            resolve("node_modules/wrangler/bin/wrangler.js"),
            ...args,
            "--config",
            config,
          ],
          {
            env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
            maxBuffer: 1024 * 1024,
          },
        );
      const apply = () =>
        wrangler([
          "d1",
          "migrations",
          "apply",
          "DB",
          "--local",
          "--persist-to",
          resolve(directory, "state"),
        ]);
      const query = (sql: string) =>
        wrangler([
          "d1",
          "execute",
          "DB",
          "--local",
          "--persist-to",
          resolve(directory, "state"),
          "--command",
          sql,
          "--json",
        ]);
      try {
        await writeFile(
          config,
          JSON.stringify({
            name: "migration-test",
            compatibility_date: "2026-07-30",
            d1_databases: [
              {
                binding: "DB",
                database_name: "migration-test",
                database_id: "00000000-0000-0000-0000-000000000001",
                migrations_dir: migrationDirectory,
              },
            ],
          }),
        );
        await cp(migrations, migrationDirectory, {
          recursive: true,
          filter: (path) =>
            start === "empty" ||
            !path.endsWith(".sql") ||
            path.endsWith("0001_core.sql"),
        });
        if (start === "foundation") {
          await apply();
          await query(
            "INSERT INTO users VALUES ('u','google','u','u@example.com','User','','now'); INSERT INTO documents (id,title,owner_user_id,updated_at) VALUES ('d','Document','u','now'); INSERT INTO pins VALUES ('u','document','d');",
          );
          await cp(migrations, migrationDirectory, { recursive: true });
        }
        await apply();
        const before = await query("SELECT name FROM d1_migrations ORDER BY name;");
        const rerun = await apply();
        expect(rerun.stdout).toContain("No migrations to apply");
        expect(
          ledgerRows(
            (await query("SELECT name FROM d1_migrations ORDER BY name;")).stdout,
          ),
        ).toEqual(ledgerRows(before.stdout));
        expect(ledgerRows(before.stdout)).toEqual(names);
        if (start === "foundation")
          expect(
            (await query("SELECT user_id,resource_type,resource_id FROM pins;")).stdout,
          ).toContain('"resource_id": "d"');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    60000,
  );
});
