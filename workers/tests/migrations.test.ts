import { describe, expect, it } from "vitest";
import { splitSQLStatements } from "../shared/migrations";
describe("SQLite migration boundaries", () => {
  it("preserves nested CASE and quoted semicolons within trigger bodies", () => {
    const statements = splitSQLStatements(`-- ignored;\nCREATE TABLE t(v TEXT);
      CREATE TRIGGER x AFTER INSERT ON t BEGIN
        SELECT CASE WHEN NEW.v='a;''b' THEN 1 ELSE 0 END;
        UPDATE t SET v='done;';
      END;
      /* ignored ; */ INSERT INTO t VALUES ('last;');`);
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain("UPDATE t SET v='done;';");
    expect(statements[2]).toBe("INSERT INTO t VALUES ('last;');");
  });
  it("rejects incomplete triggers and strings", () => {
    expect(() =>
      splitSQLStatements("CREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT 1;"),
    ).toThrow();
    expect(() => splitSQLStatements("SELECT 'unfinished")).toThrow();
  });
});
