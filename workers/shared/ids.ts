export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let accumulator = 0,
    bits = 0,
    encoded = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(accumulator >>> bits) & 31];
    }
  }
  return `${prefix}_${encoded}`;
}
