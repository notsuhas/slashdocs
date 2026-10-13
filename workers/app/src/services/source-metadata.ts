import {
  parse,
  Tokenizer,
  TokenizerMode,
  type DefaultTreeAdapterTypes,
  type Token,
} from "parse5";
import type { Env } from "../env";

export type Heading = { id: string; text: string; level: number };
const hiddenElements = new Set(["script", "style", "template", "noscript"]);
const encoder = new TextEncoder();
const maxSearchTextBytes = 256 << 10;

// Tokenize rather than walk the repaired DOM: Go indexes source text in source order.
export function searchText(bytes: Uint8Array): string {
  let markerCode = 0xe000;
  const decoded = new TextDecoder().decode(bytes);
  while (decoded.includes(String.fromCodePoint(markerCode))) markerCode++;
  const badByteMarker = String.fromCodePoint(markerCode);
  let hidden = 0,
    pending = "",
    text = "",
    size = 0;
  function flush() {
    if (hidden === 0 && size < maxSearchTextBytes) {
      const words = pending.split(/[\p{White_Space}\p{Cc}]+/u).filter(Boolean);
      for (const word of words) {
        const part = (text ? " " : "") + word;
        text += part;
        size += encoder.encode(part).length;
      }
    }
    pending = "";
  }
  function characters(token: Token.CharacterToken) {
    pending += token.chars;
  }
  const tokenizer = new Tokenizer(
    {},
    {
      onCharacter: characters,
      onWhitespaceCharacter: characters,
      onNullCharacter: characters,
      onComment: flush,
      onDoctype: flush,
      onEof: flush,
      onStartTag(token) {
        flush();
        if (!token.selfClosing && hiddenElements.has(token.tagName)) hidden++;
        if (token.tagName === "script") tokenizer.state = TokenizerMode.SCRIPT_DATA;
        else if (
          ["style", "xmp", "iframe", "noembed", "noframes", "noscript"].includes(
            token.tagName,
          )
        )
          tokenizer.state = TokenizerMode.RAWTEXT;
        else if (["title", "textarea"].includes(token.tagName))
          tokenizer.state = TokenizerMode.RCDATA;
        else if (token.tagName === "plaintext")
          tokenizer.state = TokenizerMode.PLAINTEXT;
      },
      onEndTag(token) {
        flush();
        if (hiddenElements.has(token.tagName) && hidden > 0) hidden--;
      },
    },
  );
  // Go removes invalid UTF-8, including an incomplete rune at the byte limit.
  tokenizer.write(decodeGoUTF8(bytes, badByteMarker), true);
  const raw: number[] = [];
  for (const point of text) {
    if (point === badByteMarker) raw.push(255);
    else raw.push(...encoder.encode(point));
    if (raw.length >= maxSearchTextBytes) break;
  }
  return decodeGoUTF8(
    new Uint8Array(raw.slice(0, maxSearchTextBytes)),
    badByteMarker,
  ).replaceAll(badByteMarker, "");
}

// x/net/html retains malformed UTF-8 in text tokens until ToValidUTF8 runs.
// A source-absent code point represents each bad byte until the final byte limit.
function decodeGoUTF8(bytes: Uint8Array, badByteMarker: string): string {
  const decoded = new TextDecoder().decode(bytes);
  if (!decoded.includes("\ufffd")) return decoded;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length;) {
    const a = bytes[i],
      b = bytes[i + 1],
      c = bytes[i + 2],
      d = bytes[i + 3];
    const cont = (value: number | undefined) =>
      value !== undefined && value >= 128 && value <= 191;
    const length =
      a < 128
        ? 1
        : a >= 194 && a <= 223 && cont(b)
          ? 2
          : a >= 224 &&
              a <= 239 &&
              cont(b) &&
              cont(c) &&
              (a !== 224 || b >= 160) &&
              (a !== 237 || b < 160)
            ? 3
            : a >= 240 &&
                a <= 244 &&
                cont(b) &&
                cont(c) &&
                cont(d) &&
                (a !== 240 || b >= 144) &&
                (a !== 244 || b < 144)
              ? 4
              : 0;
    if (!length) {
      parts.push(badByteMarker);
      i++;
    } else {
      parts.push(new TextDecoder().decode(bytes.slice(i, i + length)));
      i += length;
    }
  }
  return parts.join("");
}

export function extractHeadings(bytes: Uint8Array): Heading[] {
  const root = parse(new TextDecoder().decode(bytes));
  const used = new Set<string>();
  const nodes: DefaultTreeAdapterTypes.Element[] = [];
  function walk(node: DefaultTreeAdapterTypes.Node) {
    if ("tagName" in node) {
      const id = node.attrs.find((attribute) => attribute.name === "id")?.value;
      if (id) used.add(id);
      if (/^h[1-6]$/.test(node.tagName)) nodes.push(node);
      if (node.tagName === "template") return;
    }
    if ("childNodes" in node) for (const child of node.childNodes) walk(child);
  }
  function content(node: DefaultTreeAdapterTypes.Node): string {
    if (node.nodeName === "#text" && "value" in node) return node.value;
    return "childNodes" in node ? node.childNodes.map(content).join("") : "";
  }
  walk(root);
  return nodes.map((node) => {
    const text = content(node).trim();
    let id = node.attrs.find((attribute) => attribute.name === "id")?.value ?? "";
    if (!id) {
      const base =
        text
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "section";
      id = base;
      for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
      used.add(id);
    }
    return { id, text, level: Number(node.tagName[1]) };
  });
}

// Append after the version INSERT in the publication batch. A losing CAS must
// roll this statement back with its version, so no separate post-write index exists.
export function sourceMetadataStatements(
  env: Env,
  versionId: string,
  bytes: Uint8Array,
): D1PreparedStatement[] {
  return [
    env.DB.prepare("UPDATE versions SET search_text=?,headings_json=? WHERE id=?").bind(
      searchText(bytes),
      JSON.stringify(extractHeadings(bytes)),
      versionId,
    ),
  ];
}

export async function indexCurrentVersionBatch(env: Env, after = "") {
  const { results } = await env.DB.prepare(
    "SELECT v.id,v.object_key FROM versions v JOIN documents d ON d.current_version_id=v.id WHERE v.search_text IS NULL AND d.deleted_at IS NULL AND v.id>? ORDER BY v.id LIMIT 20",
  )
    .bind(after)
    .all<{ id: string; object_key: string }>();
  let indexed = 0;
  const failed: string[] = [];
  for (const version of results) {
    try {
      const object = await env.DOCUMENTS.get(version.object_key);
      const bytes = object
        ? new Uint8Array(await object.arrayBuffer())
        : new Uint8Array();
      await env.DB.batch(sourceMetadataStatements(env, version.id, bytes));
      indexed++;
    } catch {
      failed.push(version.id);
    }
  }
  return {
    indexed,
    failed,
    nextCursor: results.length === 20 ? results[results.length - 1].id : undefined,
  };
}
export async function indexCurrentVersions(env: Env): Promise<number> {
  let after = "",
    indexed = 0;
  for (;;) {
    const batch = await indexCurrentVersionBatch(env, after);
    indexed += batch.indexed;
    if (!batch.nextCursor) return indexed;
    after = batch.nextCursor;
  }
}
