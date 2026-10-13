import { lexemes, occurrences, type SearchTerm } from "./search-text";
// PostgreSQL MaxFragments=1 fragment selection with MaxWords=24/MinWords=12.
// PostgreSQL Global Development Group, PostgreSQL License.
export function headline(text: string, terms: SearchTerm[]): string {
  const queryWords = terms.flat().map((word) => word.stem);
  const words: {
    text: string;
    word: boolean;
    selected: boolean;
    position: number;
    noEnd?: boolean;
  }[] = [];
  let cursor = 0;
  function gap(value: string) {
    const text = value.replace(/<[^>]*>/g, " ");
    let cursor = 0;
    for (const protocol of text.matchAll(/[a-z][a-z0-9+.-]*:\/\//gi)) {
      if (protocol.index > cursor)
        words.push({
          text: text.slice(cursor, protocol.index),
          word: false,
          selected: false,
          position: 0,
        });
      words.push({
        text: protocol[0],
        word: true,
        selected: false,
        position: 0,
        noEnd: true,
      });
      cursor = protocol.index + protocol[0].length;
    }
    if (cursor < text.length)
      words.push({
        text: text.slice(cursor),
        word: false,
        selected: false,
        position: 0,
      });
  }
  const raw = lexemes(text, true);
  for (const lexeme of raw) {
    if (lexeme.hidden) continue;
    gap(text.slice(cursor, lexeme.start));
    words.push({
      text: text.slice(lexeme.start, lexeme.end),
      word: true,
      selected:
        !!lexeme.stem && queryWords.some((stem) => lexeme.stem.startsWith(stem)),
      position: lexeme.position,
    });
    cursor = lexeme.end;
  }
  gap(text.slice(cursor));
  const indexed = raw.filter((word) => word.stem);
  const locations = terms.map((term) => occurrences(indexed, term));
  // Each occurrence and document cursor only advances. Repeated common words
  // must not rescan/copy the whole document for every candidate cover.
  const endCursors = locations.map(() => 0);
  const beginCursors = locations.map(() => -1);
  let fromCursor = 0,
    toCursor = -1;
  let cover: { from: number; to: number; count: number; items: number } | undefined;
  let next = 0;
  for (;;) {
    let end = 0,
      exhausted = false;
    for (let i = 0; i < locations.length; i++) {
      const matches = locations[i];
      while (
        endCursors[i] < matches.length &&
        (matches[endCursors[i]].at(-1)?.position ?? 0) < next
      )
        endCursors[i]++;
      const position = matches[endCursors[i]]?.at(-1)?.position;
      if (position === undefined) {
        exhausted = true;
        break;
      }
      end = Math.max(end, position);
    }
    if (exhausted || !locations.length) break;
    let begin = Infinity;
    for (let i = 0; i < locations.length; i++) {
      const matches = locations[i];
      while (
        beginCursors[i] + 1 < matches.length &&
        matches[beginCursors[i] + 1][0].position <= end
      )
        beginCursors[i]++;
      begin = Math.min(begin, matches[beginCursors[i]]?.[0].position ?? -1);
    }
    begin = Math.max(next, begin);
    while (
      fromCursor < words.length &&
      (!words[fromCursor].selected || words[fromCursor].position < begin)
    )
      fromCursor++;
    while (toCursor + 1 < words.length && words[toCursor + 1].position <= end)
      toCursor++;
    let to = toCursor;
    while (to >= fromCursor && !words[to].selected) to--;
    const from = fromCursor;
    if (from >= words.length || to < from) break;
    let cursor = from;
    while (cursor <= to) {
      while (cursor <= to && !words[cursor].selected) cursor++;
      let cut = cursor,
        count = 0;
      for (; cut <= to && count < 24; cut++) if (words[cut].word) count++;
      let last = to;
      if (to > cut) {
        last = cut;
        while (last >= cursor && !words[last].selected) {
          if (words[last].word) count--;
          last--;
        }
      }
      let items = 0;
      for (let i = cursor; i <= last; i++) if (words[i].selected) items++;
      if (
        !cover ||
        items > cover.items ||
        (items === cover.items && count < cover.count)
      )
        cover = { from: cursor, to: last, count, items };
      cursor = last + 1;
    }
    next = begin + 1;
  }
  if (!cover) return "";
  let { from, to, count } = cover;
  const bad = (i: number) =>
    !words[i].selected &&
    (words[i].noEnd ||
      !words[i].word ||
      new TextEncoder().encode(words[i].text).length <= 3 ||
      /^[+-]?\d/.test(words[i].text));
  if (count < 24) {
    const max = Math.floor((24 - count) / 2);
    let stretch = 0,
      mark = from;
    for (let i = from - 1; i >= 0 && stretch < max; i--) {
      if (words[i].word) {
        count++;
        stretch++;
      }
      mark = i;
    }
    while (mark < from && bad(mark)) {
      if (words[mark].word) count--;
      mark++;
    }
    from = mark;
    mark = to;
    for (let i = to + 1; i < words.length && count < 24; i++) {
      if (words[i].word) count++;
      mark = i;
    }
    while (mark > to && bad(mark)) {
      if (words[mark].word) count--;
      mark--;
    }
    to = mark;
  }
  return words
    .slice(from, to + 1)
    .map((word) => (word.selected ? "\u0002" + word.text + "\u0003" : word.text))
    .join("");
}
