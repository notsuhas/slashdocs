/** Split SQLite migrations while preserving quoted text and trigger bodies. */
export function splitSQLStatements(sql: string): string[] {
  const statements: string[] = [];
  let statement = "",
    word = "",
    quote = "",
    comment = "";
  let trigger = false,
    depth = 0;
  const words: string[] = [];
  const flushWord = () => {
    if (!word) return;
    const token = word.toUpperCase();
    words.push(token);
    if (words[0] === "CREATE" && token === "TRIGGER" && words.length <= 4)
      trigger = true;
    if (trigger && (token === "BEGIN" || token === "CASE")) depth++;
    if (trigger && token === "END") depth--;
    word = "";
  };
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i],
      next = sql[i + 1];
    if (comment) {
      if (comment === "--" && char === "\n") {
        comment = "";
        statement += "\n";
      } else if (comment === "/*" && char === "*" && next === "/") {
        comment = "";
        i++;
        statement += " ";
      }
      continue;
    }
    if (quote) {
      statement += char;
      if (char === quote) {
        if (next === quote && quote !== "]") {
          statement += next;
          i++;
        } else quote = "";
      }
      continue;
    }
    if ((char === "-" && next === "-") || (char === "/" && next === "*")) {
      flushWord();
      comment = char + next;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      flushWord();
      quote = char === "[" ? "]" : char;
      statement += char;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) word += char;
    else flushWord();
    statement += char;
    if (char === ";" && (!trigger || depth === 0)) {
      if (statement.trim()) statements.push(statement.trim());
      statement = "";
      words.length = 0;
      trigger = false;
      depth = 0;
    }
  }
  flushWord();
  if (quote || comment === "/*" || depth !== 0)
    throw new Error("Incomplete SQL migration");
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}
