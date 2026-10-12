export function requestMediaType(req: {
  header: (name: string) => string | undefined;
}): string {
  const header = req.header("Content-Type") ?? "";
  const match = /^\s*([!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+)\s*/i.exec(
    header,
  );
  if (!match) return "";
  let rest = header.slice(match[0].length);
  const parameters = new Map<string, string>();
  while (rest) {
    if (/^;\s*$/.test(rest)) break;
    const parameter =
      /^;\s*([!#$%&'*+.^_`|~0-9a-z-]+)\s*=\s*("(?:[^"\\\r\n]|\\[^\r\n])*"|[!#$%&'*+.^_`|~0-9a-z-]+)\s*/i.exec(
        rest,
      );
    if (!parameter) return "";
    const name = parameter[1].toLowerCase();
    const value = parameter[2].startsWith('"')
      ? parameter[2].slice(1, -1).replace(/\\(.)/g, "$1")
      : parameter[2];
    if (parameters.has(name) && parameters.get(name) !== value) return "";
    parameters.set(name, value);
    rest = rest.slice(parameter[0].length);
  }
  return match[1].toLowerCase();
}
