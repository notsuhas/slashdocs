import { readFile, readdir } from "node:fs/promises";
import { splitSQLStatements } from "../shared/migrations";
export async function loadMigrationStatements(): Promise<string[]> {
  const directory = new URL("../app/migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const result: string[] = [];
  for (const name of names)
    result.push(
      ...splitSQLStatements(await readFile(new URL(name, directory), "utf8")),
    );
  return result;
}
