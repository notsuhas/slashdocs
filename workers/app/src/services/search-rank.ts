import type { Lexeme, SearchTerm } from "./search-text";
// Port of PostgreSQL's unnormalized ts_rank, default title A/body D weights.
// PostgreSQL Global Development Group, PostgreSQL License.
const f = Math.fround;
export function rankDocument(title: Lexeme[], body: Lexeme[], terms: SearchTerm[]) {
  const last = title.at(-1)?.position ?? 0;
  const words = [
    ...title.map((word) => ({ ...word, weight: 1 })),
    ...body.map((word) => ({
      ...word,
      position: Math.min(16383, word.position + last),
      weight: f(0.1),
    })),
  ];
  const operands = [...new Set(terms.flat().map((word) => word.stem))].sort(compare);
  if (!operands.length) return 0;
  const groups = new Map<string, typeof words>();
  for (const word of words) {
    const group = groups.get(word.stem) ?? [];
    if (
      group.length < 256 &&
      !group.some((existing) => existing.position === word.position)
    )
      group.push(word);
    groups.set(word.stem, group);
  }
  const matching = (operand: string) =>
    [...groups.entries()]
      .filter(([stem]) => stem.startsWith(operand))
      .sort(([a], [b]) => compare(a, b))
      .map(([, group]) => group);
  if (operands.length === 1) {
    let rank = 0;
    for (const operand of operands)
      for (const group of matching(operand)) {
        let sum = 0,
          max = -1,
          maxIndex = 0;
        for (let j = 0; j < group.length; j++) {
          const weight = group[j].weight;
          sum = f(sum + f(weight / ((j + 1) * (j + 1))));
          if (weight > max) {
            max = weight;
            maxIndex = j;
          }
        }
        rank = f(
          rank +
            f(f(sum - f(max / ((maxIndex + 1) * (maxIndex + 1)))) + max) /
              1.64493406685,
        );
      }
    return f(rank / operands.length);
  }
  let rank = -1;
  const positions: (typeof words | undefined)[] = [];
  for (let i = 0; i < operands.length; i++)
    for (const group of matching(operands[i])) {
      positions[i] = group;
      for (let k = 0; k < i; k++)
        for (const word of group)
          for (const previous of positions[k] ?? []) {
            const distance = Math.abs(word.position - previous.position);
            if (!distance) continue;
            const proximity =
              distance > 100
                ? f(1e-30)
                : f(1 / (1.005 + 0.05 * Math.exp(distance / 1.5 - 2)));
            const weight = f(
              Math.sqrt(f(f(word.weight * previous.weight) * proximity)),
            );
            rank = rank < 0 ? weight : f(1 - (1 - rank) * (1 - weight));
          }
    }
  return rank < 0 ? f(1e-20) : rank;
}
function compare(a: string, b: string) {
  const encoder = new TextEncoder(),
    aa = encoder.encode(a),
    bb = encoder.encode(b);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++)
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
}
