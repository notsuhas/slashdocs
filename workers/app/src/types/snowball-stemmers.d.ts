declare module "snowball-stemmers" {
  export function newStemmer(language: "english"): { stem(word: string): string };
}
