import { newStemmer } from "snowball-stemmers";
import { rankDocument } from "./search-rank";
import { headline } from "./search-headline";
// PostgreSQL's english Snowball dictionary uses this standard stop-word list.
const stopWords = new Set(
  `i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its itself they them their theirs themselves what which who whom this that these those am is are was were be been being have has had having do does did doing a an the and but if or because as until while of at by for with about against between into through during before after above below to from up down in out on off over under again further then once here there when where why how all any both each few more most other some such no nor not only own same so than too very s t can will just don should now`.split(
    " ",
  ),
);
const stemmer = newStemmer("english");
export type Lexeme = {
  word: string;
  stem: string;
  position: number;
  start: number;
  end: number;
  hidden?: boolean;
};
const tokenPattern =
  /<[^>]*>|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);|(?:[a-z][a-z0-9+.-]*:\/\/)?[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+(?::\d+)?(?:\/[\p{L}\p{N}_.~%+@:/?=&#!-]*)?|[a-z][a-z0-9+.-]*:\/\/|[\p{L}\p{N}_.+%-]+@[\p{L}\p{N}_.-]+|\/[\p{L}\p{N}_.~%+@:/?=&#!-]+|[+-]?\d+(?:\.\d+)?[eE][+-]?\d+|[+-]?\d+(?:\.\d+)+|[+-]\d+|[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+|[\p{L}\p{N}]+/giu;
export function lexemes(text: string, includeStops = false): Lexeme[] {
  const result: Lexeme[] = [];
  let position = 0;
  const stems = new Map<string, string>();
  const encoder = new TextEncoder();
  function append(raw: string, start: number, simple = false, hidden = false) {
    const word = raw.toLowerCase();
    // PostgreSQL ignores overlong tokens without advancing lexeme positions.
    if (
      word.length >= 2048 ||
      (word.length >= 512 && encoder.encode(word).length >= 2048)
    )
      return;
    position++;
    const stop = stopWords.has(word) && !simple;
    if (stop && !includeStops) return;
    let stem = stop ? "" : simple ? word : stems.get(word);
    if (stem === undefined) {
      stem = stemmer.stem(word);
      stems.set(word, stem);
    }
    result.push({
      word,
      stem,
      hidden,
      position,
      start,
      end: start + raw.length,
    });
  }
  for (const match of text.matchAll(tokenPattern)) {
    const raw = match[0],
      start = match.index;
    if (raw.startsWith("<") || /^&.+;$/.test(raw)) continue;
    if (raw.includes("@")) {
      append(raw, start, true);
      continue;
    }
    const protocol = /^[a-z][a-z0-9+.-]*:\/\//i.exec(raw)?.[0] ?? "";
    if (protocol === raw) continue;
    const compound = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+$/u.test(raw);
    const without = raw.slice(protocol.length),
      slash = without.indexOf("/");
    if (slash > 0) {
      append(without, start + protocol.length, true, true);
      append(without.slice(0, slash), start + protocol.length, true);
      append(without.slice(slash), start + protocol.length + slash, true);
    } else if (
      raw.includes(".") ||
      raw.startsWith("/") ||
      (/^[+-]?\d/.test(raw) && !compound)
    )
      append(without, start + protocol.length, true);
    else if (compound) {
      append(raw, start, /\d/u.test(raw), true);
      let offset = start;
      for (const part of raw.split("-")) {
        append(part, offset, /\d/u.test(part));
        offset += part.length + 1;
      }
    } else append(raw, start, /\d/u.test(raw));
  }
  return result;
}
export type SearchTerm = Lexeme[];
export function searchTerms(terms: string[]) {
  return terms.map((term) => lexemes(term)).filter((term) => term.length);
}
export function occurrences(words: Lexeme[], term: SearchTerm): Lexeme[][] {
  const first = term[0];
  if (!first) return [];
  // Multiple lexemes can share a stored position after PostgreSQL clamps it.
  const byPosition = new Map<number, Lexeme[]>();
  for (const word of words) {
    const group = byPosition.get(word.position);
    if (group) group.push(word);
    else byPosition.set(word.position, [word]);
  }
  const result: Lexeme[][] = [];
  for (const start of words) {
    if (!start.stem.startsWith(first.stem)) continue;
    const matches: Lexeme[] = [];
    for (const token of term) {
      const candidate = byPosition
        .get(start.position + token.position - first.position)
        ?.find((word) => word.stem.startsWith(token.stem));
      if (!candidate) break;
      matches.push(candidate);
    }
    if (matches.length === term.length) result.push(matches);
  }
  return result;
}
// to_tsvector stores MAXNUMPOS - 1 (255) positions per lexeme; concatenation
// can retain MAXNUMPOS (256). Both clamp positions to 16383.
// Keep raw parser positions for ts_headline, which reads the original document.
export function storedLexemes(words: Lexeme[], maxPositions = 255): Lexeme[] {
  const positions = new Map<string, Set<number>>();
  const result: Lexeme[] = [];
  for (const word of words) {
    const position = Math.min(16383, word.position);
    let seen = positions.get(word.stem);
    if (!seen) positions.set(word.stem, (seen = new Set()));
    if (seen.size >= maxPositions || seen.has(position)) continue;
    seen.add(position);
    result.push(position === word.position ? word : { ...word, position });
  }
  return result;
}
export function matchDocument(
  title: string,
  text: string,
  terms: SearchTerm[],
  excluded: SearchTerm[],
  includeSnippet = true,
) {
  const titleWords = storedLexemes(lexemes(title)),
    textWords = storedLexemes(lexemes(text));
  const titleEnd = titleWords.reduce((last, word) => Math.max(last, word.position), 0);
  const combined = storedLexemes(
    [
      ...titleWords,
      ...textWords.map((word) => ({ ...word, position: word.position + titleEnd })),
    ],
    256,
  );
  if (
    terms.some((term) => !occurrences(combined, term).length) ||
    excluded.some((term) => occurrences(combined, term).length)
  )
    return;
  const rank = rankDocument(titleWords, textWords, terms);
  return {
    rank,
    indexedText: textWords,
    snippet: includeSnippet ? documentSnippet(text, terms, textWords) : "",
  };
}
export function documentSnippet(
  text: string,
  terms: SearchTerm[],
  indexed = storedLexemes(lexemes(text)),
) {
  return terms.length && terms.every((term) => occurrences(indexed, term).length)
    ? headline(text, terms)
    : "";
}
