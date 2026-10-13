import { badRequest } from "../../../shared/errors";
import { isDateWord, searchDateContext, searchPeriod } from "./search-dates";
export type DocumentSearch = {
  terms: string[];
  excluded: string[];
  owners: string[];
  folders: string[];
  labels: string[];
  since?: string;
  before?: string;
};
export function searchTokens(raw: string) {
  const tokens: { text: string; phrase: boolean }[] = [];
  let current = "",
    quoted = false,
    phrase = false;
  function flush() {
    if (current) tokens.push({ text: current, phrase });
    current = "";
    phrase = false;
  }
  for (const rune of raw) {
    if (rune === '"') {
      phrase ||= !quoted && !current;
      quoted = !quoted;
    } else if (quoted || !/\p{White_Space}/u.test(rune)) current += rune;
    else flush();
  }
  flush();
  return tokens;
}
export function parseDocumentSearch(
  raw: string,
  me: string,
  now = new Date(),
  zone = "UTC",
): DocumentSearch {
  if (new TextEncoder().encode(raw).length > 512)
    badRequest("invalid search query: query is too long");
  const out: DocumentSearch = {
    terms: [],
    excluded: [],
    owners: [],
    folders: [],
    labels: [],
  };
  const tokens = searchTokens(raw),
    context = searchDateContext(now, zone);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i],
      text = token.text.toLowerCase();
    if (token.phrase) {
      out.terms.push(text);
      continue;
    }
    if (text.length > 1 && text[0] === "-") {
      out.excluded.push(text.slice(1));
      continue;
    }
    const colon = text.indexOf(":"),
      rawKey = text.slice(0, colon),
      key = rawKey === "author" ? "from" : rawKey === "labels" ? "label" : rawKey;
    let value = text.slice(colon + 1).trim();
    if (colon >= 0 && ["before", "after", "on", "during"].includes(key)) {
      const words = [value];
      for (const next of tokens.slice(i + 1)) {
        if (next.phrase || !isDateWord(next.text.toLowerCase())) break;
        words.push(next.text.toLowerCase());
      }
      for (let n = words.length; n > 0; n--) {
        const period = searchPeriod(words.slice(0, n).join(" "), context);
        if (!period) continue;
        if (key !== "before") {
          const since = key === "after" ? period[1] : period[0];
          if (!out.since || since > out.since) out.since = since;
        }
        if (key !== "after") {
          const before = key === "before" ? period[0] : period[1];
          if (!out.before || before < out.before) out.before = before;
        }
        i += n - 1;
        break;
      }
      continue;
    }
    if (colon >= 0 && key === "from") {
      value = value.replace(/^@/, "");
      if (value === "me") value = me.toLowerCase();
      if (value) out.owners.push(value);
    } else if (colon >= 0 && key === "in") {
      value = value.replace(/^#/, "");
      if (value) out.folders.push(value);
    } else if (colon >= 0 && key === "label")
      out.labels.push(
        ...value
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
      );
    else out.terms.push(text);
  }
  if (
    [out.terms, out.excluded, out.owners, out.folders, out.labels].some(
      (values) => values.length > 10,
    )
  )
    badRequest("invalid search query: use at most 10 of each search term");
  return out;
}
