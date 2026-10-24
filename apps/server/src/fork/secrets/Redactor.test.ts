import { describe, expect, it } from "@effect/vitest";

import { REPEATED_NOTICE, makeRedactor, withheldNotice } from "./Redactor.ts";

const SECRET = "pR0d-db_Pa55w0rd!xK7#Lq2";
const bytes = (text: string) => new TextEncoder().encode(text);

const redact = (secrets: ReadonlyArray<{ label: string; value: string }>, output: Uint8Array) => {
  const redactor = makeRedactor(secrets);
  if (redactor === null) throw new Error("Redactor exceeded its budget");
  return redactor.redact(output);
};

describe("makeRedactor", () => {
  it("replaces the raw value and its common encodings", () => {
    const encodings = [
      SECRET,
      Buffer.from(SECRET).toString("base64"),
      Buffer.from(SECRET).toString("base64").replace(/=+$/, ""),
      Buffer.from(SECRET).toString("base64url"),
      Buffer.from(SECRET).toString("hex"),
      Buffer.from(SECRET).toString("hex").toUpperCase(),
      encodeURIComponent(SECRET),
      JSON.stringify(SECRET).slice(1, -1),
    ];
    for (const encoded of encodings) {
      const result = redact(
        [{ label: "PROD_DB", value: SECRET }],
        bytes(`before ${encoded} after`),
      );
      expect(result.text).toBe("before [redacted:PROD_DB] after");
      expect(result.redacted).toBe(true);
    }
  });

  it("finds a value inside a larger base64 blob at any offset", () => {
    for (const prefix of ["", "u", "us", "user:"]) {
      const header = Buffer.from(`${prefix}${SECRET}`).toString("base64");
      const result = redact(
        [{ label: "PROD_DB", value: SECRET }],
        bytes(`Authorization: Basic ${header}`),
      );
      expect(result.redacted).toBe(true);
      // Left over: the prefix's own groups plus at most a boundary group on each side.
      const remaining = result.text
        .replace("Authorization: Basic ", "")
        .replace(/\[redacted:PROD_DB\]/g, "");
      expect(remaining.length).toBeLessThanOrEqual(Math.ceil(prefix.length / 3) * 4 + 8);
    }
  });

  it("finds base64 wrapped the way base64 tools wrap it", () => {
    const value = `ghp_${"9fKx2LmQ8vNw4RtY7uZaBcDeFgHiJkL0".repeat(3)}`;
    // GNU base64 wraps at 76 columns, OpenSSL and PEM at 64.
    for (const width of [64, 76]) {
      for (const newline of ["\n", "\r\n"]) {
        for (const prefix of ["", "user:"]) {
          const encoded = Buffer.from(`${prefix}${value}`).toString("base64");
          const wrapped = `${encoded.match(new RegExp(`.{1,${width}}`, "g"))!.join(newline)}${newline}`;
          const result = redact([{ label: "TOKEN", value }], bytes(wrapped));
          expect(result.redacted).toBe(true);
          const remaining = result.text.replace(/\[redacted:TOKEN\]/g, "").replace(/\s/g, "");
          expect(remaining.length).toBeLessThanOrEqual(Math.ceil(prefix.length / 3) * 4 + 8);
        }
      }
    }
  });

  it("finds wrapped base64 that was escaped again", () => {
    const value = `ghp_${"9fKx2LmQ8vNw4RtY7uZaBcDeFgHiJkL0".repeat(3)}`;
    const wrapped = Buffer.from(value)
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n");
    expect(
      redact([{ label: "TOKEN", value }], bytes(JSON.stringify({ token: wrapped }))).text,
    ).toBe('{"token":"[redacted:TOKEN]"}');
    expect(
      redact([{ label: "TOKEN", value }], bytes(`token=${encodeURIComponent(wrapped)}`)).text,
    ).toBe("token=[redacted:TOKEN]");
  });

  it("decodes percent-encoding whichever characters a tool escaped", () => {
    const value = "p@ss w0rd!#~'()*/x9";
    const strict = encodeURIComponent(value).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const encodings = [
      new URLSearchParams({ token: value }).toString().slice("token=".length),
      encodeURIComponent(value),
      strict,
      strict.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
    ];
    for (const encoded of encodings) {
      expect(redact([{ label: "S", value }], bytes(`before ${encoded} after`)).text).toBe(
        "before [redacted:S] after",
      );
    }
  });

  it("decodes JSON escapes from any encoder", () => {
    const value = "a&b<c>d/é-9xQ2Lm";
    // Go escapes HTML characters, PHP escapes slashes, Python escapes non-ASCII.
    const encoded = String.raw`a&b<c>d\/é-9xQ2Lm`;
    expect(redact([{ label: "S", value }], bytes(`{"env":"${encoded}"}`)).text).toBe(
      '{"env":"[redacted:S]"}',
    );
  });

  it("escapes non-ASCII values the way JSON encoders do", () => {
    const value = "pässwörd-Ünïcödé-9xQ";
    const escaped = JSON.stringify(value).slice(1, -1);
    const asciiEscaped = Array.from(value, (char) =>
      char.charCodeAt(0) < 0x80 ? char : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ).join("");
    expect(redact([{ label: "S", value }], bytes(escaped)).text).toBe("[redacted:S]");
    expect(redact([{ label: "S", value }], bytes(asciiEscaped)).text).toBe("[redacted:S]");
  });

  it("matches across invalid UTF-8 around the value", () => {
    const output = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(SECRET),
      Buffer.from([0xc3]),
    ]);
    const result = redact([{ label: "PROD_DB", value: SECRET }], output);
    expect(result.text).toContain("[redacted:PROD_DB]");
    expect(result.text).not.toContain(SECRET);
  });

  it("prefers the longer of two overlapping values", () => {
    const short = "Zx8Cv7Bn6Mq5";
    const long = `${short}Wl4Ek3Rj2Th1`;
    const result = redact(
      [
        { label: "SHORT", value: short },
        { label: "LONG", value: long },
      ],
      bytes(`${long} and ${short}`),
    );
    expect(result.text).toBe("[redacted:LONG] and [redacted:SHORT]");
  });

  it("withholds the whole stream when a short or simple value appears", () => {
    const value = "aaaa1111";
    const result = redact([{ label: "PIN", value }], bytes(`log line\npin=${value}\nmore`));
    expect(result.text).toBe(withheldNotice("PIN"));
    expect(result.redacted).toBe(true);
    const harmless = redact([{ label: "PIN", value }], bytes("nothing to see"));
    expect(harmless).toEqual({ text: "nothing to see", redacted: false });
  });

  it("withholds output that repeats a value too often to redact one by one", () => {
    const value = "Zx8Cv7Bn";
    const output = bytes(`${value} `.repeat(100_001));
    expect(redact([{ label: "PIN_BLOCK", value }], output)).toEqual({
      text: REPEATED_NOTICE,
      redacted: true,
    });
  });

  it("leaves output without secrets untouched", () => {
    const result = redact([{ label: "PROD_DB", value: SECRET }], bytes("ünïcode ✓ output\n"));
    expect(result).toEqual({ text: "ünïcode ✓ output\n", redacted: false });
  });

  it("refuses values too large to match within its budget", () => {
    const huge = Array.from({ length: 20 }, (_, index) => ({
      label: `HUGE_${index}`,
      value: `${index}`.padEnd(1024 * 1024, "x9Q"),
    }));
    expect(makeRedactor(huge)).toBeNull();
  });
});
