/**
 * Removes delivered secret values from command output before it reaches an
 * agent. MCP results return whole, so this works on complete per-stream
 * buffers instead of streaming chunks. Matching runs on a byte-exact latin1
 * view, so invalid UTF-8 around a value can't hide it.
 *
 * Values and their base64 and hex forms are looked for in the output and in
 * copies of it with percent escapes decoded, JSON escapes decoded, and wrapped
 * lines joined (in the output and in each decoded copy), so the choices an
 * encoder makes (which characters to escape, hex case, line width) don't
 * matter. Exact matching catches accidental reflection; it can't recognize a
 * value a command deliberately transforms.
 */

const MAX_PATTERN_BYTES = 16 * 1024 * 1024;
// Forge's thresholds: shorter or more repetitive values match ordinary output.
const MIN_SELECTIVE_BYTES = 8;
const MIN_SELECTIVE_DISTINCT_BYTES = 4;
const MIN_SELECTIVE_ENTROPY_BITS_PER_BYTE = 2.5;
// Aligned base64 below this many characters matches unrelated encoded text.
const MIN_ALIGNED_BASE64_CHARS = 8;
// Output that repeats values more often than this is withheld instead of redacted, so a
// degenerate stream can't tie up the server.
const MAX_MATCHES = 100_000;

export interface RedactionSecret {
  readonly label: string;
  readonly value: string;
}

export interface RedactedText {
  readonly text: string;
  readonly redacted: boolean;
}

export interface Redactor {
  readonly redact: (bytes: Uint8Array) => RedactedText;
}

interface Pattern {
  readonly latin1: string;
  readonly marker: string;
  readonly selective: boolean;
}

/** The output, or a transformed copy of it that maps each of its bytes back to output offsets. */
interface View {
  readonly text: string;
  readonly start: (index: number) => number;
  readonly end: (index: number) => number;
}

interface Match {
  readonly start: number;
  readonly end: number;
  readonly marker: string;
}

const entropyBitsPerByte = (bytes: Uint8Array): number => {
  const counts = new Uint32Array(256);
  for (const byte of bytes) counts[byte] = (counts[byte] ?? 0) + 1;
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const probability = count / bytes.byteLength;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
};

const isSelectivelyMatchable = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= MIN_SELECTIVE_BYTES &&
  new Set(bytes).size >= MIN_SELECTIVE_DISTINCT_BYTES &&
  entropyBitsPerByte(bytes) >= MIN_SELECTIVE_ENTROPY_BITS_PER_BYTE;

/**
 * The raw value plus the encodings no view below decodes. Base64 of a value
 * embedded in a larger blob depends on its offset, so the aligned part for
 * each of the three offsets is registered as well.
 */
const encodedVariants = (raw: Buffer): ReadonlyArray<Buffer> => {
  const variants = new Map<string, Buffer>();
  const add = (variant: Buffer) => {
    if (variant.byteLength > 0 && !variant.equals(raw)) {
      variants.set(variant.toString("latin1"), variant);
    }
  };
  const ascii = (text: string) => add(Buffer.from(text, "latin1"));
  const base64 = raw.toString("base64");
  const base64Url = raw.toString("base64url");
  ascii(base64);
  ascii(base64.replace(/=+$/, ""));
  ascii(base64Url);
  ascii(base64Url.padEnd(Math.ceil(base64Url.length / 4) * 4, "="));
  for (const shift of [0, 1, 2]) {
    const tail = raw.subarray(shift);
    const aligned = tail.subarray(0, tail.byteLength - (tail.byteLength % 3));
    const alignedBase64 = aligned.toString("base64");
    if (alignedBase64.length < MIN_ALIGNED_BASE64_CHARS) continue;
    ascii(alignedBase64);
    ascii(aligned.toString("base64url"));
  }
  const hex = raw.toString("hex");
  ascii(hex);
  ascii(hex.toUpperCase());
  // Form encoding writes a space as "+", which percent decoding leaves alone.
  if (raw.includes(0x20)) add(Buffer.from(raw.map((byte) => (byte === 0x20 ? 0x2b : byte))));
  return [...variants.values()];
};

const outputView = (text: string): View => ({
  text,
  start: (index) => index,
  end: (index) => index + 1,
});

/** Builds a view of `source`; each pushed byte stands for source bytes `first` through `last`. */
const viewBuilder = (source: View) => {
  const capacity = source.text.length;
  const bytes = new Uint8Array(capacity);
  const from = new Uint32Array(capacity);
  const to = new Uint32Array(capacity);
  let length = 0;
  return {
    push: (byte: number, first: number, last: number) => {
      bytes[length] = byte;
      from[length] = source.start(first);
      to[length] = source.end(last);
      length += 1;
    },
    done: (): View => ({
      text: Buffer.from(bytes.buffer, 0, length).toString("latin1"),
      start: (index) => from[index]!,
      end: (index) => to[index]!,
    }),
  };
};

const isBase64Character = (code: number) =>
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x2b ||
  code === 0x2f ||
  code === 0x3d ||
  code === 0x2d ||
  code === 0x5f;

/** The index past a line break and the indentation after it, or -1 when none starts at `index`. */
const lineBreakEnd = (text: string, index: number): number => {
  let end = index;
  if (text.charCodeAt(end) === 0x0d) end += 1;
  if (text.charCodeAt(end) !== 0x0a) return -1;
  end += 1;
  while (text.charCodeAt(end) === 0x20 || text.charCodeAt(end) === 0x09) end += 1;
  return end;
};

/** GNU base64 wraps at 76 columns, PEM and OpenSSL at 64, some tools with CRLF or indentation. */
const joinWrappedLines = (source: View): View | null => {
  const { text } = source;
  const view = viewBuilder(source);
  let joined = false;
  for (let index = 0; index < text.length; index += 1) {
    const end = lineBreakEnd(text, index);
    if (
      end !== -1 &&
      index > 0 &&
      end < text.length &&
      isBase64Character(text.charCodeAt(index - 1)) &&
      isBase64Character(text.charCodeAt(end))
    ) {
      joined = true;
      index = end - 1;
      continue;
    }
    view.push(text.charCodeAt(index), index, index);
  }
  return joined ? view.done() : null;
};

const hexDigit = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
};

const decodePercentEscapes = (source: View): View | null => {
  const { text } = source;
  if (!text.includes("%")) return null;
  const view = viewBuilder(source);
  let decoded = false;
  for (let index = 0; index < text.length; index += 1) {
    const high = text.charCodeAt(index) === 0x25 ? hexDigit(text.charCodeAt(index + 1)) : -1;
    const low = high === -1 ? -1 : hexDigit(text.charCodeAt(index + 2));
    if (low !== -1) {
      view.push(high * 16 + low, index, index + 2);
      decoded = true;
      index += 2;
      continue;
    }
    view.push(text.charCodeAt(index), index, index);
  }
  return decoded ? view.done() : null;
};

const JSON_SHORT_ESCAPES: ReadonlyMap<string, number> = new Map([
  ['"', 0x22],
  ["\\", 0x5c],
  ["/", 0x2f],
  ["b", 0x08],
  ["f", 0x0c],
  ["n", 0x0a],
  ["r", 0x0d],
  ["t", 0x09],
]);

const hexCodeUnit = (text: string, index: number): number => {
  let value = 0;
  for (let offset = 0; offset < 4; offset += 1) {
    const digit = hexDigit(text.charCodeAt(index + offset));
    if (digit === -1) return -1;
    value = value * 16 + digit;
  }
  return value;
};

/** Decodes `\uXXXX` escapes to UTF-8, which is how the raw value appears in the latin1 view. */
const decodeJsonEscapes = (source: View): View | null => {
  const { text } = source;
  if (!text.includes("\\")) return null;
  const view = viewBuilder(source);
  let decoded = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x5c) {
      const short = JSON_SHORT_ESCAPES.get(text.charAt(index + 1));
      if (short !== undefined) {
        view.push(short, index, index + 1);
        decoded = true;
        index += 1;
        continue;
      }
      let codePoint = text.charAt(index + 1) === "u" ? hexCodeUnit(text, index + 2) : -1;
      if (codePoint !== -1) {
        let end = index + 6;
        const low = text.startsWith("\\u", end) ? hexCodeUnit(text, end + 2) : -1;
        if (codePoint >= 0xd800 && codePoint <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
          codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
          end += 6;
        }
        for (const byte of Buffer.from(String.fromCodePoint(codePoint), "utf8")) {
          view.push(byte, index, end - 1);
        }
        decoded = true;
        index = end - 1;
        continue;
      }
    }
    view.push(text.charCodeAt(index), index, index);
  }
  return decoded ? view.done() : null;
};

/** False when the output holds more matches than are worth replacing one by one. */
const collectMatches = (
  view: View,
  patterns: ReadonlyArray<Pattern>,
  matches: Array<Match>,
): boolean => {
  for (const pattern of patterns) {
    // Two copies of a value overlap only if it repeats itself, so a search resumes past a match.
    for (
      let at = view.text.indexOf(pattern.latin1);
      at !== -1;
      at = view.text.indexOf(pattern.latin1, at + pattern.latin1.length)
    ) {
      matches.push({
        start: view.start(at),
        end: view.end(at + pattern.latin1.length - 1),
        marker: pattern.marker,
      });
      if (matches.length > MAX_MATCHES) return false;
    }
  }
  return true;
};

/** Replaces matched output ranges, merging overlaps so no part of a longer match shows. */
const replaceMatches = (output: string, matches: Array<Match>): string => {
  matches.sort((left, right) => left.start - right.start || right.end - left.end);
  const pieces: Array<string> = [];
  let cursor = 0;
  let current: { start: number; end: number; marker: string } | null = null;
  for (const match of matches) {
    if (current !== null && match.start < current.end) {
      current.end = Math.max(current.end, match.end);
      continue;
    }
    if (current !== null) {
      pieces.push(output.slice(cursor, current.start), current.marker);
      cursor = current.end;
    }
    current = { ...match };
  }
  if (current !== null) {
    pieces.push(output.slice(cursor, current.start), current.marker);
    cursor = current.end;
  }
  pieces.push(output.slice(cursor));
  return pieces.join("");
};

export const withheldNotice = (label: string) =>
  `[output withheld: it contained the value of ${label}, which is too short or simple to redact safely]`;

export const REPEATED_NOTICE = "[output withheld: it repeated secret values too often to redact]";

/** Null when the values would need more than the matching budget. */
export const makeRedactor = (secrets: ReadonlyArray<RedactionSecret>): Redactor | null => {
  const patterns: Array<Pattern> = [];
  const seen = new Set<string>();
  let patternBytes = 0;
  for (const secret of secrets) {
    const raw = Buffer.from(secret.value, "utf8");
    if (raw.byteLength === 0) continue;
    const selective = isSelectivelyMatchable(raw);
    const marker = selective ? `[redacted:${secret.label}]` : withheldNotice(secret.label);
    for (const variant of [raw, ...encodedVariants(raw)]) {
      const latin1 = variant.toString("latin1");
      if (seen.has(latin1)) continue;
      seen.add(latin1);
      patternBytes += variant.byteLength;
      if (patternBytes > MAX_PATTERN_BYTES) return null;
      patterns.push({ latin1, marker, selective });
    }
  }
  const lowEntropy = patterns.filter((pattern) => !pattern.selective);
  const selective = patterns.filter((pattern) => pattern.selective);

  return {
    redact: (bytes) => {
      const output = Buffer.from(bytes).toString("latin1");
      const original = outputView(output);
      const decoded = [decodePercentEscapes(original), decodeJsonEscapes(original)].filter(
        (view) => view !== null,
      );
      // Wrapped base64 also arrives escaped inside JSON strings and form bodies.
      const joined = [original, ...decoded].map(joinWrappedLines).filter((view) => view !== null);
      const views = [original, ...decoded, ...joined];
      // Replacing a short value in place would show where it occurs and how long it is.
      const withheld = lowEntropy.find((pattern) =>
        views.some((view) => view.text.includes(pattern.latin1)),
      );
      if (withheld) return { text: withheld.marker, redacted: true };
      const matches: Array<Match> = [];
      for (const view of views) {
        if (!collectMatches(view, selective, matches)) {
          return { text: REPEATED_NOTICE, redacted: true };
        }
      }
      const text = matches.length === 0 ? output : replaceMatches(output, matches);
      return { text: Buffer.from(text, "latin1").toString("utf8"), redacted: matches.length > 0 };
    },
  };
};
